'use strict';
// Tests for cavecrew-model-overrides.js — per-agent model override hook helpers
// Run: node --test hooks/cavecrew-model-overrides.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// We require the module after writing it; tests fail until it exists.
let overridesModule;
try {
  overridesModule = require('./cavecrew-model-overrides');
} catch (e) {
  // Module doesn't exist yet — tests will error naturally during RED phase.
  overridesModule = null;
}

const { resolvePluginRoot, patchFrontmatterModel, applyOverrides, AGENT_ENV_MAP } =
  overridesModule || {};

// ---------- Shared fixtures ----------

const REAL_AGENTS_DIR = path.join(__dirname, '..', 'agents');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cavecrew-overrides-test-'));
process.on('exit', () => {
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (e) {}
});

function withLF(lines) {
  return lines.join('\n');
}

function withCRLF(lines) {
  return lines.join('\r\n');
}

function hasBareLF(str) {
  // A '\n' not immediately preceded by '\r' — signals mixed/introduced LF
  // in content that should have stayed pure CRLF.
  return /(?<!\r)\n/.test(str);
}

// Classifies a string's dominant EOL style so tests can assert "preserved,
// not converted" without hard-coding CRLF vs LF — the repo's working tree is
// CRLF today (Windows, core.autocrlf=true) but the repo *stores* LF, so a
// test that assumes CRLF on every checkout is not durable.
function eolStyle(str) {
  if (!/\r\n/.test(str)) return 'lf';
  return hasBareLF(str) ? 'mixed' : 'crlf';
}

// Realistic-but-synthetic fixtures modeled on the real agents/cavecrew-*.md
// files (verified by reading them: reviewer/investigator declare `model:
// haiku`, builder has a `tools:` line but no `model:` line at all). These are
// baked into the test file rather than copied from the repo at runtime so
// applyOverrides tests stay deterministic even if the real agent files are
// later edited.
const REVIEWER_FIXTURE = withCRLF([
  '---',
  'name: cavecrew-reviewer',
  'description: Diff/branch/file reviewer.',
  'tools: [Read, Grep, Bash]',
  'model: haiku',
  '---',
  '',
  'Caveman-ultra. Findings only.',
  '',
]);

const BUILDER_FIXTURE = withCRLF([
  '---',
  'name: cavecrew-builder',
  'description: Surgical 1-2 file edit.',
  'tools: [Read, Edit, Write, Grep, Glob]',
  '---',
  '',
  'Caveman-ultra. Drop articles/filler.',
  '',
]);

const INVESTIGATOR_FIXTURE = withCRLF([
  '---',
  'name: cavecrew-investigator',
  'description: Read-only code locator.',
  'tools: [Read, Grep, Glob, Bash]',
  'model: haiku',
  '---',
  '',
  'Caveman-ultra. Drop articles/filler/hedging.',
  '',
]);

// Writes the synthetic fixtures above into a fresh tmp plugin root
// (pluginRoot/agents/*.md) so applyOverrides tests exercise realistic
// frontmatter shapes without depending on mutable repo content.
function makePluginRoot() {
  const root = fs.mkdtempSync(path.join(TMP_ROOT, 'plugin-root-'));
  const agentsDir = path.join(root, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'cavecrew-reviewer.md'), REVIEWER_FIXTURE);
  fs.writeFileSync(path.join(agentsDir, 'cavecrew-builder.md'), BUILDER_FIXTURE);
  fs.writeFileSync(path.join(agentsDir, 'cavecrew-investigator.md'), INVESTIGATOR_FIXTURE);
  return root;
}

// CONTRACT NOTE: several `applyOverrides` tests below spy on `fs.readFileSync`
// / `fs.writeFileSync` via `t.mock.method(fs, ...)`, where `fs` is the
// `node:fs` module object required at the top of this file. This only
// observes calls made as property accesses on that module object (e.g.
// `fs.readFileSync(...)`). An implementation that destructures at module load
// time (`const { readFileSync } = require('fs')`) captures a plain function
// reference before the spy installs, and the spy will not see those calls.
// The implementation MUST call `fs.readFileSync` / `fs.writeFileSync` as
// property accesses for those tests to observe the intended behavior.

