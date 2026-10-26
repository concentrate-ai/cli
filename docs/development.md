# Development

The CLI is written in strict TypeScript. TOML and JSONC parsers are bundled at build time; the installed CLI needs Node.js and no `node_modules`. TypeScript, esbuild, ESLint, Prettier, and the parser packages are development dependencies only. Bundled parser licenses are included in the generated module.
Use Node.js 18.18+ and npm.

```sh
npm ci
npm run check
```

`check` runs strict type checking, linting, formatting verification, and the regression suite. `npm run build` compiles `src/` into `dist/` and bundles the configuration parsers; tests and compatibility probes use that compiled output. Run `npm run format` after edits. A failed compilation emits no new JavaScript.

The source layout keeps shared contracts in `src/lib/types.ts` and harness configuration contracts in `src/lib/harness-config.ts`. Catalog and file input pass through runtime guards in `validation.ts`; TypeScript types alone do not validate JSON. Effort definitions and selection rules live in `model-metadata.ts`. Each adapter implements the same `Harness` contract.

Claude's portable mod uses `.mts` source, which compiles to `.mjs` because the generated hook runs outside this package's module boundary. Its type-only host contract is erased from the emitted code.

The installer builds source checkouts before replacing an installation. Built release packages need only `dist/`, `package.json`, and `install.sh`; they do not need npm or a compiler. `dist/` is generated and ignored by Git.


To check Claude Code integration against an installed client:

```sh
node research/context-switch-probe.mjs
node research/capability-switch-probe.mjs
```

These probes use an isolated home and dummy credentials. The capability probe
starts a localhost mock API. Neither makes paid model calls.

To check the other installed clients:

```sh
node research/model-metadata-probe.mjs codex
node research/model-metadata-probe.mjs opencode
CN_PROBE_PI_MODULES=/path/to/pi/node_modules node research/model-metadata-probe.mjs pi
```

The Codex probe checks the parsed catalog. The OpenCode probe runs two models against a localhost mock and checks output budgets and reasoning variants. The Pi probe loads its installed schema and request implementation, with a mocked fetch, to verify output budgets and reasoning choices. Set `CN_PROBE_CODEX_BIN` or `CN_PROBE_OPENCODE_BIN` to override binary paths. The probes keep their isolated state in the reported temporary directory and make no paid inference calls. They do not verify interactive model switching or automatic summarization.

See [tool compatibility](compatibility.md), [security](security.md), and
[research notes](../research/README.md) for implementation details and limitations.

## Acknowledgments

The installer approach and per-tool adapter layout were inspired by
[FireConnect](https://github.com/fw-ai/fireconnect). No FireConnect code is included.

## Native configuration and reset

`tool-config.ts` builds native settings from the same model catalog and adapter helpers as session launches. `native-config-store.ts` owns private restore receipts, atomic file replacement, setup locks, and restoration that preserves later edits. JSONC edits preserve comments. TOML is parsed and serialized, so formatting is normalized while configured; an untouched Reset restores the original bytes, including comments.

`test/tool-config.test.mjs` covers all four tools, repeat setup/reset, credential helpers and rotation, JSONC, malformed files, and preservation of user edits. `test/fixtures/navigation.py` drives the real terminal UI in an isolated home. No tests use the user’s settings or real credentials.

To inspect permanent settings with the installed clients:

```sh
CN_PROBE_PI_MODULES=/path/to/pi/node_modules node research/native-config-probe.mjs
```

This uses a temporary home, a dummy key, Codex’s native catalog reader, Pi’s native model loader, and OpenCode’s standalone server against a localhost mock. It also loads Claude’s installed capability plugin through its native registry and verifies context and output limits across local model switches, with no inference. Desktop apps are not tested.
