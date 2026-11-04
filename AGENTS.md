# Agent workflow

How coding agents work in this repo. Code and test standards are in `CLAUDE.md`.

## Working
- Do one change at a time and get it working before the next. While iterating, run `pnpm typecheck` and the affected test file (`pnpm vitest run test/<file>.test.ts`).
- Done means `pnpm check` exits 0.
- Follow the existing structure and patterns. If something has to change, say why in the pull request description.
- If you can't verify something the task depends on (a tool's behavior, a config format), don't guess. Stop and say what's missing.
- Compatibility probes: see `research/README.md` before running one.

## Git
- Branch off `dev` with a prefix: `feature/`, `fix/`, `chore/` (no user-facing change), `docs/`, `refactor/` (no behavior change).
- Open pull requests into `dev`. `dev` is promoted to `main`; releases follow `docs/releases.md`.
- Stage files by name.
- Agents never merge.
