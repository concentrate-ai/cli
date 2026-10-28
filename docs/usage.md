# Usage

Details for launching, resuming, configuring, and managing tools with `cn`.
For what is supported today, see the [README](../README.md).

## Launch a tool

```sh
cn                              # Open the interactive launcher
cn claude                       # Start Claude Code
cn codex                        # Start Codex
cn opencode                     # Start OpenCode
cn pi                           # Start Pi
```

Pass tool-specific arguments after `--`:

```sh
cn codex -- exec "Say hello"
cn opencode -- run "Say hello"
```

## Resume a conversation

Exit the agent, then run the resume command from the same project directory:

```sh
cn claude resume <session-id>
cn codex resume <session-id>
cn opencode --session <session-id>
cn pi resume <session-id-or-path>
```

For Claude, Codex, and Pi, omit the ID to pick a conversation. For OpenCode,
select Resume and then OpenCode in the `cn` launcher to pick a saved session,
or use `cn opencode --session <id>` or `cn opencode --continue` for the latest.
You can also use `cn <tool> continue` for the most recent conversation.
A resumed conversation starts on the tool's cn default model (`cn model <tool>`), not
necessarily the model it last used. Use `cn <tool> --model <model-id> resume <session-id>`
to choose another one. For Codex, `continue` and the picker list interactive sessions
only; add `--include-non-interactive` to include scripted runs and subagent threads.

Use the same OS account and configuration directory that saved the session.
For Claude, `cn` uses a temporary copy of your user profile while sharing its
project session directory. Model changes inside `cn claude` therefore do not
change the default model in your ordinary Claude user settings. Claude itself
chooses how to restore a session's last model when you later resume it normally;
if it does not recognize that model, it falls back to its normal default.
When Claude exits normally, cn removes stale gateway request identifiers from
the session metadata so Claude's native cache diagnostics can skip them. The
conversation remains shared, and a private backup is saved in
`claude-session-backups/` under cn's configuration directory. Sessions open in
another Claude process are not changed.
Codex's picker includes sessions started with other providers. Pi uses its normal
session directory and its own session picker; explicit `--session-dir` overrides
are respected. Older sessions created under cn's `pi-sessions/` directory remain
there and can be opened with `cn pi resume <full-session-file-path>`.
OpenCode v2 uses its model-switch API
to select Concentrate before opening the saved session. OpenCode v1 uses its
native model flag.

The first time you run `cn codex`, cn offers to add a Concentrate provider to
`~/.codex/config.toml` so plain `codex resume` can reopen conversations started
through `cn`. It adds only that provider: your default model and login are
unchanged, and `cn reset codex` removes it. If you decline, resume with
`cn codex resume <session-id>`.

`cn codex` starts Codex with `--no-daemon` (when your Codex supports it), so its
shared background server does not report a closed conversation as open elsewhere.
cn does not close other Codex sessions or change your login.

You can resume a locally saved conversation after reaching a subscription's
usage limit. New model requests use your Concentrate API key and API billing;
your subscription login stays saved. Resuming sends the conversation context
needed for the next request through Concentrate. This continues a session in
the same agent; it does not transfer conversations between different agents.
If you change models, choose one that supports the conversation's inputs and
has enough context capacity for its history.

## Models and providers

Concentrate automatically selects the provider for every tool. Model pickers
show one entry per model, without separate provider variants.

Codex is limited to OpenAI models (`gpt-*`, `o<n>`) for now, defaulting to
`gpt-6.1-terra`. A saved non-OpenAI default falls back to that model, and
`cn codex --model <non-OpenAI id>` is refused.

```sh
cn model claude                 # Change Claude Code's default model
cn models pi --search deepseek  # Search Pi-compatible models
cn models --refresh             # Refresh the model catalog
```

For custom models in Claude Code, cn updates context limits, output caps, and
supported reasoning effort as models change. This requires Claude Code 2.1.287+
with mods enabled. See [tool compatibility](docs/compatibility.md) for details.

## Configure a tool permanently

To make a tool’s normal command use Concentrate, open `cn`, choose **Configure**,
then select the tool. **Reset** is available directly on the same home menu. You can also run:

```sh
cn configure claude
cn configure codex
cn configure opencode
cn configure pi
cn configure cursor             # Cursor desktop; quit the app first
```

Save your key with `cn key` first. Configuration writes to the tool’s own settings;
it does not replace its executable or change your shell profile. Restart the tool
afterward. Run Configure again to refresh its saved model catalog.

For Cursor desktop, install and open Cursor once, then quit it before Configure or
Reset. Select models in Cursor afterward. Cursor stores your Concentrate key and
sends requests through Cursor’s servers; Tab completions still use Cursor’s models.
Cursor setup requires `sqlite3` and `pgrep` (included with macOS). It configures the
desktop editor, not the Cursor CLI.

To restore the settings from before Configure:

```sh
cn reset claude                 # Or codex, opencode, pi, cursor
```

Reset preserves settings you edited afterward and reports what it kept. Shell
variables you set separately still apply. See [tool compatibility](docs/compatibility.md)
for differences between permanent configuration and a session launched through `cn`.

## Commands

| Command               | Description                                                     |
| --------------------- | --------------------------------------------------------------- |
| `cn settings`         | Open interactive settings                                       |
| `cn configure <tool>` | Save Concentrate in a tool’s native settings                    |
| `cn reset <tool>`     | Restore that tool’s previous settings                           |
| `cn setup`            | Set up your API key                                             |
| `cn config`           | Show key status, default models, and routing status             |
| `cn key`              | Replace the saved API key                                       |
| `cn logout`           | Remove the saved API key                                        |
| `cn doctor`           | Check tool installations and key status                         |
| `cn doctor <tool>`    | Test a tool's API route with a live request                     |
| `cn reset`            | Restore configured tools and remove cn’s key, models, and cache |
| `cn --help`           | Show all commands and options                                   |

## Configuration

Settings and credentials are stored in `~/.config/concentrate-cli/`, or under
`$XDG_CONFIG_HOME/concentrate-cli` when set. Use `CN_CONFIG_HOME` to choose another
directory. Credential and settings files are restricted to your user.

Launching through `cn` applies session settings. Permanent configuration is a
separate action, with private restore records stored under `tool-setups/`. See [security](docs/security.md) for credential handling.
