'use strict';
// Tests for caveman-activate.js — SessionStart activation hook regression
// tests for issue #16: the hardcoded standalone-install fallback ruleset
// (used when SKILL.md cannot be read — e.g. a bare hooks/ install without a
// sibling skills/ directory) duplicates its own copy of caveman-mode text
// that has drifted out of sync with skills/caveman/SKILL.md, the single
// source of truth, across two merged PRs:
//
//   - PR #10 (https://github.com/glitchwerks/mini-caveman/pull/10) added
//     the wenyan-lite/wenyan-full/wenyan-ultra modes to the mode-switch
//     roster, and broadened the Boundaries rule's persisted-outside-chat
//     scope to: code, comments, commits, docs, issue/PR text, memory files,
//     third-party messages.
//   - PR #12 (https://github.com/glitchwerks/mini-caveman/pull/12) reversed
//     the ultra-level rule: bans invented prose abbreviations
//     (cfg/impl/req/res/fn) and causal arrows (→), which the pre-reversal
//     fallback text does not reflect at all.
//
// The hook is a script with no exports — on session start it reads
// SKILL.md from a path relative to its own __dirname and writes the
// resulting ruleset straight to stdout — so it is exercised black-box as a
// real subprocess. To force the standalone-install fallback branch (rather
// than the normal path that reads the real SKILL.md), each test runs the
// hook from a copied hooks/ directory that deliberately has no sibling
// skills/ directory, so the SKILL.md read throws and the hook falls back
// to its hardcoded ruleset — the text under test here.
//
// Run: node --test hooks/caveman-activate.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const REAL_HOOKS_DIR = __dirname;

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'caveman-activate-test-'));
process.on('exit', () => {
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (e) {}
});

// A fresh CLAUDE_CONFIG_DIR per test — the hook resolves the flag path as
// `${CLAUDE_CONFIG_DIR}/.caveman-active` and writes it on activation.
function makeConfigDir() {
  return fs.mkdtempSync(path.join(TMP_ROOT, 'config-'));
}

// Copies caveman-activate.js and its non-optional dependency
// (caveman-config.js — required unconditionally, unlike
// cavecrew-model-overrides.js which is required inside a try/catch and is
// safe to omit) into an isolated `<tmp>/hooks/` directory with no sibling
// `skills/` directory. caveman-activate.js resolves the SKILL.md path as
// `path.join(__dirname, '..', 'skills', 'caveman', 'SKILL.md')`, so running
// the copy from this isolated layout forces that read to fail and the hook
// to execute its hardcoded standalone-install fallback branch.
function makeIsolatedActivateHook() {
  const pluginRoot = fs.mkdtempSync(path.join(TMP_ROOT, 'plugin-root-'));
  const hooksDir = path.join(pluginRoot, 'hooks');
  fs.mkdirSync(hooksDir);
  for (const file of ['caveman-activate.js', 'caveman-config.js']) {
    fs.copyFileSync(path.join(REAL_HOOKS_DIR, file), path.join(hooksDir, file));
  }
  return path.join(hooksDir, 'caveman-activate.js');
}

// Spawns the hook from the isolated (skills/-less) copy with a fresh
// CLAUDE_CONFIG_DIR and CAVEMAN_DEFAULT_MODE='full' (highest-priority mode
// source, so the test is unaffected by any real config file on the host
// machine), and resolves once the process exits.
function runActivateHook(envOverrides) {
  const activatePath = makeIsolatedActivateHook();
  const configDir = makeConfigDir();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [activatePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configDir,
        CAVEMAN_DEFAULT_MODE: 'full',
        ...envOverrides,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('exit', (code, signal) => {
      resolve({ code, signal, stdout, stderr, configDir });
    });
  });
}

function boundariesSectionOf(output) {
  const idx = output.indexOf('## Boundaries');
  assert.notEqual(idx, -1, `expected output to contain a "## Boundaries" section, got:\n${output}`);
  return output.slice(idx);
}

test('standalone-install fallback: mode-switch roster includes the wenyan modes added in PR #10', async () => {
  const result = await runActivateHook();
  assert.equal(result.code, 0, `hook must exit 0. stderr:\n${result.stderr}`);

  for (const mode of ['wenyan-lite', 'wenyan-full', 'wenyan-ultra']) {
    assert.match(
      result.stdout,
      new RegExp(mode, 'i'),
      `expected fallback ruleset's mode-switch roster to include "${mode}" (added upstream in PR #10), got:\n${result.stdout}`
    );
  }
});

test('standalone-install fallback: ultra-level rule bans invented abbreviations, per the PR #12 reversal', async () => {
  const result = await runActivateHook();
  assert.equal(result.code, 0, `hook must exit 0. stderr:\n${result.stderr}`);

  assert.match(
    result.stdout,
    /never invent/i,
    `expected fallback ruleset to ban inventing new prose abbreviations (cfg/impl/req/res/fn) per the PR #12 reversal, got:\n${result.stdout}`
  );
});

test('standalone-install fallback: ultra-level rule bans causal arrows, per the PR #12 reversal', async () => {
  const result = await runActivateHook();
  assert.equal(result.code, 0, `hook must exit 0. stderr:\n${result.stderr}`);

  assert.match(
    result.stdout,
    /causal arrow/i,
    `expected fallback ruleset to ban causal arrows (→) per the PR #12 reversal, got:\n${result.stdout}`
  );
});

test('standalone-install fallback: Boundaries rule covers the full persisted-outside-chat scope broadened in PR #10', async () => {
  const result = await runActivateHook();
  assert.equal(result.code, 0, `hook must exit 0. stderr:\n${result.stderr}`);

  const boundaries = boundariesSectionOf(result.stdout);
  const expectedTerms = [
    'code',
    'comments',
    'commits',
    'docs',
    'issue/PR',
    'memory files',
    'third-party messages',
  ];
  for (const term of expectedTerms) {
    assert.match(
      boundaries,
      new RegExp(term.replace(/[/]/g, '\\/'), 'i'),
      `expected fallback ruleset's Boundaries section to mention "${term}" (full SKILL.md scope from PR #10), got:\n${boundaries}`
    );
  }
});
