# Security

- **Session credentials** reach tools through the child environment and Claude’s environment-based helper. Keys are never placed in argv (visible in `ps`). The saved key lives in private `credentials.json` (mode `0600`). Keys and model IDs with spaces or control characters are refused, and errors never repeat them.
- **Claude Code** reads credentials from several places, and anything it finds is sent to the gateway. Under `cn` it ignores all of them:
  - These are removed from its environment: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_CUSTOM_HEADERS`, `CLAUDE_CODE_OAUTH_TOKEN`, and the Bedrock/Vertex/Foundry switches.
  - The same names are blanked in the settings `cn` passes, which outrank your own settings files.
  - The key arrives only through an `apiKeyHelper` that reads it from the child's environment. This means your own `apiKeyHelper` or settings `env` block can't send another credential to Concentrate.
- **The model catalog is untrusted input.** Names are stripped of terminal control characters (no escape-sequence injection), and IDs that could pass for a command-line flag are dropped.
- **Remembering a model** only reads the session `cn` started:
  - Claude and Pi get a pinned session ID.
  - For Codex, a session counts only if it was created during the run, in the same directory, on the Concentrate provider.
  - Scripted runs, resumed sessions, and runs where you gave the tool a model flag are never remembered.
  - Remembering can't change the tool's exit code.
- **The terminal** is restored if a menu fails, or if `cn` is interrupted or killed mid-prompt.

Not prevented: the coding agent itself runs commands with that environment, so a command it runs can read the key. That is true of any environment-based setup. Codex filters `*KEY*` variables from its shell by default.

## Permanent configuration

Claude, Codex, and Pi use command-backed helpers that resolve the saved key at request time. OpenCode references a separate private key file through its native file substitution; `cn key` rotates that file when it is still managed by cn. `cn logout` resets OpenCode’s saved integration.

Restore records can contain the previous tool configuration, including secrets that were already there. They are stored in private directories (mode `0700`) as files restricted to mode `0600`. Reset removes a completed restore record; if user edits require keeping files, it retains the record for recovery and reports the edits. Native Configure does not change shell startup files or replace tool executables.

Claude’s permanent capability plugin is prepared with the installed client in an isolated home using a local marketplace. The managed plugin contains model metadata and code, not API keys. Reset restores cn-owned settings and plugin registrations while preserving other plugins and later edits. Higher-priority managed or project configuration can still affect the client.

## Cursor desktop

Cursor is a static-key integration: cn copies the saved Concentrate key into
Cursor's local SQLite settings database. Cursor's servers receive the key and
prompts before forwarding requests to Concentrate. The Configure screen explains
this. cn does not inject custom identification headers into Cursor.

The original credential rows and prior settings are stored in a namespaced
restore row in that same database. The database and existing WAL/SHM files are
restricted to mode `0600`; these records can contain secrets. SQL is passed over
stdin, with escaped literals, never through a shell or secret-bearing command
arguments. Settings and restore data commit atomically after comparing the rows
read earlier. Symlinks and unknown settings formats are refused.

Cursor must be closed during setup, key rotation, and Reset. If its credential
was edited or encrypted after Configure, Reset preserves it and reports that it
needs review. Logout removes cn's saved key only after attempting to reset the
native static-key integrations; preserving an edited credential is reported and
does not revoke that credential at the API.
