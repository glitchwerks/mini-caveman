# mini-caveman

A minimized, Claude Code-only extraction of the [caveman](https://github.com/JuliusBrussee/caveman) toolkit by Julius Brussee. Strips all non-Claude runtimes and external dependencies down to the surface that matters: terse compressed responses in Claude Code, with no npm install, no pip install, no API keys beyond what you already have.

Security-audited for work-machine use. See [`docs/security-audit.md`](docs/security-audit.md).

---

## What it does

Activates "caveman mode" on every session start. Claude replies with terse, technically accurate output — dropping articles, filler, pleasantries, and hedging — while keeping code blocks, error strings, paths, and commands exactly as-is.

Typical output token reduction: **65% (measured)**. Technical accuracy: unchanged. Anything persisted outside chat — code, comments, commits, docs, issue/PR text, memory files, third-party messages — is always written in normal prose (`/caveman-compress` exempt).

Safety valve: Claude automatically drops caveman for security warnings, irreversible-action confirmations, and any step where fragment order could be misread.

---

## Commands

| Command | What it does |
|---|---|
| `/caveman` | Activate full mode (default) |
| `/caveman lite` | Drop filler; keep sentence structure and articles |
| `/caveman full` | Drop articles, filler, pleasantries, hedging; fragments OK |
| `/caveman ultra` | Maximum compression; standard acronyms only, no invented abbreviations, no causal arrows |
| `/caveman wenyan-lite` | Classical Chinese register, light compression |
| `/caveman wenyan` | Full 文言文; 80–90% character reduction |
| `/caveman wenyan-ultra` | Extreme classical compression |
| `/caveman off` | Deactivate for the session |
| `normal mode` | Natural language — same as `/caveman off` |
| `/caveman-help` | One-shot reference card |
| `/caveman-compress <file>` | Rewrite a Markdown file into caveman prose (input-token saver) |

---

## /caveman-compress

Rewrites a Markdown memory file (e.g. `CLAUDE.md`, notes, todos) into compressed caveman prose so every future session that loads that file pays fewer input tokens.

- Saves a `<name>.original.md` backup before overwriting
- Preserves code blocks, inline code, URLs, file paths, commands, headings, and tables exactly — only natural-language prose is compressed
- Runs the rewrite in an **isolated headless `claude --print` session** so the current session never ingests the file contents
- Built-in denylist refuses files with sensitive names (`.env`, `credentials.*`, `id_rsa`, `*.pem`, etc.) before any read
- Note: the target file's prose is sent to Anthropic via the `claude` CLI — the same endpoint Claude Code already uses. Do not point it at restricted content.

---

## Subagents (cavecrew)

Three terse subagent presets that return compressed output. Because subagent tool results are injected verbatim into main context, compressed output extends how far the context budget goes across a long session.

| Agent | Purpose |
|---|---|
| `cavecrew-investigator` | Read-only code locator — find symbols, callers, usages |
| `cavecrew-builder` | Surgical editor for 1–2 file changes when the site is already known |
| `cavecrew-reviewer` | Diff/file reviewer; returns structured findings, not prose |

Use `/cavecrew` (the skill) to decide when delegation makes sense vs. working in the main thread.

---

## Cavecrew model overrides

Pin an individual cavecrew subagent to a specific model, independent of the session's default model. Applied on every session start by the same hook that activates caveman mode — it patches the `model:` frontmatter field of the matching agent file in `agents/` before that agent can be invoked.

**Environment variables:**

| Env var | Overrides |
|---|---|
| `CAVECREW_REVIEWER_MODEL` | `cavecrew-reviewer` |
| `CAVECREW_BUILDER_MODEL` | `cavecrew-builder` |
| `CAVECREW_INVESTIGATOR_MODEL` | `cavecrew-investigator` |

Set to any model value Claude Code accepts in agent frontmatter (e.g. `haiku`). `cavecrew-reviewer` and `cavecrew-investigator` ship pinned to `haiku`; `cavecrew-builder` has no `model:` line and inherits the session's default model — so it's the one an override actually changes. Example, pin the builder subagent to Haiku:

```bash
export CAVECREW_BUILDER_MODEL=haiku
```

- The value is trimmed and written into the target agent file's `model:` frontmatter on disk (`agents/cavecrew-<name>.md`) — this **persists** across sessions, even after the env var is unset
- To revert, set the env var back to the original value, or restore the file (e.g. `git checkout agents/cavecrew-builder.md`)
- Unset, empty, or whitespace-only values cause no write on that run — but they don't undo a previous override

---

## Default mode configuration

Default is `full`. Override via environment variable or config file.

**Environment variable** (highest priority):
```bash
export CAVEMAN_DEFAULT_MODE=lite
```

**Config file:**
```json
// ~/.config/caveman/config.json  (macOS/Linux)
// %APPDATA%\caveman\config.json  (Windows)
{ "defaultMode": "lite" }
```

Set `"off"` to disable auto-activation on session start while keeping manual `/caveman` available.

Resolution order: `CAVEMAN_DEFAULT_MODE` env var > config file > `full`.

---

## Dependencies

None beyond what Claude Code already ships.

- Hooks and the compress script are pure Node stdlib — Node ships with Claude Code
- `/caveman-compress` additionally requires the `claude` CLI on PATH (already present if you are using Claude Code)
- No `npm install`, no `pip install`, no additional API keys

---

## Install

**Option 1 — local marketplace (recommended):**
```
/plugin marketplace add /i/ai/claude/mini-caveman
/plugin install mini-caveman
```

**Option 2 — plugin dir flag at launch:**
```bash
claude --plugin-dir /i/ai/claude/mini-caveman
```

After install, start a new session and say "talk like caveman" or run `/caveman`. Stop with "normal mode".

---

## Repository layout

```
.claude-plugin/          Plugin manifest (plugin.json, marketplace.json)
hooks/                   Two Claude Code hooks + shared modules
  hooks.json             Hook wiring (SessionStart + UserPromptSubmit)
  caveman-activate.js    SessionStart — injects caveman mode on session open
  caveman-mode-tracker.js  UserPromptSubmit — tracks mode changes per turn
  caveman-config.js      Shared config resolver (env var, config file, default)
  cavecrew-model-overrides.js  Per-agent model overrides via CAVECREW_*_MODEL env vars, applied on SessionStart
  package.json           Marks hooks/ as CommonJS
skills/
  caveman/               Core mode skill
  caveman-help/          One-shot reference card
  caveman-compress/      Markdown file compression (pure Node, isolated session)
    scripts/             compress.js, detect.js, validate.js + tests
  cavecrew/              Decision guide for subagent delegation
agents/
  cavecrew-investigator.md
  cavecrew-builder.md
  cavecrew-reviewer.md
docs/
  security-audit.md      Full audit report (0 critical, 0 high)
```

---

## What was removed from upstream

This build strips everything outside the Claude Code surface:

| Removed | Reason |
|---|---|
| All non-Claude runtimes (Codex, Gemini, Cursor, Windsurf, Cline, opencode, OpenClaw, etc.) | Claude Code only |
| Multi-agent installer | Not needed for single-runtime install |
| `caveman-shrink` MCP server | Separate process; no benefit here |
| `caveman-stats` + statusline badge | Read `~/.claude` session transcripts and mutate `settings.json`; dropped for work privacy |
| `caveman-commit` / `caveman-review` | Impose their own commit-message and review-comment formats that can conflict with workplace conventions |

---

## Security

Audited for work-machine use. Findings summary from [`docs/security-audit.md`](docs/security-audit.md):

- Zero unintended network egress; only documented `claude --print` spawn on compress
- No shell injection — file contents pass via stdin, never on the command line
- Sensitive-path denylist blocks credentials/keys/secrets before any file read
- Symlink-safe flag file handling with `O_NOFOLLOW`, uid verification, 64-byte cap, and `VALID_MODES` whitelist
- No `settings.json` mutation
- Verdict: 0 critical, 0 high findings

---

## License

MIT. Copyright (c) 2026 Julius Brussee.

This is a derived, minimized build. The upstream project is [caveman](https://github.com/JuliusBrussee/caveman) by Julius Brussee, also MIT-licensed. The `LICENSE` file in this repository is the upstream license reproduced verbatim as required by its terms.
