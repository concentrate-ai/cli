# Changelog

## 0.1.1

- **Claude models in Pi and OpenCode now use prompt caching.** They were sent
  through an endpoint where Concentrate does not cache Claude, so every turn was
  billed at the full input price. Installing this version fixes `cn pi`,
  `cn opencode`, and tools set up with `cn configure`.
- Pi keeps your MCP servers, extensions, and other settings under `cn pi`.
- Pi and OpenCode show cost estimates with Concentrate prices.
- `cn configure` stores the key in Pi and Codex directly, fixing Pi's
  intermittent `credential-helper` errors. Installing this version converts tools
  you set up with 0.1.0 for you.
- Claude Code keeps MCP servers you add during a `cn claude` session, and stays
  signed in to MCP servers between runs.
- New `cn update`, `cn refresh`, and `cn changelog`. `cn` offers new versions
  when you start it, and installing refreshes the tools you configured.
- `cn logout` also removes the key copies in configured tools.

## 0.1.0

- First beta: Claude Code, OpenCode, and Pi through one Concentrate key; Codex
  with OpenAI models; Cursor desktop in progress.
