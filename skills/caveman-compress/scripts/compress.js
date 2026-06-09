#!/usr/bin/env node
'use strict';
/**
 * compress.js — Caveman Compress orchestrator (Node port)
 *
 * Usage: node compress.js <absolute_filepath>
 *
 * Ported from Python: compress.py + cli.py
 * Pure Node stdlib — no external dependencies.
 *
 * Flow:
 *   1. Resolve path; refuse if missing, >500_000 bytes, or empty/whitespace-only
 *   2. Sensitive-path denylist gate (before reading file contents)
 *   3. File-type gate (natural-language files only)
 *   4. Backup to <stem>.original.md; refuse if backup exists; verify readback
 *   5. Rewrite via headless `claude --print` session (spawnSync, no shell)
 *   6. Strip outer markdown fence if LLM wraps output
 *   7. Abort if empty output or output == input
 *   8. Validate; fix-retry up to 2×; restore on final failure
 *   9. Print concise summary to stdout
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { isSensitivePath, shouldCompress } = require('./detect');
const { validate } = require('./validate');

const MAX_FILE_SIZE = 500_000; // 500KB
const MAX_RETRIES = 2;

// ---------------------------------------------------------------------------
// claude binary — overridable for testing
// ---------------------------------------------------------------------------

// Use CAVEMAN_CLAUDE_BIN to substitute a fake binary in tests.
// This is the ONLY place child_process is used in the entire plugin.
const CLAUDE_BIN = process.env.CAVEMAN_CLAUDE_BIN || 'claude';

// ---------------------------------------------------------------------------
// Prompt builders (ported from compress.py)
// ---------------------------------------------------------------------------

function buildCompressPrompt(original) {
  return `
Compress this markdown into caveman format.

STRICT RULES:
- Do NOT modify anything inside \`\`\` code blocks
- Do NOT modify anything inside inline backticks
- Preserve ALL URLs exactly
- Preserve ALL headings exactly
- Preserve file paths and commands
- Return ONLY the compressed markdown body — do NOT wrap the entire output in a \`\`\`markdown fence or any other fence. Inner code blocks from the original stay as-is; do not add a new outer fence around the whole file.

Only compress natural language.

TEXT:
${original}
`;
}

function buildFixPrompt(original, compressed, errors) {
  const errorsStr = errors.map(e => `- ${e}`).join('\n');
  return `You are fixing a caveman-compressed markdown file. Specific validation errors were found.

CRITICAL RULES:
- DO NOT recompress or rephrase the file
- ONLY fix the listed errors — leave everything else exactly as-is
- The ORIGINAL is provided as reference only (to restore missing content)
- Preserve caveman style in all untouched sections

ERRORS TO FIX:
${errorsStr}

HOW TO FIX:
- Missing URL: find it in ORIGINAL, restore it exactly where it belongs in COMPRESSED
- Code block mismatch: find the exact code block in ORIGINAL, restore it in COMPRESSED
- Heading mismatch: restore the exact heading text from ORIGINAL into COMPRESSED
- Do not touch any section not mentioned in the errors

ORIGINAL (reference only):
${original}

COMPRESSED (fix this):
${compressed}

Return ONLY the fixed compressed file. No explanation.
`;
}

// ---------------------------------------------------------------------------
// LLM call via headless claude --print (spawnSync)
// ---------------------------------------------------------------------------

/**
 * Invoke a headless `claude --print` session to process a prompt.
 *
 * Spawn design:
 *   - Prompt fed on stdin (not argv) — prevents prompt content from ever
 *     influencing the argv array.
 *   - shell: false on POSIX (no shell injection possible).
 *   - shell: true on Windows only, because Windows .cmd files (the typical
 *     `claude` install form on Windows) cannot be executed by spawnSync
 *     with shell:false — cmd.exe must invoke them. The prompt is still
 *     passed via stdin, not as a shell-interpolated argument, so no
 *     shell-injection risk from file content.
 *   - CAVEMAN_DEFAULT_MODE: 'off' in the child env — our SessionStart hook
 *     reads this and exits early when mode === 'off', so the child session
 *     will not load caveman rules or inject per-turn reinforcement.
 *     This prevents the child from caveman-ifying its own rewrite output.
 *   - No infinite re-trigger: the child receives the compress PROMPT on stdin,
 *     not a /caveman-compress slash command, so the UserPromptSubmit hook
 *     never fires for this subprocess.
 *   - claude --print runs non-interactively (headless); it uses the same
 *     desktop auth/OAuth that the interactive session uses. No API key needed.
 *   - We do NOT use --no-tools or similar flags because we want the model to
 *     have its normal reasoning ability; we just want it not to apply caveman
 *     style rules. Setting CAVEMAN_DEFAULT_MODE=off is the right-level fix.
 *
 * @param {string} prompt
 * @returns {string} stdout text (already stripped of outer markdown fence)
 */
