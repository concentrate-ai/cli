@AGENTS.md

# cn

The `cn` CLI: one Concentrate key for every coding agent. Strict TypeScript, Node.js 22.13+, pnpm. See `docs/development.md` for internals.

## Commands

| Task | Command |
|---|---|
| Everything CI runs | `pnpm check` (lint, format check, build, tests with coverage) |
| Type-check only | `pnpm typecheck` |
| Fix formatting | `pnpm format` |
| One test file / one test | `pnpm vitest run test/<area>/<file>.test.ts [-t "<name>"]` |

## Layout

| Path | Holds |
|---|---|
| `src/bin/cn.ts` | Entry point. Checks the Node version before loading anything else. |
| `src/lib/cli/` | Commands, the launcher UI, `cn update`. |
| `src/lib/harnesses/` | One adapter per tool (Claude, Codex, OpenCode, Pi), the registry, and per-tool config builders. |
| `src/lib/claude/` | Claude profiles, session repair, and the portable mod (`claude-context/`). |
| `src/lib/config/` | Settings, native config stores, and the TOML/JSONC parsers. |
| `src/lib/ui/` | Terminal rendering. |
| `src/lib/*.ts` | Shared contracts (`types`, `errors`, `validation`), the catalog, sessions, version and changelog. |
| `test/` | Vitest suite. Folders mirror `src/lib` (`cli/`, `claude/`, `config/`, `harnesses/`) plus `install/` for `install.sh`; an area with one file sits at the root. `helpers.ts` is shared; `fixtures/` holds pty drivers and stub tools. |
| `research/` | One-off compatibility probes. Not linted or formatted. |

## Rules specific to this repo

- **Node floor.** 22.13 lives in `package.json` `engines`, `src/bin/cn.ts`, `install.sh` and the esbuild `target` in `scripts/build.mjs`. Change all four together.
- **`dist/bin/cn.js` never moves.** Installed launchers and credential helpers exec it.
- **Paths from `import.meta.url`** (`version.ts`, `changelog.ts`, `harnesses/tool-config.ts`, `claude/claude-context.ts`) depend on the file's depth. Moving one of these files means updating its path.
- **Bundled parsers.** A new relative import in `config/config-formats.ts` goes in the `external` list in `scripts/build.mjs`.
- **Releases** and their artifacts: `docs/releases.md`. Don't change what a release ships without saying so.
- **Public repo.** No internal URLs, ticket ids, customer names or credentials in code, comments, docs or commit messages.

## Code standards

### Scope
- One concern per pull request. Fix the root cause.
- When new code replaces old code, delete the old code, along with the helpers, types and comments it orphaned.
- Call out every behavior change in the pull request description.

### Simplicity
- Write the least code that is still readable. No class, factory or intermediate structure where a couple of variables or a direct `if` does the job. No abstraction with one implementation.
- One responsibility per file, function and variable.
- Prefer a `switch` on a discriminant, or one flat `if`/`else` chain, over checks scattered through a function.
- Don't guard against what the code path already guarantees.

### Put code in the right layer, once
- Before writing anything, check whether it already exists (`validation.ts`, `safe.ts`, the harness registry, `config/`).
- Logic for one tool lives in its adapter. Behavior shared by several tools lives once in the shared layer.
- Derive lists from the source of truth (the harness registry, the model catalog) instead of hard-coding them.

### Types
- Reuse existing types (most live in `src/lib/types.ts`). Derive a type (`Omit<...>`, `X["field"]`) instead of restating an existing shape.
- TypeScript types don't validate input. JSON from disk or the network goes through the guards in `validation.ts`.

### Errors
- Throw `CnError` with a message the user can act on. Never print a secret, even partially, in an error.
- Never swallow an error silently, and never fall back to a weaker security mode. Fail hard.

### Comments
- Comments are two lines at most, or none if the code is clear. No narrative in code.
- Delete any comment your change makes false.

### Style
- Destructure imports.

## Test standards

- Test behavior through the public interface: run `cn` (`runCn` in `test/helpers.ts`) or call the exported function, then assert the result. Don't test internals.
- Unit tests import `src/`. Black-box tests spawn `dist/bin/cn.js`. Tests of code that copies built files import `dist/`. Vitest builds once before the suite.
- Tests use an isolated `HOME` and config directory (`tempDir()`) and dummy keys. Never the user's settings or real credentials, and no paid model calls.
- No conditionals, loops or array methods (`find`, `some`, `map`, `filter`) in a test body. Use `test.each` for cases, and assert exact indexes and shapes (`toMatchObject` on arrays), plus `toHaveLength` where it matters. Helpers outside the body may use them.
- Assert exit codes and statuses. Assert message text only when the text is the behavior (for example, a user-facing error).
- Every test is independent. Stub globals with `vi.stubGlobal`; vitest undoes it after each test.
- New source branches need tests. Don't lower coverage thresholds.
- Test files are not type-checked; `as any` is fine there.
