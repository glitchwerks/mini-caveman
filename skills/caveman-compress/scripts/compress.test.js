'use strict';
// Tests for compress.js orchestrator
// Run: node --test compress.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const {
  mkdtempSync, writeFileSync, readFileSync, existsSync,
  rmSync, mkdirSync
} = require('node:fs');

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'caveman-compress-test-'));
process.on('exit', () => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
});

let fileIdx = 0;
function tmpFile(name, content) {
  const p = path.join(tmpDir, name || `file${++fileIdx}.md`);
  writeFileSync(p, content !== undefined ? content : '# Title\n\nThis is some natural language text that should be compressed by the caveman system.\n');
  return p;
}

// Build a tiny fake claude binary that echoes deterministic compressed output.
// It reads stdin (the prompt) and writes a fixed compressed body to stdout.
const fakeBinDir = mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'));
const fakeBin = path.join(fakeBinDir, 'claude');
// The fake script returns a simple compressed form (shorter than input)
writeFileSync(fakeBin,
  '#!/usr/bin/env node\n' +
  'let i = ""; process.stdin.on("data", c => i += c); process.stdin.on("end", () => {\n' +
  '  // Fake compression: return deterministic compressed output\n' +
  '  // Must differ from input to pass the "output == input" guard\n' +
  '  process.stdout.write("# Title\\n\\nText compressed by fake claude.\\n");\n' +
  '});\n',
  { mode: 0o755 }
);

// Also create a Windows-compatible fake.js for node invocation
const fakeBinJs = path.join(fakeBinDir, 'claude.js');
writeFileSync(fakeBinJs,
  '#!/usr/bin/env node\n' +
  'let i = ""; process.stdin.on("data", c => i += c); process.stdin.on("end", () => {\n' +
  '  process.stdout.write("# Title\\n\\nText compressed by fake claude.\\n");\n' +
  '});\n'
);

// On Windows, the CAVEMAN_CLAUDE_BIN needs to be a node script wrapped in a cmd
// We create a .cmd wrapper that invokes node with the .js
const isWindows = process.platform === 'win32';
let FAKE_BIN;
if (isWindows) {
  const fakeBinCmd = path.join(fakeBinDir, 'claude.cmd');
  writeFileSync(fakeBinCmd,
    `@echo off\nnode "${fakeBinJs}" %*\n`
  );
  FAKE_BIN = path.join(fakeBinDir, 'claude.cmd');
} else {
  FAKE_BIN = fakeBin;
}

process.on('exit', () => {
  try { rmSync(fakeBinDir, { recursive: true, force: true }); } catch (e) {}
});

// Require compress.js (will fail in RED phase)
let compressModule;
try {
  compressModule = require('./compress');
} catch (e) {
  compressModule = null;
}

const { compressFile } = compressModule || {};

// ---- Helper to run compress.js as a subprocess (for the CLI entrypoint test) ----
const { spawnSync } = require('node:child_process');

function runCompress(filePath, env = {}) {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, 'compress.js'), filePath],
    {
      encoding: 'utf8',
      env: { ...process.env, CAVEMAN_CLAUDE_BIN: FAKE_BIN, ...env },
      timeout: 30000
    }
  );
  return result;
}

// ---------- CLI entrypoint tests ----------

test('compress CLI: creates backup and overwrites primary', () => {
  const p = tmpFile('cli-compress-test.md');
  const origContent = readFileSync(p, 'utf8');
  const backupPath = p.replace(/\.md$/, '.original.md');

  const result = runCompress(p);

  assert.equal(result.status, 0, `exit code should be 0, got ${result.status}. stderr: ${result.stderr}`);
  assert.ok(existsSync(backupPath), 'backup file should exist');
  assert.equal(readFileSync(backupPath, 'utf8'), origContent, 'backup should equal original content');
  const newContent = readFileSync(p, 'utf8');
  assert.notEqual(newContent, origContent, 'primary should be overwritten');
  assert.match(newContent, /Title/, 'compressed content should contain heading');
});

