'use strict';
// Tests for caveman-mode-tracker.js — UserPromptSubmit hook regression tests
// for issue #7 (low-risk upstream fixes):
//   1. Missing stdin 'error' listener must not crash the hook — the Node
//      hook contract requires it to always exit 0, even on abnormal stdin
//      close (broken pipe, parent process crash).
//   2. Slash-command envelope no-op — Claude Code delivers `/caveman`
//      slash commands to UserPromptSubmit hooks as an XML-ish envelope
//      (<command-message>/<command-name>/<command-args>), not the literal
//      string `/caveman ...`. The hook must unwrap that envelope so mode
//      activation/deactivation still works.
//
// The hook is a script with no exports (it reads process.stdin directly),
// so it is exercised black-box as a real subprocess — never require()'d,
// which would hijack this test runner's own stdin.
//
// Run: node --test hooks/caveman-mode-tracker.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const HOOK_PATH = path.join(__dirname, 'caveman-mode-tracker.js');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'caveman-mode-tracker-test-'));
process.on('exit', () => {
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (e) {}
});

// A fresh CLAUDE_CONFIG_DIR per test gives each test its own flag-file
// location — the hook resolves flagPath as `${CLAUDE_CONFIG_DIR}/.caveman-active`.
function makeConfigDir() {
  return fs.mkdtempSync(path.join(TMP_ROOT, 'config-'));
}

function flagPathFor(configDir) {
  return path.join(configDir, '.caveman-active');
}

// Spawns the real hook as a subprocess with an isolated CLAUDE_CONFIG_DIR,
// feeds it a UserPromptSubmit-shaped JSON payload with the given prompt,
// closes stdin normally, and resolves once the process exits.
function runHook(prompt, configDir) {
  const dir = configDir || makeConfigDir();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('exit', (code, signal) => {
      resolve({ code, signal, stdout, stderr, dir, flagPath: flagPathFor(dir) });
    });
    child.stdin.write(JSON.stringify({ prompt }));
    child.stdin.end();
  });
}

// ---------- symptom 1: missing stdin 'error' handler ----------
//
// A preload script (-r) is injected before the hook's own top-level code
// runs. It waits briefly (long enough for the hook to synchronously
// register its process.stdin listeners) and then emits a synthetic
// 'error' event directly on process.stdin, simulating an abnormal close
// (broken pipe / parent crash) arriving mid-transmission. The write side
// of the child's stdin is left open (never .end()'d) so no natural 'end'
// event can race the injected error — the error is guaranteed to be the
// only stdin event the hook observes in this test.
//
// EventEmitter contract: an 'error' event with no registered listener
// throws synchronously, crashing the process with a non-zero exit code.
// The hook currently only registers 'data' and 'end' listeners, so today
// this reproduces exactly that crash. This test asserts the CORRECT
// contract (always exit 0) and is expected to fail against current code.
const STDIN_ERROR_INJECTOR = path.join(TMP_ROOT, 'stdin-error-injector.js');
fs.writeFileSync(
  STDIN_ERROR_INJECTOR,
  "setTimeout(() => {\n" +
    "  process.stdin.emit('error', Object.assign(new Error('simulated abrupt stdin close'), { code: 'ECONNRESET' }));\n" +
    '}, 30);\n'
);

function runHookWithInjectedStdinError(prompt, configDir) {
  const dir = configDir || makeConfigDir();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-r', STDIN_ERROR_INJECTOR, HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('exit', (code, signal) => {
      resolve({ code, signal, stdout, stderr, dir, flagPath: flagPathFor(dir) });
    });
    // Partial payload, deliberately never completed/closed — mirrors a
    // parent process that dies mid-write. The injected 'error' event is
    // what determines the outcome, not a natural EOF.
    child.stdin.write('{"prompt": "' + prompt);
  });
}

test('stdin error before end: hook exits 0 instead of crashing on an abnormal stdin close', async () => {
  const result = await runHookWithInjectedStdinError('/caveman ultra');
  assert.equal(
    result.code,
    0,
    `expected exit code 0 on stdin error, got ${result.code}. stderr:\n${result.stderr}`
  );
});

// ---------- symptom 2: slash-command envelope no-op ----------
//
// Claude Code delivers `/caveman` slash commands to UserPromptSubmit hooks
// wrapped in an XML-ish envelope, not as the literal string "/caveman ...".
// The hook's `prompt.startsWith('/caveman')` check does not unwrap this
// envelope, so activation/deactivation silently no-ops. These tests assert
// the CORRECT behavior (mode gets activated/deactivated from the envelope)
// and are expected to fail against current code, which leaves the flag
// file untouched.

