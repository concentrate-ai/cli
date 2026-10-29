# Concentrate CLI

> **Beta.** `cn` is under active development. Expect rough edges, and please
> report anything that doesn't work. Codex currently supports OpenAI models only.

Use one Concentrate API key with your favorite coding tools. `cn` launches them
through Concentrate so your model access and usage stay in one place, and you
can switch models without switching tools.

Works on **macOS and Linux**. Requires **Node.js 18.18+**, a Concentrate API key,
and the coding tools you want to use installed on your `PATH`.

## Supported tools

| Tool             | Support                                              |
| ---------------- | ---------------------------------------------------- |
| Claude Code      | Works                                                |
| OpenCode         | Works                                                |
| Pi               | Works                                                |
| Codex            | OpenAI models only for now. More models coming soon. |
| Cursor (desktop) | Work in progress. Set up with `cn configure cursor`. |

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/concentrate-ai/cli/main/install.sh | bash
cn
```

The installer checks a SHA-256 checksum and puts `cn` in `~/.local/bin`. Run the
same command again to update. Prefer to build it yourself? Clone this repository,
then run `npm ci` and `./install.sh`.

## Get started

```sh
cn                    # Open the launcher and set up your API key
cn claude             # Start Claude Code through Concentrate
cn codex              # Or: cn opencode, cn pi
cn model claude       # Pick a default model for a tool
cn configure <tool>   # Make the tool's normal command use Concentrate
cn reset <tool>       # Switch a tool back
cn doctor             # Check that everything is set up
cn --help             # See all commands
```

You can also use an existing `CONCENTRATE_API_KEY` environment variable.

## Billing and usage

Requests made through `cn` use your Concentrate API key and are billed at API
rates. Your own subscription logins for these tools stay saved and are not used
while you run through `cn`.

## Claude Code

- Use Claude models or any other model Concentrate offers for Claude Code.
- **Auto mode safety checks:** with Claude models, the classifier requests that
  check actions in auto mode are free. With other models, those checks run on the
  model you are using and are charged for that model.
- Context window, output limits, and reasoning effort follow the model you pick,
  including when you switch models during a session. This needs Claude Code
  2.1.287 or newer.
- Your regular Claude Code settings are not changed by `cn claude`, even if you
  switch models inside the session.
- Claude.ai connectors belong to a subscription login, so they are turned off
  while you run through `cn`.

## Codex

- Works with OpenAI models for now. More models are coming soon.
- The default model is `gpt-6.1-terra`. Pick another with `cn model codex`.
- Conversations you start with `cn codex` can be reopened with plain `codex resume`.
  `cn` offers to set that up the first time you run it. It doesn't change your
  default model or your Codex login.
- `cn codex` starts Codex without its shared background server, which avoids
  closed conversations showing up as "open elsewhere".

## OpenCode and Pi

- Both work with the models in the Concentrate catalog. OpenCode v1 and v2 are
  supported.
- `cn models <tool>` shows what each tool can use, and `--search` filters the list.

## Cursor desktop

Work in progress: expect changes.

- `cn configure cursor` sets up the Cursor desktop editor. Quit Cursor first.
- Cursor stores your key and sends requests through Cursor's servers. Tab
  completions keep using Cursor's own models.
- This sets up the editor, not the Cursor command-line tool.

## Models

Concentrate chooses the provider for you, so each model appears once.

```sh
cn models                       # Browse the catalog
cn models pi --search deepseek  # Search models a tool can use
cn models --refresh             # Refresh the list
cn model claude                 # Change a tool's default model
```

## Resume a conversation

Run the resume command from the same project folder:

```sh
cn claude resume                # Pick from saved conversations
cn codex resume <session-id>
cn opencode --session <id>
cn pi resume
cn claude continue              # Continue the latest one
```

A resumed conversation starts on that tool's default model. Add `--model <id>` to
use another. You can resume a saved conversation after hitting a subscription's
usage limit; new requests then go through Concentrate at API rates. Choose a model
that fits the conversation's size.

## Use a tool's normal command

`cn configure <tool>` saves Concentrate in the tool's own settings, so you can run
`claude`, `codex`, `opencode`, or `pi` directly. Restart the tool afterward.
`cn reset <tool>` puts your earlier settings back and keeps any changes you made
since. Save your key first with `cn key`.

## Your key and privacy

- Your key is stored in `~/.config/concentrate-cli/` with access limited to your
  user. Use `CN_CONFIG_HOME` to choose another folder.
- The key is never passed on the command line, where other programs could read it.
- `cn logout` removes the saved key. `cn reset` clears everything `cn` saved.

## Commands

| Command               | What it does                                  |
| --------------------- | --------------------------------------------- |
| `cn`                  | Open the launcher                             |
| `cn <tool>`           | Start a tool through Concentrate              |
| `cn configure <tool>` | Use Concentrate in a tool's normal command    |
| `cn reset <tool>`     | Switch a tool back                            |
| `cn model [<tool>]`   | Show or change default models                 |
| `cn models [<tool>]`  | Browse available models                       |
| `cn key`              | Replace your saved API key                    |
| `cn logout`           | Remove your saved API key                     |
| `cn doctor [<tool>]`  | Check your setup, or test a tool's live route |
| `cn settings`         | Open settings                                 |

## Help

- [Troubleshooting and known issues](ISSUES.md)
- [Usage guide](docs/usage.md): resuming, models, and configuration in detail
- [Tool compatibility](docs/compatibility.md) and [security](docs/security.md)
- [Development](docs/development.md) and [publishing a release](docs/releases.md)

## License

[MIT](LICENSE) © 2026 Concentrate AI, Inc.
