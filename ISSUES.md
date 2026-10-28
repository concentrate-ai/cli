# Known issues and troubleshooting

`cn` is in **beta**. This page covers the problems people hit most and how to
fix them, then how to report anything new.

First, two quick checks that solve many problems:

```sh
cn --version      # which version you have
cn doctor         # checks your tools, your key, and the connection
```

To update `cn`, run the install command again.

## Install

**`cn: command not found`**
The installer puts `cn` in `~/.local/bin`. Add that folder to your `PATH`; the
installer prints the exact line for your shell. Open a new terminal afterward.

**`Node.js 18.18+ is required`**
Install a current Node.js (for example with [nvm](https://github.com/nvm-sh/nvm)),
then run the installer again.

**`The CLI download failed SHA-256 verification`**
Nothing was changed. Run the installer again. If it keeps failing, report it.

**`Could not download the CLI release`**
You may be offline, or the version you asked for does not exist. Check
[Releases](https://github.com/concentrate-ai/cli/releases), or drop
`CN_INSTALL_VERSION` to get the latest.

## Your API key

**`No API key found. Run cn setup first.`**
Run `cn setup`, or set `CONCENTRATE_API_KEY` in your shell.

**`rejected this API key (HTTP 401)`**
The key is wrong or revoked. Create a new one in your Concentrate dashboard and
run `cn key`.

**`The saved key ... is not valid` or `Private file is accessible to others`**
Run `cn key` and enter your key again. It replaces the damaged file. You can
also run `chmod 600` on the file named in the message.

**Remove the key from this computer:** `cn logout`. If you also set
`CONCENTRATE_API_KEY` in your shell, remove it there too.

## Claude Code

**`Context synchronization needs Claude Code 2.1.287 or newer`**
Run `claude update`, then launch through `cn` again.

**A model change inside Claude Code did not change the context size**
This needs Claude Code mods to be enabled. Do not start Claude with `--bare` or
`--safe-mode` when you launch it through `cn`.

**Claude.ai connectors are disabled**
They belong to a subscription login, which `cn` does not use. Run plain `claude`
for them.

## Codex

Codex works with **OpenAI models only** for now. More models are coming.

**`Codex is limited to OpenAI models for now`**
Pick a `gpt-*` model: `cn model codex`.

**`This conversation is open in another app`** (a lock banner)
Codex keeps conversations loaded in a shared background server after you quit
`codex`, and treats them as open elsewhere. In the banner:

- press `f` to fork the conversation into a new one and keep working, or
- close the conversation everywhere and press `r`.

As a last resort, `codex app-server daemon stop` stops that background server.
It affects every Codex app on your machine and can interrupt running work.

**`Model provider concentrate not found`** when running plain `codex resume`
Conversations started with `cn codex` belong to the `concentrate` provider.
Either resume with `cn codex resume <session-id>`, or let `cn` add the provider
to `~/.codex/config.toml` (it offers this the first time you run `cn codex`).
You can also run `cn configure codex`, which additionally makes Concentrate your
default. Undo either with `cn reset codex`.

**`provider auth cannot be combined with env_key`**
You have an older `cn`. Run the install command again to update.

**Using your ChatGPT subscription and Concentrate**
Run `codex` for your subscription and `cn codex` for Concentrate. `cn` does not
change your Codex login or default. `cn codex resume` can continue a
subscription conversation through Concentrate; new requests then use your API
key and API billing.

**The Codex app shows no Concentrate models**
Quit the app and open it again after `cn configure codex`. The app and the
command line share `~/.codex/config.toml`.

## OpenCode and Pi

**OpenCode resume says the session was not found**
Run the resume command from the project folder where the session was started.
OpenCode v1 and v2 are both supported.

**Pi ignores my settings**
If `settings.json` or `models.json` in Pi's folder is a symbolic link, `cn` does
not follow it yet. Use a regular file.

## Cursor (work in progress)

- Quit Cursor completely before `cn configure cursor` or `cn reset cursor`.
- Open Cursor once before configuring, so its settings exist.
- `sqlite3` is required (it ships with macOS).
- Tab completions keep using Cursor's own models.

## Undo and start over

| Goal                               | Command           |
| ---------------------------------- | ----------------- |
| Stop using Concentrate in one tool | `cn reset <tool>` |
| Remove your saved key              | `cn logout`       |
| Clear everything `cn` saved        | `cn reset --yes`  |

`cn reset <tool>` keeps any changes you made to that tool's settings afterward
and tells you which ones it kept.

**`Another tool configuration is in progress`**
A previous `cn configure` or `cn reset` was interrupted. `cn` clears a leftover
lock on its own when the process is gone. If the message persists, delete the
folder it names, then try again.

## Known limitations (beta)

- Codex: OpenAI models only. Other models are rejected by the gateway for
  Codex's request format.
- Cursor: work in progress, not tested in a full desktop session.
- macOS and Linux only.
- `cn` works with whatever version of each tool you have installed. If a tool
  updates and `cn` misbehaves, update `cn` first, then report it. The tools
  `cn` was most recently checked against are listed in
  [tool compatibility](docs/compatibility.md).

## Report a problem

Open an issue at <https://github.com/concentrate-ai/cli/issues> with:

- the output of `cn --version` and `cn doctor`
- which tool you were using, and its version (for example `codex --version`)
- the exact error text and what you ran

**Never paste your API key.** `cn doctor` does not print it.
