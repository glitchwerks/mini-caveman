'use strict';
/**
 * detect.js — file-type gate and sensitive-path denylist
 *
 * Ported from Python: detect.py and compress.py is_sensitive_path().
 * Pure Node stdlib — no external dependencies.
 */

const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Sensitive-path denylist (ported from compress.py lines 24-56)
// Filenames and path components that almost certainly hold secrets or PII.
// Compressing them ships raw bytes to the Anthropic API — refuse BEFORE read.
// ---------------------------------------------------------------------------

// Basename regex: exact-match names or extensions known to hold secrets.
const SENSITIVE_BASENAME_RE = new RegExp(
  '^(' +
  '\\.env(\\..+)?' +
  '|\\.netrc' +
  '|credentials(\\..+)?' +
  '|secrets?(\\..+)?' +
  '|passwords?(\\..+)?' +
  '|id_(rsa|dsa|ecdsa|ed25519)(\\.pub)?' +
  '|authorized_keys' +
  '|known_hosts' +
  '|.*\\.(pem|key|p12|pfx|crt|cer|jks|keystore|asc|gpg)' +
  ')$',
  'i'
);

// Path components (directory names) that indicate secret-holding dirs.
const SENSITIVE_PATH_COMPONENTS = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.docker']);

// Name tokens: after stripping separators, if any of these appear → refuse.
// Normalise "api-key", "api_key", "api.key" → "apikey" before matching.
const SENSITIVE_NAME_TOKENS = [
  'secret', 'credential', 'password', 'passwd',
  'apikey', 'accesskey', 'token', 'privatekey',
];

/**
 * Returns true if the file path looks like it contains secrets or PII.
 * Gate is applied BEFORE any file content is read.
 *
 * @param {string} filePath  Absolute or relative path string.
 * @returns {boolean}
 */
function isSensitivePath(filePath) {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const parts = normalizedPath.split('/');
  const name = parts[parts.length - 1] || '';

  // 1. Basename regex test
  if (SENSITIVE_BASENAME_RE.test(name)) return true;

  // 2. Path component test (any directory segment)
  const lowerParts = parts.map(p => p.toLowerCase());
  for (const comp of SENSITIVE_PATH_COMPONENTS) {
    if (lowerParts.includes(comp)) return true;
  }

  // 3. Normalized name-token test
  // Strip separators so "api-key", "api_key", "api.key" all → "apikey"
  const normalized = name.toLowerCase().replace(/[_\-\s.]/g, '');
  for (const tok of SENSITIVE_NAME_TOKENS) {
    if (normalized.includes(tok)) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// File-type gate (ported from detect.py)
// ---------------------------------------------------------------------------

// Extensions that are natural language → compressible
const COMPRESSIBLE_EXTENSIONS = new Set(['.md', '.txt', '.markdown', '.rst', '.typ', '.typst', '.tex']);

// Extensions that are code/config → always skip
const SKIP_EXTENSIONS = new Set([
  '.py', '.js', '.ts', '.tsx', '.jsx', '.json', '.yaml', '.yml',
  '.toml', '.env', '.lock', '.css', '.scss', '.html', '.xml',
  '.sql', '.sh', '.bash', '.zsh', '.go', '.rs', '.java', '.c',
  '.cpp', '.h', '.hpp', '.rb', '.php', '.swift', '.kt', '.lua',
  '.dockerfile', '.makefile', '.csv', '.ini', '.cfg',
]);

// Extensions that are specifically config (subset of SKIP_EXTENSIONS)
const CONFIG_EXTENSIONS = new Set(['.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.env']);

// Code-line patterns used for extensionless-file detection (ported from detect.py)
const CODE_PATTERNS = [
  /^\s*(import |from .+ import |require\(|const |let |var )/,
  /^\s*(def |class |function |async function |export )/,
  /^\s*(if\s*\(|for\s*\(|while\s*\(|switch\s*\(|try\s*\{)/,
  /^\s*[\}\]\);]+\s*$/,
  /^\s*@\w+/,
  /^\s*"[^"]+"\s*:\s*/,
  /^\s*\w+\s*=\s*[{\[("']/,
];

function _isCodeLine(line) {
  return CODE_PATTERNS.some(p => p.test(line));
}

function _isJsonContent(text) {
  try { JSON.parse(text); return true; } catch (e) { return false; }
}

function _isYamlContent(lines) {
  let indicators = 0;
  const first30 = lines.slice(0, 30);
  for (const line of first30) {
    const s = line.trim();
    if (s.startsWith('---')) { indicators++; continue; }
    if (/^\w[\w\s]*:\s/.test(s)) { indicators++; continue; }
    if (s.startsWith('- ') && s.includes(':')) indicators++;
  }
  const nonEmpty = first30.filter(l => l.trim()).length;
  return nonEmpty > 0 && indicators / nonEmpty > 0.6;
}

/**
 * Classify a file as 'natural_language', 'code', 'config', or 'unknown'.
 *
 * @param {string} filePath
 * @returns {'natural_language'|'code'|'config'|'unknown'}
 */
function detectFileType(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (COMPRESSIBLE_EXTENSIONS.has(ext)) return 'natural_language';

  if (SKIP_EXTENSIONS.has(ext)) {
    return CONFIG_EXTENSIONS.has(ext) ? 'config' : 'code';
  }

  // Extensionless — inspect content
  if (!ext) {
    let text;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      return 'unknown';
    }

    const lines = text.split('\n').slice(0, 50);

    if (_isJsonContent(text.slice(0, 10000))) return 'config';
    if (_isYamlContent(lines)) return 'config';

    const nonEmpty = lines.filter(l => l.trim()).length;
    const codeLines = lines.filter(l => l.trim() && _isCodeLine(l)).length;
    if (nonEmpty > 0 && codeLines / nonEmpty > 0.4) return 'code';

    return 'natural_language';
  }

  return 'unknown';
}

/**
 * Returns true if the file should be compressed:
 * - is a real file
 * - does NOT end in .original.md (backup guard)
 * - is NOT a sensitive path
 * - is classified as natural_language
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function shouldCompress(filePath) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return false;
  } catch (e) {
    return false;
  }

  const name = path.basename(filePath);

  // Skip backup files
  if (name.endsWith('.original.md')) return false;

  // Refuse sensitive paths (checked here as well as in compress.js for defence-in-depth)
  if (isSensitivePath(filePath)) return false;

  return detectFileType(filePath) === 'natural_language';
}

module.exports = { isSensitivePath, shouldCompress, detectFileType };
