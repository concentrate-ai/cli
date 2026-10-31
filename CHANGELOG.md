# Changelog

## 0.1.1

- Pi keeps your MCP servers, extensions, and other settings under `cn pi`.
- Pi and OpenCode show cost estimates with Concentrate prices.
- `cn configure` stores the key in Pi and Codex directly, fixing Pi's
  intermittent `credential-helper` errors. Run `cn refresh` once if you set them
  up with 0.1.0.
- Claude Code keeps MCP servers you add during a `cn claude` session, and stays
  signed in to MCP servers between runs.
- New `cn update` and `cn refresh`. `cn` offers new versions when you start it.
- `cn logout` also removes the key copies in configured tools.

## 0.1.0

- First beta: Claude Code, OpenCode, and Pi through one Concentrate key; Codex
  with OpenAI models; Cursor desktop in progress.
