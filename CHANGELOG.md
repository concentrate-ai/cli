# Changelog

## 0.1.2 (2026-11-01)

- **Full prompt caching for Claude in Pi and OpenCode.** Claude models now go
  through Concentrate's Messages endpoint, where the cache grows with the
  conversation. On the Responses endpoint the cache fell behind during long
  tool loops, so earlier tool results were billed again at the cache-write
  price. On a long agent task this took the cache hit rate from about 40% to
  over 80%. Other models stay on Responses, where they already cache well.
- Pi and OpenCode cost estimates use each model's standard price. 0.1.1 took
  the first price listed, which for some models (such as Claude Opus 5.5) is
  the fast tier, so estimates showed double. Pi also gets the higher price for
  very long inputs where a model has one. Billing was never affected.
- `cn changelog` and the notes shown after `cn update` work in installed copies.

## 0.1.1 (2026-11-01)

- **Claude models in Pi and OpenCode now use prompt caching.** `cn` set both up
  on Chat Completions, where Concentrate does not cache Claude, so every turn was
  billed at the full input price. Both now use the Responses API, as in
  Concentrate's Pi guide. Installing this version fixes `cn pi`, `cn opencode`,
  and tools set up with `cn configure`.
- `cn claude` keeps Claude's prompt cache warm between launches. Without a
  `~/.claude.json` of your own, each launch looked like a new device, so resumed
  sessions re-sent the whole prompt at the cache-write price.
- Pi keeps your MCP servers, extensions, and other settings under `cn pi`.
- Pi and OpenCode show cost estimates with Concentrate prices.
- `cn configure` stores the key in Pi and Codex directly, fixing Pi's
  intermittent `credential-helper` errors. Installing this version converts tools
  you set up with 0.1.0 for you.
- New `cn update`, `cn refresh`, and `cn changelog`. `cn` offers new versions
  when you start it, and installing refreshes the tools you configured.
- `cn logout` also removes the key copies in configured tools.

## 0.1.0

- First beta: Claude Code, OpenCode, and Pi through one Concentrate key; Codex
  with OpenAI models; Cursor desktop in progress.
