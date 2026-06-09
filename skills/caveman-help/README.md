# caveman-help

Quick-reference card. One shot, no mode change.

## What it does

Prints a cheat sheet of all caveman modes, skills, deactivation triggers, and how to set the default mode via env var or config file. One-shot display — does not flip the active mode, write flag files, or persist anything. Use when you forget the slash commands.

## How to invoke

```
/caveman-help
```

Also triggers on "caveman help", "what caveman commands", "how do I use caveman".

## Example output

```
Modes:
  /caveman              full (default)
  /caveman lite         lighter
  /caveman ultra        extreme
  /caveman wenyan       classical Chinese

Skills:
  /caveman-compress     compress .md files to caveman prose

Subagents:
  cavecrew-investigator read-only locator
  cavecrew-builder      surgical 1-2 file editor
  cavecrew-reviewer     diff reviewer

Deactivate:
  "stop caveman" or "normal mode"
```

## See also

- [`SKILL.md`](./SKILL.md) — full reference card
- [Caveman README](../../README.md) — repo overview
