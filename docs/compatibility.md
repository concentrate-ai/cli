# Tool compatibility

## Models

Refresh the Claude Code compatible catalog with `cn models claude --refresh --limit 200`.

Each tool's own model picker lists Concentrate models while it runs under `cn`. Claude and Codex can remember an in-session model change as the next cn default by reading the session files; they save only a recognized model that differs from the launch model. Pi and OpenCode do not save in-session selections as cn defaults. Codex's reader is untested against a real install.

Claude Code's picker includes every model marked Claude Code compatible in the catalog, with the selected model first. There is no shortlist limit.

For custom model IDs such as GLM, `cn claude` supplies the catalog's context limit through `CLAUDE_CODE_MAX_CONTEXT_TOKENS`. A temporary `cn-context` mod updates that value when you switch models, and checks it again before prompts and commands such as `/context` and `/compact`. Native Claude IDs and `[1m]` IDs keep Claude's own handling; unknown or missing catalog data clears the previous automatic limit. An explicit environment value takes priority and remains fixed for that session. This needs Claude Code 2.1.287+ with mods enabled (no `--bare`, `--safe-mode`, or `disableAllHooks`). The mod is loaded only for that launch and is removed when it exits; it does not change your saved Claude settings. Context sizing itself leaves the auto-compaction preference unchanged. See [Claude's custom-model context documentation](https://code.claude.com/docs/en/model-config#correct-the-window-for-a-gateway-or-custom-model-id).

The same mod also synchronizes output and reasoning compatibility for custom models:

- Output requests keep Claude Code's 32K default, capped at the selected model's catalog limit. An explicit `CLAUDE_CODE_MAX_OUTPUT_TOKENS` preference is honored up to that limit. Native or unknown models restore the original preference.
- Models explicitly marked as not supporting reasoning have the `thinking` parameter omitted. An explicit `CLAUDE_CODE_DISABLE_THINKING` override is preserved.
- At each request, supported named effort levels are checked for that request's model. An unsupported selection maps down to a supported level, or up to the lowest supported level when none is below it. cn uses the levels common to the catalog's provider entries.

Claude Code still owns the effort picker UI: cn does not hide unsupported rows. Its request hook cannot express `none` or `minimal` effort, so those cases remain subject to the gateway's existing effort normalization. This does not add image/tool UI gating or change the auto-mode classifier. Context, output, and thinking overrides are process-wide; mixed custom-model subagents still need separate compatibility validation.

Run `node research/capability-switch-probe.mjs` to verify outgoing fields with the real Claude Code client against a localhost mock. It uses a dummy key and an isolated home, exercises repeated model switches, and makes no paid calls.

## Session history

Claude Code and Codex can remember model changes from the session launched by cn. Scripted runs, resumed sessions, and explicit forwarded model flags are not remembered. Codex session reading has not been verified against a real Codex installation. Pi and OpenCode model recall is not supported.

Pi manages its own sessions in its normal directory, including `--session-dir` and `--no-session` overrides. Older cn sessions remain in `pi-sessions/` and can be opened by their full file path.

## OpenCode v1 and v2

cn detects OpenCode's generation and supplies its native configuration shape. v1 receives `provider`, `modalities`, and reasoning variants; v2 receives `providers`, `capabilities`, and explicit variants. Both receive each model's known context and output limits. Explicit v2 reasoning variants also support releases that do not yet read `capabilities.reasoning`. Unknown limits are omitted, leaving the tool's own fallback behavior.

OpenCode v2 needs `--standalone` so it uses a private server that reads this launch's configuration. v1 rejects that flag, so cn adds it only when the installed client advertises it or reports version 2+. `cn doctor` shows the installed version.

Remembering a model you switched to inside OpenCode is not supported, because OpenCode keeps sessions in a database.

## Classifier behavior

For GLM sessions, cn selects the same GLM model for the auto-mode classifier unless you override `CLAUDE_CODE_AUTO_MODE_MODEL`. This setting is chosen at launch and does not follow in-session model switches. The experiments and limitations are documented in [research notes](../research/README.md).

## Pi model capabilities

Pi receives per-model `contextWindow`, `maxTokens`, input modalities, and reasoning support. When the catalog supplies reasoning effort levels, cn maps those into Pi's `thinkingLevelMap`: unsupported levels are disabled, `none` maps to Pi's `off`, and `max` remains selectable only when advertised. Missing effort metadata leaves Pi's built-in behavior in place. These are model definitions, so each selection uses that model's own values.

## Codex model capabilities

cn reads the installed Codex client's bundled catalog with `codex debug models --bundled`, uses its standard `gpt-5.5` entry (or another standard entry) as a template, and passes the resulting file through `model_catalog_json`. This preserves the installed client's instructions, tool configuration, and catalog fields instead of inventing a schema. If no suitable template is available, catalog preparation fails and the launcher warns before using the normal picker.

The generated catalog replaces the model ID, context window, image support, and advertised reasoning levels. Context expansion is capped at the advertised window; OpenAI-specific response transport, hosted search, and speed tiers are disabled for Concentrate. The default effort prefers `medium`, then `low`, then the first supported level. Explicitly non-reasoning models have no reasoning choices. Missing context uses the bundled template's fallback; missing effort metadata offers no invented levels.

cn validates this catalog with the installed Codex client before using it. If validation fails, it warns and falls back to Codex's normal picker. Codex 0.162.1 accepts and preserves these fields. No supported per-model output-token cap was established for this client, so cn does not claim to enforce one.

## Permanent native configuration

`cn configure <tool>` records the previous values, writes native configuration, and leaves the original executable and shell profile in place. `cn reset <tool>` restores the original file bytes when untouched; when a file was edited, it restores fields still matching cn’s values and reports the edits it preserved. Changed helper/catalog files are retained rather than deleted. Restore records containing originals are private.

- **Claude Code:** writes routing, a saved-key helper, the default model, and the model picker to `settings.json`. Configure also installs the existing capability mod through a private local marketplace. The installed Claude CLI prepares its plugin registration in an isolated directory; cn saves only that plugin’s native registration and files, with restore records. The mod follows context, output, and reasoning compatibility during direct launches as it does during `cn claude`. Explicit environment preferences are read at session startup. Session launches disable the saved copy and load a fresh mod from the current catalog. This needs Claude 2.1.287+ and mods enabled. It does not configure Claude Desktop gateway profiles. Seeding Claude’s cache fields alone did not apply the expected custom-model windows in the tested headless session, so cn uses a mod instead.
- **Codex:** writes a `concentrate` provider (the same name `cn codex` launches use, so threads resume in either mode) with command-backed authentication and a persistent validated model catalog into `config.toml`. The CLI and desktop app share that file, but existing threads, selected profiles, and managed configuration can override defaults; cn does not migrate threads or restart the desktop app.
- **OpenCode:** writes the installed generation’s provider shape and model metadata to the global JSON/JSONC configuration, and references a private credential file using OpenCode’s `{file:...}` substitution. `cn key` refreshes the native key when it still matches cn’s previous value; `cn logout` resets that integration. Restart any background OpenCode server after Configure or Reset.
- **Pi:** writes the default provider/model to `settings.json` and the model catalog to `models.json`, with a command-backed key resolver. The existing providers and `auth.json` are preserved. This uses Pi’s native custom-provider configuration.

The catalog is refreshed when Configure runs. Model changes made through `cn model` also attempt to refresh an already configured tool. Direct client sessions may save their own model choices. External environment variables and higher-priority project/managed settings can override native defaults, and Reset leaves those independently managed sources alone.

## Coding tool identification

Both `cn` launches and permanent Configure add a static `X-App` header to the
Concentrate connection: `codex`, `opencode`, or `pi`. Existing values are
preserved, including differently capitalized header names. Claude Code keeps
its own built-in identification header. No user or session information is added.
Reset uses the normal restore record to remove cn's configuration changes.
The gateway must read this header before it can use it for reporting or routing.

## Cursor desktop

`cn configure cursor` configures the Cursor desktop editor, following the native
setup. It requires an initialized Cursor profile,
a saved Concentrate API key, `sqlite3`, and `pgrep`. Quit Cursor first; cn checks
that it is closed instead of terminating or reopening the app.

cn updates `useOpenAIKey`, `openAIBaseUrl`, `aiSettings.userAddedModels`, and
`aiSettings.modelOverrideEnabled` in Cursor's `User/globalStorage/state.vscdb`.
The base URL is `https://api.concentrate.ai/v1`; Concentrate's Chat Completions
route already adapts Cursor's flat tools and `tool_choice: validated` format.
Only catalog models marked as supporting tool calls are added. Existing custom
models and disabled-model preferences are kept. Choose models inside Cursor;
cn does not set their context windows, output caps, or reasoning controls.
The catalog is currently public, not filtered by account/key policies.

Cursor stores a static API key and sends it, along with requests, through its own
servers before reaching Concentrate. There is no credential-helper integration.
Tab completions remain on Cursor's models, and the setup does not cover the
separate Cursor CLI or guarantee routing of Auto/Composer features. Custom
`X-App` injection is not implemented for Cursor.

Settings, credentials, and a restore record are changed together in one SQLite
transaction. A concurrent change aborts the transaction. Reset restores saved
values that still match cn's changes, preserving later edits and unrelated rows.
It restores settings values, not the database's original bytes. If Cursor has
encrypted or replaced the key, cn preserves it because ownership cannot be
verified and reports that it needs review in Cursor's settings. A fresh explicit
Configure after Reset uses the preserved state as its new baseline.

`cn key` refreshes an unchanged managed key while Cursor is closed. Logout and
global Reset include Cursor's integration; a running app blocks those operations
rather than leaving an undisclosed native credential copy. Encrypted or edited
credentials are preserved and reported. Windows setup is not supported; Linux
editor testing remains outstanding.

Validation covers fixture databases and a Cursor-format gateway request. A full
Cursor desktop session has not been tested on this machine.
