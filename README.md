# Concentrate CLI

One API key for Claude Code, Codex, OpenCode, and Pi. Launch your coding tools
through Concentrate to manage model access and track usage in one place.
You can also configure the Cursor desktop editor to use Concentrate.

For **macOS and Linux**. Requires **Node.js 18.18+**, a Concentrate API key,
and the coding tools you want to use installed on your `PATH`.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/concentrate-ai/cli/main/install.sh | bash
cn
```

The installer downloads the latest built release, verifies its SHA-256 checksum,
and installs `cn` in `~/.local/bin`. Node.js 18.18+ is required; npm is not needed
for release installs. It preserves saved credentials and tool settings on updates.
Rerun the same command to update.

To install a particular release:

```sh
curl -fsSL https://raw.githubusercontent.com/concentrate-ai/cli/main/install.sh | CN_INSTALL_VERSION=0.1.1 bash
```

If `~/.local/bin` is not on your `PATH`, the installer prints the line to add to
your shell profile.

To install from source instead, clone this repository (npm is needed to compile
the TypeScript code):

```sh
git clone https://github.com/concentrate-ai/cli.git
cd cli
npm ci
./install.sh
```

`cn` opens a full-screen workspace for launching tools, Configure, Reset, Settings,
Models, and Doctor. Quitting restores your shell without leaving menus in its
scrollback. The layout adjusts when you resize the terminal.
The Cursor desktop row opens its Configure and Reset controls.
Settings lets you choose each tool’s default model and save or replace your API key.
Launching a tool without a key starts setup. You can also use an existing
`CONCENTRATE_API_KEY` environment variable.

Actions return to the menu when finished. Doctor shows local installation status
and offers optional live route checks. Use Escape to go back, or `q` at home to quit.

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
cn opencode resume <session-id>
cn pi resume <session-id-or-path>
```

For any of these tools, omit the ID to pick a conversation, or use
`cn <tool> continue` for the most recent conversation in the current project.
A resumed conversation starts on the tool's cn default model (`cn model <tool>`), not
necessarily the model it last used. Use `cn <tool> --model <model-id> resume <session-id>`
to choose another one. For Codex, `continue` and the picker list interactive sessions
only; add `--include-non-interactive` to include scripted runs and subagent threads.

Use the same OS account and configuration directory that saved the session.
Codex's picker includes sessions started with other providers. Pi searches both
its normal session directory and cn's existing session directory; explicit
`--session-dir` overrides are respected. OpenCode v2 uses its model-switch API
to select Concentrate before opening the saved session. OpenCode v1 uses its
native model flag.

For an idle conversation retained by Codex's local background server, cn
reconnects to that server and verifies the Concentrate connection before allowing
a prompt. The conversation keeps its ID. Active tasks are left running, and cn
does not change your global Codex provider or saved ChatGPT login. Use the
`cn codex resume <session-id>` command printed by cn when you exit. cn serves your key
to that server from memory, so once cn exits the conversation can no longer use it
until you resume through cn again.

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

## Development

```sh
npm ci
npm run check
```

See [development](docs/development.md) for testing and compatibility probes.
