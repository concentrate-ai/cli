# Concentrate AI CLI (v0)

Run your coding tools through Concentrate AI. `cn <tool>` launches the tool with your Concentrate key and model for that one run. Your normal setup is not touched.

v0 covers the terminal tools: **Claude Code, Codex CLI, OpenCode, Pi**.

## Install

Needs Node.js 18+. No npm packages.

```sh
curl -fsSL https://raw.githubusercontent.com/AjayK47/concentrateai-cli/main/install.sh | bash
cn
```

Or from a clone: `./install.sh`. Set `CN_INSTALL_REF` to install a specific branch or tag.

The installer copies the package to `~/.local/share/concentrate-cli/` and writes a `cn` launcher into `~/.local/bin/`. The launcher records the absolute path of the Node it was installed with. It will not overwrite a different `cn` already on that path. Running the installer again updates `cn` in place.

## First run

Run `cn`. With no key saved, it starts setup: it asks for your key (or offers one it finds in `CONCENTRATE_API_KEY`, showing only the last four characters) and checks it. That is all setup asks. Every tool starts on a sensible default model; change one any time with `cn model <tool>`.

A key found only in your environment is used where it is. It is not copied to disk.

## Use

```sh
cn                              # interactive launcher
cn claude                       # launch Claude Code through Concentrate
cn codex -- exec 'Say hello'    # everything after -- goes to the tool
cn opencode -- run "Say hello"
cn pi --model deepseek-v4-1-flash
```

| Command | What it does |
|---|---|
| `cn` | Open the launcher (a plain `--help` when not in a terminal) |
| `cn setup [--no-verify] [--models]` | Save your key. `--models` also picks a default per tool |
| `cn config` | Show key status and default models (never prints the key) |
| `cn key [--no-verify]` | Replace the saved key |
| `cn logout` | Remove the saved key |
| `cn reset [--yes] [--sessions]` | Clear the saved key, models, and catalog cache. Pi sessions are kept unless `--sessions` |
| `cn model [<tool> [<id>]]` | Show or change default models |
| `cn models [<tool>] [--search x] [--refresh] [--limit n]` | Browse the catalog |
| `cn doctor [<tool>]` | Check installs and key; with a tool, test its API route live |

## Models

Refresh the Claude Code compatible catalog with `cn models claude --refresh --limit 200`.

Each tool's own model picker lists Concentrate models while it runs under `cn`. If you switch models inside the tool and quit, `cn` starts there next time. It reads the choice back from the tool's own session files, and only saves a model that differs from the launch model and exists in the catalog. If a tool's files look different than expected, nothing is saved. Codex's reader is untested against a real install.

Pass `--session-dir` yourself to Pi and `cn` reads that folder. With `--no-session` there is nothing to read.

## OpenCode v1 and v2

Both work. `cn` gives OpenCode its Concentrate provider through an inline config. The same config is read by v1 and accepted by v2. OpenCode v2 also needs `--standalone` so it uses a private server and not its shared background service, which would ignore the config. v1 rejects that flag, so `cn` adds it only when `opencode --help` lists it. `cn doctor` shows which version is installed.

Remembering a model you switched to inside OpenCode is not supported, because OpenCode keeps sessions in a database.

## If the tool isn't installed

`cn codex` without Codex installed prints one line saying so, with an install hint, and exits `127`. It checks before reading your key or touching the network.

Exit codes: `0` ok (or the tool's own code), `1` failure, `2` bad usage, `127` tool not found.

## Files and environment

- Config lives in `~/.config/concentrate-cli/` (`credentials.json`, `config.json`, `catalog.json`, `pi-sessions/`), files mode `0600` in a `0700` directory. Symlinks are refused.
- `CN_CONFIG_HOME` overrides the config directory. `CONCENTRATE_API_KEY` is used when no key is saved. `CN_OFFLINE=1` skips the catalog fetch.
- Color follows `NO_COLOR` and the terminal. `CN_NO_MOTION=1` (or `CI`) turns the animation off. Piped output is plain text.

## Security

- **The key** reaches a tool only through that tool's environment. It is never in argv (visible in `ps`), and only `credentials.json` (mode `0600`) holds it on disk. Keys and model IDs with spaces or control characters are refused, and errors never repeat them.
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

## Develop

```sh
npm test        # node --test test/*.test.mjs
```

## Acknowledgments

The installer approach and the per-tool adapter layout were inspired in part by [FireConnect](https://github.com/fw-ai/fireconnect) from Fireworks AI. No FireConnect code is included.

## License

[Apache License 2.0](LICENSE)