test('compress CLI: summary printed to stdout (no file contents)', () => {
  const p = tmpFile('cli-summary-test.md');
  const result = runCompress(p);

  assert.equal(result.status, 0, `exit code should be 0. stderr: ${result.stderr}`);
  // Summary should mention the filename or byte counts
  assert.ok(
    result.stdout.includes('Compressed') || result.stdout.includes('→') || result.stdout.includes('bytes'),
    `stdout should contain compression summary, got: ${result.stdout}`
  );
  // stdout must NOT contain the raw file contents (just the summary)
  assert.ok(
    !result.stdout.includes('natural language text that should be compressed'),
    'stdout must not contain raw file contents'
  );
});

test('compress CLI: refuses sensitive filename', () => {
  const sensitiveFile = path.join(tmpDir, 'credentials.md');
  writeFileSync(sensitiveFile, '# Creds\npassword: hunter2\n');
  const result = runCompress(sensitiveFile);
  assert.notEqual(result.status, 0, 'should exit non-zero for sensitive file');
  assert.ok(
    result.stdout.includes('sensitive') || result.stdout.includes('Refusing'),
    `should mention sensitivity refusal, got: ${result.stdout}`
  );
  // Primary file should be untouched (no backup created)
  const backupPath = sensitiveFile.replace(/\.md$/, '.original.md');
  assert.equal(existsSync(backupPath), false, 'backup should NOT be created for sensitive file');
});

test('compress CLI: refuses when backup already exists', () => {
  const p = tmpFile('already-backed-up.md');
  const backupPath = p.replace(/\.md$/, '.original.md');
  // Create backup first
  writeFileSync(backupPath, '# old backup\n');
  const origContent = readFileSync(p, 'utf8');

  const result = runCompress(p);
  assert.notEqual(result.status, 0, 'should exit non-zero when backup exists');
  // Primary should be untouched
  assert.equal(readFileSync(p, 'utf8'), origContent, 'primary must not be modified when backup exists');
});

test('compress CLI: restores original on validation failure', () => {
  // Use a fake claude that returns something guaranteed to fail validation:
  // output with fewer headings than the input (heading count mismatch = error)
  const badFakeBinDir = mkdtempSync(path.join(os.tmpdir(), 'bad-fake-claude-'));
  // No heading — but original has one → heading count mismatch error
  const badContent = 'All headings removed by bad fake.\n';

  let badBin;
  if (isWindows) {
    const badFakeBinJs = path.join(badFakeBinDir, 'claude.js');
    writeFileSync(badFakeBinJs,
      '#!/usr/bin/env node\n' +
      'let i = ""; process.stdin.on("data", c => i += c); process.stdin.on("end", () => {\n' +
      `  process.stdout.write(${JSON.stringify(badContent)});\n` +
      '});\n'
    );
    const badFakeBinCmd = path.join(badFakeBinDir, 'claude.cmd');
    writeFileSync(badFakeBinCmd,
      `@echo off\nnode "${badFakeBinJs}" %*\n`
    );
    badBin = badFakeBinCmd;
  } else {
    badBin = path.join(badFakeBinDir, 'claude');
    writeFileSync(badBin,
      '#!/usr/bin/env node\n' +
      'let i = ""; process.stdin.on("data", c => i += c); process.stdin.on("end", () => {\n' +
      `  process.stdout.write(${JSON.stringify(badContent)});\n` +
      '});\n',
      { mode: 0o755 }
    );
  }

  process.on('exit', () => {
    try { rmSync(badFakeBinDir, { recursive: true, force: true }); } catch (e) {}
  });

  // The input has a specific heading that the bad fake won't preserve
  const p = tmpFile(`restore-test-${Date.now()}.md`,
    '# Specific Heading That Must Be Preserved\n\n' +
    'Some natural language content here.\n'
  );
  const origContent = readFileSync(p, 'utf8');
  const backupPath = p.replace(/\.md$/, '.original.md');

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, 'compress.js'), p],
    {
      encoding: 'utf8',
      env: { ...process.env, CAVEMAN_CLAUDE_BIN: badBin },
      timeout: 30000
    }
  );

  // After all retries fail:
  // - primary should be restored to original
  // - backup should be deleted
  assert.notEqual(result.status, 0, `should fail when validation fails after retries. stderr: ${result.stderr}`);
  assert.equal(readFileSync(p, 'utf8'), origContent, 'primary must be restored to original after validation failure');
  assert.equal(existsSync(backupPath), false, 'backup must be deleted after restore');
});