// ---------- AGENT_ENV_MAP ----------

test('AGENT_ENV_MAP: exposes exactly the three cavecrew env-var-to-file mappings', () => {
  assert.equal(Array.isArray(AGENT_ENV_MAP), true);
  assert.equal(AGENT_ENV_MAP.length, 3);
  const asMap = Object.fromEntries(AGENT_ENV_MAP.map((e) => [e.envVar, e.file]));
  assert.deepEqual(asMap, {
    CAVECREW_REVIEWER_MODEL: 'agents/cavecrew-reviewer.md',
    CAVECREW_BUILDER_MODEL: 'agents/cavecrew-builder.md',
    CAVECREW_INVESTIGATOR_MODEL: 'agents/cavecrew-investigator.md',
  });
});

// ---------- resolvePluginRoot ----------

test('resolvePluginRoot: resolves to the parent of the hooks directory', () => {
  assert.equal(resolvePluginRoot('/plugin/hooks'), path.resolve('/plugin/hooks', '..'));
});

test('resolvePluginRoot: applied to this repo\'s real hooks dir yields a root containing agents/', () => {
  const root = resolvePluginRoot(__dirname);
  assert.equal(fs.existsSync(path.join(root, 'agents', 'cavecrew-reviewer.md')), true);
});

// ---------- patchFrontmatterModel: structural branches ----------

test('patchFrontmatterModel: content without frontmatter is returned unchanged', () => {
  const content = withLF(['# Title', '', 'Just body content, no frontmatter here.', '']);
  assert.equal(patchFrontmatterModel(content, 'sonnet'), content);
});

test('patchFrontmatterModel: content starting with --- but no closing --- is returned unchanged', () => {
  const content = withLF([
    '---',
    'name: broken',
    'tools: [Read]',
    'Body text with no closing fence at all.',
    '',
  ]);
  assert.equal(patchFrontmatterModel(content, 'sonnet'), content);
});

test('patchFrontmatterModel: bare "---" with nothing else is returned unchanged', () => {
  assert.equal(patchFrontmatterModel('---', 'sonnet'), '---');
});

test('patchFrontmatterModel: existing model: line is replaced in place', () => {
  const content = withLF([
    '---',
    'name: cavecrew-reviewer',
    'tools: [Read, Grep, Bash]',
    'model: haiku',
    '---',
    '',
    'Body text',
    '',
  ]);
  const expected = withLF([
    '---',
    'name: cavecrew-reviewer',
    'tools: [Read, Grep, Bash]',
    'model: sonnet',
    '---',
    '',
    'Body text',
    '',
  ]);
  assert.equal(patchFrontmatterModel(content, 'sonnet'), expected);
});

test('patchFrontmatterModel: replacing model: with the same value is a no-op (identity check)', () => {
  const content = withLF([
    '---',
    'name: cavecrew-reviewer',
    'tools: [Read, Grep, Bash]',
    'model: haiku',
    '---',
    '',
    'Body text',
    '',
  ]);
  assert.equal(patchFrontmatterModel(content, 'haiku'), content);
});

test('patchFrontmatterModel: no model: line but a tools: line inserts model: right after tools:', () => {
  const content = withLF([
    '---',
    'name: cavecrew-builder',
    'tools: [Read, Edit, Write, Grep, Glob]',
    '---',
    '',
    'Body text',
    '',
  ]);
  const expected = withLF([
    '---',
    'name: cavecrew-builder',
    'tools: [Read, Edit, Write, Grep, Glob]',
    'model: opus',
    '---',
    '',
    'Body text',
    '',
  ]);
  assert.equal(patchFrontmatterModel(content, 'opus'), expected);
});

test('patchFrontmatterModel: neither model: nor tools: appends model: before the closing ---', () => {
  const content = withLF(['---', 'name: something', 'description: foo', '---', '', 'Body', '']);
  const expected = withLF([
    '---',
    'name: something',
    'description: foo',
    'model: opus',
    '---',
    '',
    'Body',
    '',
  ]);
  assert.equal(patchFrontmatterModel(content, 'opus'), expected);
});

// ---------- patchFrontmatterModel: blank / control-char modelValue rejected ----------

