'use strict';

const fs = require('fs');
const path = require('path');

const AGENT_ENV_MAP = [
  {
    envVar: 'CAVECREW_REVIEWER_MODEL',
    file: 'agents/cavecrew-reviewer.md',
  },
  {
    envVar: 'CAVECREW_BUILDER_MODEL',
    file: 'agents/cavecrew-builder.md',
  },
  {
    envVar: 'CAVECREW_INVESTIGATOR_MODEL',
    file: 'agents/cavecrew-investigator.md',
  },
];

const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

function resolvePluginRoot(hookDir) {
  return path.resolve(hookDir, '..');
}

function patchFrontmatterModel(content, modelValue) {
  if (
    typeof modelValue !== 'string' ||
    !modelValue.trim() ||
    CONTROL_CHARS.test(modelValue)
  ) {
    return content;
  }

  if (typeof content !== 'string' || !content.startsWith('---')) {
    return content;
  }

  const closingLfIndex = content.indexOf('\n---', 3);
  if (closingLfIndex === -1) {
    return content;
  }

  const closingIndex =
    closingLfIndex > 0 && content[closingLfIndex - 1] === '\r'
      ? closingLfIndex - 1
      : closingLfIndex;
  const fmRaw = content.slice(0, closingIndex);
  const after = content.slice(closingIndex);
  const eol = fmRaw.includes('\r\n') ? '\r\n' : '\n';
  const modelLine = /^model:[ \t]*[^\r\n]*(?=\r?$)/m;
  const toolsLine = /^tools:[ \t]*[^\r\n]*(?=\r?$)/m;
  const replacement = `model: ${modelValue}`;

  if (modelLine.test(fmRaw)) {
    const patchedFmRaw = fmRaw.replace(modelLine, replacement);
    return patchedFmRaw === fmRaw ? content : patchedFmRaw + after;
  }

  if (toolsLine.test(fmRaw)) {
    return fmRaw.replace(toolsLine, `$&${eol}${replacement}`) + after;
  }

  return fmRaw + eol + replacement + after;
}

function applyOverrides(pluginRoot, env = process.env) {
  try {
    for (const { envVar, file } of AGENT_ENV_MAP) {
      let rawValue;
      let modelValue;

      try {
        rawValue = env[envVar];
        if (!rawValue) {
          continue;
        }

        modelValue = rawValue.trim();
        if (!modelValue || CONTROL_CHARS.test(modelValue)) {
          continue;
        }
      } catch (e) {
        continue;
      }

      let agentPath;
      let content;
      try {
        agentPath = path.join(pluginRoot, file);
        content = fs.readFileSync(agentPath, 'utf8');
      } catch (e) {
        continue;
      }

      const patched = patchFrontmatterModel(content, modelValue);
      if (patched === content) {
        continue;
      }

      try {
        fs.writeFileSync(agentPath, patched, 'utf8');
      } catch (e) {}
    }
  } catch (e) {}
}

module.exports = {
  resolvePluginRoot,
  patchFrontmatterModel,
  applyOverrides,
  AGENT_ENV_MAP,
};
