'use strict';
// Tests for validate.js — structural diff validator
// Run: node --test validate.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');

let validateModule;
try {
  validateModule = require('./validate');
} catch (e) {
  validateModule = null;
}

const { validate } = validateModule || {};

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'caveman-validate-test-'));
process.on('exit', () => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
});

let fileIdx = 0;
function writeTmp(content) {
  const p = path.join(tmpDir, `file${++fileIdx}.md`);
  writeFileSync(p, content, 'utf8');
  return p;
}

function makeValidate(origContent, compContent) {
  const orig = writeTmp(origContent);
  const comp = writeTmp(compContent);
  return validate(orig, comp);
}

// ---------- Headings ----------

test('validate: identical headings passes', () => {
  const orig = '# Title\n## Sub\nSome text here.\n';
  const comp = '# Title\n## Sub\nText here.\n';
  const result = makeValidate(orig, comp);
  assert.equal(result.isValid, true);
  assert.equal(result.errors.length, 0);
});

test('validate: dropped heading is an error', () => {
  const orig = '# Title\n## Sub\nSome text.\n';
  const comp = '# Title\nText.\n';
  const result = makeValidate(orig, comp);
  assert.equal(result.isValid, false);
  assert.ok(result.errors.some(e => /heading/i.test(e)), `Expected heading error, got: ${JSON.stringify(result.errors)}`);
});

// ---------- Code blocks ----------

test('validate: identical code blocks passes', () => {
  const orig = 'Text\n```js\nconst x = 1;\n```\nMore text.\n';
  const comp = 'Text\n```js\nconst x = 1;\n```\nMore.\n';
  const result = makeValidate(orig, comp);
  assert.equal(result.isValid, true);
});

test('validate: changed code block is an error', () => {
  const orig = 'Text\n```js\nconst x = 1;\n```\n';
  const comp = 'Text\n```js\nconst x = 2;\n```\n';
  const result = makeValidate(orig, comp);
  assert.equal(result.isValid, false);
  assert.ok(result.errors.some(e => /code block/i.test(e)), `Expected code block error, got: ${JSON.stringify(result.errors)}`);
});

// ---------- URLs ----------

test('validate: all URLs preserved passes', () => {
  const orig = 'See https://example.com for details\n';
  const comp = 'See https://example.com\n';
  const result = makeValidate(orig, comp);
  assert.equal(result.isValid, true);
});

test('validate: lost URL is an error', () => {
  const orig = 'See https://example.com for details.\n';
  const comp = 'See link for details.\n';
  const result = makeValidate(orig, comp);
  assert.equal(result.isValid, false);
  assert.ok(result.errors.some(e => /url/i.test(e)), `Expected URL error, got: ${JSON.stringify(result.errors)}`);
});

// ---------- Inline code ----------

test('validate: inline code preserved passes', () => {
  const orig = 'Use `npm install` to install.\n';
  const comp = 'Use `npm install`.\n';
  const result = makeValidate(orig, comp);
  assert.equal(result.isValid, true);
});

test('validate: lost inline code is an error', () => {
  const orig = 'Use `npm install` to install packages.\n';
  const comp = 'Use npm install to install.\n';
  const result = makeValidate(orig, comp);
  assert.equal(result.isValid, false);
  assert.ok(result.errors.some(e => /inline code/i.test(e)), `Expected inline code error, got: ${JSON.stringify(result.errors)}`);
});

// ---------- ValidationResult structure ----------

test('validate: result has isValid, errors, warnings fields', () => {
  const orig = '# Title\nHello world.\n';
  const comp = '# Title\nHello.\n';
  const result = makeValidate(orig, comp);
  assert.ok(typeof result.isValid === 'boolean', 'isValid should be boolean');
  assert.ok(Array.isArray(result.errors), 'errors should be array');
  assert.ok(Array.isArray(result.warnings), 'warnings should be array');
});