test('patchFrontmatterModel: empty string modelValue is a no-op', () => {
  const content = withLF(['---', 'name: x', 'tools: [Read]', 'model: haiku', '---', '', 'B', '']);
  assert.equal(patchFrontmatterModel(content, ''), content);
});

test('patchFrontmatterModel: undefined modelValue is a no-op', () => {
  const content = withLF(['---', 'name: x', 'tools: [Read]', 'model: haiku', '---', '', 'B', '']);
  assert.equal(patchFrontmatterModel(content, undefined), content);
});

test('patchFrontmatterModel: null modelValue is a no-op', () => {
  const content = withLF(['---', 'name: x', 'tools: [Read]', 'model: haiku', '---', '', 'B', '']);
  assert.equal(patchFrontmatterModel(content, null), content);
});

test('patchFrontmatterModel: modelValue containing a newline is rejected', () => {
  const content = withLF(['---', 'name: x', 'tools: [Read]', '---', '', 'B', '']);
  assert.equal(patchFrontmatterModel(content, 'ha\nku'), content);
});

test('patchFrontmatterModel: modelValue containing a NUL byte is rejected', () => {
  const content = withLF(['---', 'name: x', 'tools: [Read]', '---', '', 'B', '']);
  assert.equal(patchFrontmatterModel(content, 'foo\x00bar'), content);
});

test('patchFrontmatterModel: modelValue containing a DEL (0x7f) byte is rejected', () => {
  const content = withLF(['---', 'name: x', 'tools: [Read]', '---', '', 'B', '']);
  assert.equal(patchFrontmatterModel(content, 'foo\x7fbar'), content);
});

// ---------- patchFrontmatterModel: CRLF preservation ----------

test('patchFrontmatterModel: CRLF frontmatter stays CRLF when replacing an existing model: line', () => {
  const content = withCRLF([
    '---',
    'name: cavecrew-reviewer',
    'tools: [Read, Grep, Bash]',
    'model: haiku',
    '---',
    '',
    'Body text',
    '',
  ]);
  const expected = withCRLF([
    '---',
    'name: cavecrew-reviewer',
    'tools: [Read, Grep, Bash]',
    'model: sonnet',
    '---',
    '',
    'Body text',
    '',
  ]);
  const result = patchFrontmatterModel(content, 'sonnet');
  assert.equal(result, expected);
  assert.equal(hasBareLF(result), false, 'result must not introduce a bare LF into CRLF content');
});

test('patchFrontmatterModel: CRLF frontmatter stays CRLF when inserting after tools:', () => {
  const content = withCRLF([
    '---',
    'name: cavecrew-builder',
    'tools: [Read, Edit, Write, Grep, Glob]',
    '---',
    '',
    'Body text',
    '',
  ]);
  const expected = withCRLF([
    '---',
    'name: cavecrew-builder',
    'tools: [Read, Edit, Write, Grep, Glob]',
    'model: opus',
    '---',
    '',
    'Body text',
    '',
  ]);
  const result = patchFrontmatterModel(content, 'opus');
  assert.equal(result, expected);
  assert.equal(hasBareLF(result), false, 'result must not introduce a bare LF into CRLF content');
});

test('patchFrontmatterModel: CRLF frontmatter stays CRLF when appending with no model:/tools:', () => {
  const content = withCRLF(['---', 'name: something', 'description: foo', '---', '', 'Body', '']);
  const expected = withCRLF([
    '---',
    'name: something',
    'description: foo',
    'model: opus',
    '---',
    '',
    'Body',
    '',
  ]);
  const result = patchFrontmatterModel(content, 'opus');
  assert.equal(result, expected);
  assert.equal(hasBareLF(result), false, 'result must not introduce a bare LF into CRLF content');
});