function newlineEnvelope(commandArgs) {
  return (
    '<command-message>caveman</command-message>\n' +
    '<command-name>/caveman</command-name>\n' +
    `<command-args>${commandArgs}</command-args>`
  );
}

function oneLineEnvelope(commandArgs) {
  return (
    '<command-message>caveman</command-message> ' +
    '<command-name>/caveman</command-name> ' +
    `<command-args>${commandArgs}</command-args>`
  );
}

test('slash-command envelope (newline-separated): /caveman ultra activates ultra mode', async () => {
  const result = await runHook(newlineEnvelope('ultra'));
  assert.equal(result.code, 0, `hook must still exit 0. stderr:\n${result.stderr}`);
  assert.equal(
    fs.existsSync(result.flagPath),
    true,
    'expected the caveman flag file to be written from the envelope-wrapped /caveman ultra command'
  );
  assert.equal(
    fs.readFileSync(result.flagPath, 'utf8'),
    'ultra',
    'flag file must contain the mode from <command-args>, not be blank/wrong/default'
  );
});

test('slash-command envelope (one-line): /caveman ultra activates ultra mode', async () => {
  const result = await runHook(oneLineEnvelope('ultra'));
  assert.equal(result.code, 0, `hook must still exit 0. stderr:\n${result.stderr}`);
  assert.equal(
    fs.existsSync(result.flagPath),
    true,
    'expected the caveman flag file to be written from the one-line envelope-wrapped /caveman ultra command'
  );
  assert.equal(
    fs.readFileSync(result.flagPath, 'utf8'),
    'ultra',
    'flag file must contain the mode from <command-args>, not be blank/wrong/default'
  );
});

test('slash-command envelope (newline-separated): /caveman off deactivates and removes the flag file', async () => {
  const configDir = makeConfigDir();
  const flagPath = flagPathFor(configDir);
  // Pre-seed an active flag, matching a session where caveman mode was
  // already on before the user ran `/caveman off`.
  fs.writeFileSync(flagPath, 'ultra');

  const result = await runHook(newlineEnvelope('off'), configDir);
  assert.equal(result.code, 0, `hook must still exit 0. stderr:\n${result.stderr}`);
  assert.equal(
    fs.existsSync(result.flagPath),
    false,
    'expected the caveman flag file to be removed by the envelope-wrapped /caveman off command'
  );
});

// ---------- issue #16: stale Boundaries text in per-turn reinforcement ----------
//
// skills/caveman/SKILL.md's `## Boundaries` section (source of truth) reads:
//   "Persisted outside chat: write normal prose — code, comments, commits,
//   docs, issue/PR text, memory files, third-party messages
//   (`/caveman-compress` exempt)."
// (broadened in PR #10, https://github.com/glitchwerks/mini-caveman/pull/10)
//
// The per-turn reinforcement string this hook injects on every turn while
// caveman mode is active duplicates its own copy of that rule instead of
// reading SKILL.md, and that copy still reflects the pre-PR#10 narrow scope
// ("Code/commits/security: write normal."). It is missing comments, docs,
// issue/PR text, memory files, and third-party messages. These tests assert
// the CORRECT (broadened) scope and are expected to fail against current
// code, which emits the stale, narrower text.
//
// A prompt with no caveman-related words is used so the activation/
// deactivation regexes in this hook are no-ops and only the pre-seeded flag
// file determines whether reinforcement fires.
const NON_CAVEMAN_PROMPT = 'What is the weather forecast for New Orleans tomorrow?';

function extractAdditionalContext(stdout) {
  const parsed = JSON.parse(stdout);
  return parsed.hookSpecificOutput.additionalContext;
}

test('per-turn reinforcement: Boundaries text covers the full persisted-outside-chat scope from SKILL.md', async () => {
  const configDir = makeConfigDir();
  const flagPath = flagPathFor(configDir);
  // Pre-seed an active flag so the hook's per-turn reinforcement fires for
  // an otherwise-neutral prompt.
  fs.writeFileSync(flagPath, 'full');

  const result = await runHook(NON_CAVEMAN_PROMPT, configDir);
  assert.equal(result.code, 0, `hook must still exit 0. stderr:\n${result.stderr}`);

  const additionalContext = extractAdditionalContext(result.stdout);

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
      additionalContext,
      new RegExp(term.replace(/[/]/g, '\\/'), 'i'),
      `expected per-turn reinforcement to mention "${term}" (full SKILL.md Boundaries scope), got:\n${additionalContext}`
    );
  }
});