function callClaude(prompt) {
  // On Windows, .cmd files (the typical `claude` install form) cannot be
  // exec'd directly without the shell — we must use shell:true. The prompt
  // is passed via stdin, not argv, so no shell-injection is possible.
  const useShell = process.platform === 'win32';

  const result = spawnSync(
    CLAUDE_BIN,
    ['--print'],
    {
      input: prompt,
      encoding: 'utf8',
      shell: useShell,
      timeout: 120_000, // 2 min max for LLM call
      env: {
        ...process.env,
        // Prevent the child session from applying caveman rules to its output.
        // Our SessionStart hook checks CAVEMAN_DEFAULT_MODE and exits early on 'off'.
        CAVEMAN_DEFAULT_MODE: 'off',
      },
    }
  );

  if (result.error) {
    throw new Error(`claude spawn error: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`claude exited with status ${result.status}: ${result.stderr || '(no stderr)'}`);
  }

  return stripLlmWrapper(result.stdout.trim());
}

// ---------------------------------------------------------------------------
// Output processing
// ---------------------------------------------------------------------------

/**
 * Strip outer ```markdown ... ``` fence when it wraps the entire output.
 * Ported from compress.py strip_llm_wrapper().
 *
 * @param {string} text
 * @returns {string}
 */
function stripLlmWrapper(text) {
  const m = /^\s*(`{3,}|~{3,})[^\n]*\n([\s\S]*)\n\1\s*$/.exec(text);
  if (m) return m[2];
  return text;
}

// ---------------------------------------------------------------------------
// Core orchestrator
// ---------------------------------------------------------------------------

/**
 * Compress a file in-place using a headless claude --print session.
 *
 * @param {string} filePath  Absolute path to the file.
 * @returns {{ success: boolean, originalBytes: number, compressedBytes: number, backupPath: string }}
 * @throws {Error} on any unrecoverable failure (file not found, sensitive, too large, etc.)
 */
function compressFile(filePath) {
  const resolved = path.resolve(filePath);

  // --- Pre-checks ---

  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (e) {
    throw new Error(`File not found: ${resolved}`);
  }
  if (!stat.isFile()) throw new Error(`Not a file: ${resolved}`);

  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(`File too large to compress safely (max 500KB): ${resolved}`);
  }

  // Sensitive-path check BEFORE reading file contents
  if (isSensitivePath(resolved)) {
    throw new Error(
      `Refusing to compress ${resolved}: filename looks sensitive ` +
      '(credentials, keys, secrets, or known private paths). ' +
      'Compression sends file contents to the Anthropic API. ' +
      'Rename the file if this is a false positive.'
    );
  }

  if (!shouldCompress(resolved)) {
    return { skipped: true, reason: 'not natural language (code/config)' };
  }

  const originalText = fs.readFileSync(resolved, 'utf8');

  if (!originalText.trim()) {
    throw new Error('Refusing to compress: file is empty or whitespace-only.');
  }

  const stem = path.basename(resolved, path.extname(resolved));
  const dir = path.dirname(resolved);
  const backupPath = path.join(dir, stem + '.original.md');

  // Refuse if backup already exists
  try {
    fs.statSync(backupPath);
    throw new Error(
      `Backup file already exists: ${backupPath}\n` +
      'The original backup may contain important content.\n' +
      'Aborting to prevent data loss. Please remove or rename the backup file if you want to proceed.'
    );
  } catch (e) {
    if (e.code !== 'ENOENT') throw e; // re-throw if not "not found"
  }

  // --- Compress ---

  let compressed = callClaude(buildCompressPrompt(originalText));

  if (!compressed || !compressed.trim()) {
    throw new Error(
      'Compression aborted: Claude returned an empty response.\n' +
      'Original file is untouched (no backup created).'
    );
  }

  if (compressed.trim() === originalText.trim()) {
    throw new Error(
      'Compression aborted: output is identical to input.\n' +
      'Original file is untouched (no backup created).'
    );
  }

  // --- Write backup and verify readback BEFORE touching primary ---
  fs.writeFileSync(backupPath, originalText, 'utf8');
  const backupReadback = fs.readFileSync(backupPath, 'utf8');
  if (backupReadback !== originalText) {
    try { fs.unlinkSync(backupPath); } catch (e) {}
    throw new Error(
      `Backup write verification failed: ${backupPath}\n` +
      'In-memory original differs from on-disk backup. Aborting before touching the input file.'
    );
  }

  // Write compressed to primary
  fs.writeFileSync(resolved, compressed, 'utf8');

  // --- Validate + Retry ---

  let lastErrors = [];
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const result = validate(backupPath, resolved);

    if (result.isValid) {
      // Success
      const compressedBytes = Buffer.byteLength(compressed, 'utf8');
      const originalBytes = Buffer.byteLength(originalText, 'utf8');
      return { success: true, originalBytes, compressedBytes, backupPath };
    }

    lastErrors = result.errors;

    if (attempt === MAX_RETRIES - 1) {
      // All retries exhausted — restore original
      fs.writeFileSync(resolved, originalText, 'utf8');
      try { fs.unlinkSync(backupPath); } catch (e) {}
      throw new Error(
        `Compression failed after ${MAX_RETRIES} retries. Original restored.\n` +
        `Validation errors:\n${lastErrors.map(e => '  - ' + e).join('\n')}`
      );
    }

    // Try targeted fix
    compressed = callClaude(buildFixPrompt(originalText, compressed, result.errors));
    fs.writeFileSync(resolved, compressed, 'utf8');
  }

  // Should never reach here, but satisfy linter
  return { success: false };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    process.stdout.write('Usage: node compress.js <filepath>\n');
    process.exit(1);
  }

  const filePath = args[0];

  try {
    const r = compressFile(filePath);

    if (r.skipped) {
      process.stdout.write(`Skipping ${path.basename(filePath)}: ${r.reason}\n`);
      process.exit(0);
    }

    const savedBytes = r.originalBytes - r.compressedBytes;
    const savedPct = ((savedBytes / r.originalBytes) * 100).toFixed(1);
    process.stdout.write(
      `Compressed ${path.basename(filePath)}: ${r.originalBytes} → ${r.compressedBytes} bytes (-${savedPct}%). ` +
      `Backup: ${path.basename(r.backupPath)}\n`
    );
    process.exit(0);
  } catch (e) {
    process.stdout.write(`Error: ${e.message}\n`);
    process.exit(1);
  }
}

module.exports = { compressFile };
