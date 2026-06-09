'use strict';
// Tests for detect.js — file-type gate and sensitive-path denylist
// Run: node --test detect.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

// We require detect.js after writing it; tests fail until the module exists.
let detect;
try {
  detect = require('./detect');
} catch (e) {
  // Module doesn't exist yet — tests will error naturally during RED phase.
  detect = null;
}

const { isSensitivePath, shouldCompress } = detect || {};

// ---------- Sensitive path tests ----------

test('isSensitivePath: .env is refused', () => {
  assert.equal(isSensitivePath('/home/user/.env'), true);
});

test('isSensitivePath: .env.production is refused', () => {
  assert.equal(isSensitivePath('/home/user/.env.production'), true);
});

test('isSensitivePath: credentials.md is refused', () => {
  assert.equal(isSensitivePath('/home/user/credentials.md'), true);
});

test('isSensitivePath: secrets.txt is refused', () => {
  assert.equal(isSensitivePath('/home/user/secrets.txt'), true);
});

test('isSensitivePath: id_rsa is refused', () => {
  assert.equal(isSensitivePath('/home/user/.ssh/id_rsa'), true);
});

test('isSensitivePath: id_ed25519 is refused', () => {
  assert.equal(isSensitivePath('/home/user/id_ed25519'), true);
});

test('isSensitivePath: file in .ssh dir is refused', () => {
  assert.equal(isSensitivePath('/home/user/.ssh/config'), true);
});

test('isSensitivePath: file in .aws dir is refused', () => {
  assert.equal(isSensitivePath('/home/user/.aws/credentials'), true);
});

test('isSensitivePath: file in .kube dir is refused', () => {
  assert.equal(isSensitivePath('/home/user/.kube/config'), true);
});

test('isSensitivePath: file in .docker dir is refused', () => {
  assert.equal(isSensitivePath('/home/user/.docker/config.json'), true);
});

test('isSensitivePath: file in .gnupg dir is refused', () => {
  assert.equal(isSensitivePath('/home/user/.gnupg/pubring.kbx'), true);
});

test('isSensitivePath: foo.pem is refused', () => {
  assert.equal(isSensitivePath('/home/user/certs/foo.pem'), true);
});

test('isSensitivePath: api_key.txt is refused (token in name)', () => {
  assert.equal(isSensitivePath('/home/user/api_key.txt'), true);
});

test('isSensitivePath: api-key.txt is refused (token in normalized name)', () => {
  assert.equal(isSensitivePath('/home/user/api-key.txt'), true);
});

test('isSensitivePath: CLAUDE.md is NOT refused', () => {
  assert.equal(isSensitivePath('/home/user/CLAUDE.md'), false);
});

test('isSensitivePath: notes.md is NOT refused', () => {
  assert.equal(isSensitivePath('/home/user/notes.md'), false);
});

test('isSensitivePath: preferences.txt is NOT refused', () => {
  assert.equal(isSensitivePath('/home/user/preferences.txt'), false);
});

// ---------- shouldCompress tests ----------

// shouldCompress requires an actual file on disk to check its type.
// We use a tmp dir for these.

const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'caveman-detect-test-'));

function tmpFile(name, content) {
  const p = path.join(tmpDir, name);
  writeFileSync(p, content || 'Hello world text content here for testing purposes');
  return p;
}

// Clean up after all tests via process.on('exit')
process.on('exit', () => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
});

test('shouldCompress: .md file is accepted', () => {
  const p = tmpFile('readme.md');
  assert.equal(shouldCompress(p), true);
});

test('shouldCompress: .txt file is accepted', () => {
  const p = tmpFile('notes.txt');
  assert.equal(shouldCompress(p), true);
});

test('shouldCompress: .typ file is accepted', () => {
  const p = tmpFile('doc.typ');
  assert.equal(shouldCompress(p), true);
});

test('shouldCompress: .tex file is accepted', () => {
  const p = tmpFile('paper.tex');
  assert.equal(shouldCompress(p), true);
});

test('shouldCompress: .py file is rejected', () => {
  const p = tmpFile('script.py', 'import os\nprint("hello")');
  assert.equal(shouldCompress(p), false);
});

test('shouldCompress: .js file is rejected', () => {
  const p = tmpFile('app.js', 'const x = require("fs");');
  assert.equal(shouldCompress(p), false);
});

test('shouldCompress: .json file is rejected', () => {
  const p = tmpFile('config.json', '{"key": "value"}');
  assert.equal(shouldCompress(p), false);
});

test('shouldCompress: .original.md backup file is rejected', () => {
  const p = tmpFile('CLAUDE.original.md', '# Backup content');
  assert.equal(shouldCompress(p), false);
});

test('shouldCompress: sensitive filename is refused even if .md extension', () => {
  const p = tmpFile('credentials.md', '# My creds');
  assert.equal(shouldCompress(p), false);
});

test('shouldCompress: extensionless natural language file is accepted', () => {
  const p = tmpFile('TODO', 'Buy milk\nFix bug\nWrite tests');
  assert.equal(shouldCompress(p), true);
});