test('patchFrontmatterModel: real cavecrew-reviewer.md fixture patches cleanly and preserves EOL style', () => {
  const content = fs.readFileSync(path.join(REAL_AGENTS_DIR, 'cavecrew-reviewer.md'), 'utf8');
  const existingModelMatch = content.match(/^model:[ \t]*(.*)$/m);
  assert.ok(existingModelMatch, 'fixture is expected to declare an existing model: line');
  const existingModel = existingModelMatch[1].trim();

  const result = patchFrontmatterModel(content, 'a-different-model-value');
  assert.match(result, /model: a-different-model-value/);
  assert.equal(result.includes(`model: ${existingModel}`), false);
  assert.equal(
    eolStyle(result),
    eolStyle(content),
    'patching must preserve the fixture\'s EOL style (whatever it is on this checkout), not convert it'
  );

  // Same value as already present is an identity no-op against the real fixture too.
  assert.equal(patchFrontmatterModel(content, existingModel), content);
});

// ---------- applyOverrides ----------

test('applyOverrides: applies a valid override to the mapped file only', () => {
  const pluginRoot = makePluginRoot();
  const reviewerPath = path.join(pluginRoot, 'agents', 'cavecrew-reviewer.md');
  const builderPath = path.join(pluginRoot, 'agents', 'cavecrew-builder.md');
  const builderBefore = fs.readFileSync(builderPath, 'utf8');

  applyOverrides(pluginRoot, { CAVECREW_REVIEWER_MODEL: 'sonnet' });

  const reviewerAfter = fs.readFileSync(reviewerPath, 'utf8');
  assert.match(reviewerAfter, /model: sonnet/);
  assert.equal(/model: haiku/.test(reviewerAfter), false);
  assert.equal(eolStyle(reviewerAfter), 'crlf', 'the CRLF fixture must stay CRLF after being written back');

  // builder wasn't targeted by this override — must be untouched
  assert.equal(fs.readFileSync(builderPath, 'utf8'), builderBefore);
});

test('applyOverrides: builder.md (no existing model: line) gets model: inserted after tools:', () => {
  const pluginRoot = makePluginRoot();
  const builderPath = path.join(pluginRoot, 'agents', 'cavecrew-builder.md');

  applyOverrides(pluginRoot, { CAVECREW_BUILDER_MODEL: 'opus' });

  const after = fs.readFileSync(builderPath, 'utf8').replace(/\r\n/g, '\n');
  assert.match(after, /tools: \[Read, Edit, Write, Grep, Glob\]\nmodel: opus\n/);
});

test('applyOverrides: unset env var is skipped, target file untouched', () => {
  const pluginRoot = makePluginRoot();
  const reviewerPath = path.join(pluginRoot, 'agents', 'cavecrew-reviewer.md');
  const before = fs.readFileSync(reviewerPath, 'utf8');

  applyOverrides(pluginRoot, {});

  assert.equal(fs.readFileSync(reviewerPath, 'utf8'), before);
});

test('applyOverrides: unset env var never even triggers a read of its mapped file', (t) => {
  const pluginRoot = makePluginRoot();
  const reviewerPath = path.join(pluginRoot, 'agents', 'cavecrew-reviewer.md');
  const readSpy = t.mock.method(fs, 'readFileSync');

  applyOverrides(pluginRoot, {});

  const readReviewer = readSpy.mock.calls.some((c) => c.arguments[0] === reviewerPath);
  assert.equal(readReviewer, false, 'unset env var must short-circuit before reading the file');
});

test('applyOverrides: whitespace-only env value is skipped (treated as blank)', () => {
  const pluginRoot = makePluginRoot();
  const reviewerPath = path.join(pluginRoot, 'agents', 'cavecrew-reviewer.md');
  const before = fs.readFileSync(reviewerPath, 'utf8');

  applyOverrides(pluginRoot, { CAVECREW_REVIEWER_MODEL: '   ' });

  assert.equal(fs.readFileSync(reviewerPath, 'utf8'), before);
});

test('applyOverrides: control-char env value is skipped', () => {
  const pluginRoot = makePluginRoot();
  const builderPath = path.join(pluginRoot, 'agents', 'cavecrew-builder.md');
  const before = fs.readFileSync(builderPath, 'utf8');

  applyOverrides(pluginRoot, { CAVECREW_BUILDER_MODEL: 'foo\nbar' });

  assert.equal(fs.readFileSync(builderPath, 'utf8'), before);
});

