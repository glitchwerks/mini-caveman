'use strict';
/**
 * validate.js — structural diff validator for compressed markdown
 *
 * Ported from Python: validate.py
 * Pure Node stdlib — no external dependencies.
 *
 * Checks that headings, fenced code blocks, URLs, paths, bullets, and
 * inline code are preserved after LLM compression. Errors indicate
 * structural violations that need targeted fixing; warnings are softer
 * discrepancies that don't block the compression.
 */

const fs = require('node:fs');

// ---------------------------------------------------------------------------
// Patterns (ported verbatim from validate.py)
// ---------------------------------------------------------------------------

const URL_REGEX = /https?:\/\/[^\s)]+/g;
const FENCE_OPEN_REGEX = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;
const HEADING_REGEX = /^(#{1,6})\s+(.*)/gm;
const BULLET_REGEX = /^\s*[-*+]\s+/gm;
// Crude but effective path detection — requires path prefix or internal slash
// Ported from validate.py PATH_REGEX (backslash escaping adjusted for JS regex literals)
const PATH_REGEX = /(?:\.\/|\.\.\/|\/|[A-Za-z]:\\)[\w\-/\\.]+|[\w\-\.]+[/\\][\w\-/\\.]+/g;

// ---------------------------------------------------------------------------
// ValidationResult
// ---------------------------------------------------------------------------

class ValidationResult {
  constructor() {
    this.isValid = true;
    this.errors = [];
    this.warnings = [];
  }

  addError(msg) {
    this.isValid = false;
    this.errors.push(msg);
  }

  addWarning(msg) {
    this.warnings.push(msg);
  }
}

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

/**
 * Extract all markdown headings as [{level, title}] pairs.
 */
function extractHeadings(text) {
  const headings = [];
  let m;
  const re = /^(#{1,6})\s+(.*)/gm;
  while ((m = re.exec(text)) !== null) {
    headings.push({ level: m[1], title: m[2].trim() });
  }
  return headings;
}

/**
 * Line-based fenced code block extractor.
 * Handles ``` and ~~~ fences with variable length (CommonMark: closing
 * fence must use same char and be at least as long as opening).
 * Supports nested fences.
 */
function extractCodeBlocks(text) {
  const blocks = [];
  const lines = text.split('\n');
  let i = 0;
  const n = lines.length;

  while (i < n) {
    const m = FENCE_OPEN_REGEX.exec(lines[i]);
    if (!m) { i++; continue; }

    const fenceChar = m[2][0];
    const fenceLen = m[2].length;
    const openLine = lines[i];
    const blockLines = [openLine];
    i++;
    let closed = false;

    while (i < n) {
      const closeM = FENCE_OPEN_REGEX.exec(lines[i]);
      if (
        closeM &&
        closeM[2][0] === fenceChar &&
        closeM[2].length >= fenceLen &&
        closeM[3].trim() === ''
      ) {
        blockLines.push(lines[i]);
        closed = true;
        i++;
        break;
      }
      blockLines.push(lines[i]);
      i++;
    }

    if (closed) {
      blocks.push(blockLines.join('\n'));
    }
    // Unclosed fences silently skipped — malformed markdown, not a validation failure
  }

  return blocks;
}

function extractUrls(text) {
  return new Set(text.match(URL_REGEX) || []);
}

function extractPaths(text) {
  return new Set(text.match(PATH_REGEX) || []);
}

function countBullets(text) {
  return (text.match(BULLET_REGEX) || []).length;
}

/**
 * Extract inline code snippets (excluding content inside fenced blocks).
 * Returns an array of strings (may contain duplicates — Counter equivalent).
 */
function extractInlineCodes(text) {
  // Strip fenced blocks first to avoid matching backticks inside them
  let stripped = text.replace(/^```[\s\S]*?^```/gm, '');
  stripped = stripped.replace(/^~~~[\s\S]*?^~~~/gm, '');
  const found = [];
  const re = /`([^`]+)`/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    found.push(m[1]);
  }
  return found;
}

/** Build a frequency map (like Python Counter) from an array. */
function counter(arr) {
  const map = new Map();
  for (const item of arr) {
    map.set(item, (map.get(item) || 0) + 1);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

function validateHeadings(orig, comp, result) {
  const h1 = extractHeadings(orig);
  const h2 = extractHeadings(comp);

  if (h1.length !== h2.length) {
    result.addError(`Heading count mismatch: ${h1.length} vs ${h2.length}`);
  }

  // Deep-equal comparison
  const same = h1.length === h2.length && h1.every((h, i) =>
    h.level === h2[i].level && h.title === h2[i].title
  );
  if (!same && h1.length === h2.length) {
    result.addWarning('Heading text/order changed');
  }
}

function validateCodeBlocks(orig, comp, result) {
  const c1 = extractCodeBlocks(orig);
  const c2 = extractCodeBlocks(comp);

  if (c1.length !== c2.length || c1.some((b, i) => b !== c2[i])) {
    result.addError('Code blocks not preserved exactly');
  }
}

function validateUrls(orig, comp, result) {
  const u1 = extractUrls(orig);
  const u2 = extractUrls(comp);

  const lost = [...u1].filter(u => !u2.has(u));
  const added = [...u2].filter(u => !u1.has(u));

  if (lost.length > 0 || added.length > 0) {
    result.addError(`URL mismatch: lost=${JSON.stringify(lost)}, added=${JSON.stringify(added)}`);
  }
}

function validatePaths(orig, comp, result) {
  const p1 = extractPaths(orig);
  const p2 = extractPaths(comp);

  const lost = [...p1].filter(p => !p2.has(p));
  const added = [...p2].filter(p => !p1.has(p));

  if (lost.length > 0 || added.length > 0) {
    result.addWarning(`Path mismatch: lost=${JSON.stringify(lost)}, added=${JSON.stringify(added)}`);
  }
}

function validateBullets(orig, comp, result) {
  const b1 = countBullets(orig);
  const b2 = countBullets(comp);

  if (b1 === 0) return;

  const diff = Math.abs(b1 - b2) / b1;
  if (diff > 0.15) {
    result.addWarning(`Bullet count changed too much: ${b1} -> ${b2}`);
  }
}

function validateInlineCodes(orig, comp, result) {
  const c1 = counter(extractInlineCodes(orig));
  const c2 = counter(extractInlineCodes(comp));

  const allKeys = new Set([...c1.keys(), ...c2.keys()]);
  const lost = [];
  const added = [];

  for (const k of c1.keys()) {
    if (!c2.has(k)) {
      lost.push(k);
    } else if (c2.get(k) < c1.get(k)) {
      lost.push(`${k} (lost ${c1.get(k) - c2.get(k)} of ${c1.get(k)} occurrences)`);
    }
  }
  for (const k of c2.keys()) {
    if (!c1.has(k)) added.push(k);
  }

  if (lost.length > 0) {
    result.addError(`Inline code lost: ${JSON.stringify(lost)}`);
  }
  if (added.length > 0) {
    result.addWarning(`Inline code added: ${JSON.stringify(added)}`);
  }
}

// ---------------------------------------------------------------------------
// Main validate function
// ---------------------------------------------------------------------------

/**
 * Validate that the compressed file preserves the structure of the original.
 *
 * @param {string} originalPath  Path to the original (backup) file.
 * @param {string} compressedPath  Path to the compressed file.
 * @returns {ValidationResult}
 */
function validate(originalPath, compressedPath) {
  const result = new ValidationResult();

  const orig = fs.readFileSync(originalPath, 'utf8');
  const comp = fs.readFileSync(compressedPath, 'utf8');

  validateHeadings(orig, comp, result);
  validateCodeBlocks(orig, comp, result);
  validateUrls(orig, comp, result);
  validatePaths(orig, comp, result);
  validateBullets(orig, comp, result);
  validateInlineCodes(orig, comp, result);

  return result;
}

module.exports = { validate, ValidationResult };