test('applyOverrides: missing mapped file is silently skipped, no throw', () => {
  const pluginRoot = fs.mkdtempSync(path.join(TMP_ROOT, 'empty-root-'));
  fs.mkdirSync(path.join(pluginRoot, 'agents'), { recursive: true });

  assert.doesNotThrow(() =>
    applyOverrides(pluginRoot, {
      CAVECREW_REVIEWER_MODEL: 'sonnet',
      CAVECREW_BUILDER_MODEL: 'sonnet',
      CAVECREW_INVESTIGATOR_MODEL: 'sonnet',
    })
  );
  assert.equal(fs.existsSync(path.join(pluginRoot, 'agents', 'cavecrew-reviewer.md')), false);
});

test('applyOverrides: nonexistent pluginRoot never throws', () => {
  const pluginRoot = path.join(TMP_ROOT, 'does-not-exist-' + Date.now());
  assert.doesNotThrow(() => applyOverrides(pluginRoot, { CAVECREW_REVIEWER_MODEL: 'sonnet' }));
});

test('applyOverrides: a read error other than "missing file" is also swallowed (no throw)', () => {
  const pluginRoot = fs.mkdtempSync(path.join(TMP_ROOT, 'eisdir-root-'));
  const agentsDir = path.join(pluginRoot, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  // A directory where a file is expected triggers EISDIR on read, not ENOENT.
  fs.mkdirSync(path.join(agentsDir, 'cavecrew-reviewer.md'));

  assert.doesNotThrow(() => applyOverrides(pluginRoot, { CAVECREW_REVIEWER_MODEL: 'sonnet' }));
});

test('applyOverrides: skips the write when the patched content is identical (no-op diff)', (t) => {
  const pluginRoot = makePluginRoot();
  const reviewerPath = path.join(pluginRoot, 'agents', 'cavecrew-reviewer.md');
  const before = fs.readFileSync(reviewerPath, 'utf8');
  assert.match(before, /model: haiku/); // sanity on the fixture

  const readSpy = t.mock.method(fs, 'readFileSync');
  const writeSpy = t.mock.method(fs, 'writeFileSync');

  applyOverrides(pluginRoot, { CAVECREW_REVIEWER_MODEL: 'haiku' });

  const readReviewer = readSpy.mock.calls.some((c) => c.arguments[0] === reviewerPath);
  const wroteReviewer = writeSpy.mock.calls.some((c) => c.arguments[0] === reviewerPath);
  assert.equal(readReviewer, true, 'a valid override must still read the file to compute the diff');
  assert.equal(wroteReviewer, false, 'identical patched content must not trigger a write');
  assert.equal(fs.readFileSync(reviewerPath, 'utf8'), before, 'file on disk stays byte-identical');
});

test('applyOverrides: write errors are swallowed, session activation must never be blocked', (t) => {
  const pluginRoot = makePluginRoot();
  t.mock.method(fs, 'writeFileSync', () => {
    throw new Error('simulated disk failure');
  });

  assert.doesNotThrow(() => applyOverrides(pluginRoot, { CAVECREW_REVIEWER_MODEL: 'sonnet' }));
});

test('applyOverrides: multiple env vars are applied independently', () => {
  const pluginRoot = makePluginRoot();
  const reviewerPath = path.join(pluginRoot, 'agents', 'cavecrew-reviewer.md');
  const builderPath = path.join(pluginRoot, 'agents', 'cavecrew-builder.md');
  const investigatorPath = path.join(pluginRoot, 'agents', 'cavecrew-investigator.md');
  const builderBefore = fs.readFileSync(builderPath, 'utf8');

  applyOverrides(pluginRoot, {
    CAVECREW_REVIEWER_MODEL: 'opus',
    CAVECREW_INVESTIGATOR_MODEL: 'sonnet',
    // CAVECREW_BUILDER_MODEL intentionally unset
  });

  assert.match(fs.readFileSync(reviewerPath, 'utf8'), /model: opus/);
  assert.match(fs.readFileSync(investigatorPath, 'utf8'), /model: sonnet/);
  assert.equal(fs.readFileSync(builderPath, 'utf8'), builderBefore);
});

test('applyOverrides: omitting the env argument does not throw (defaults to process.env)', () => {
  const pluginRoot = makePluginRoot();
  assert.doesNotThrow(() => applyOverrides(pluginRoot));
});
