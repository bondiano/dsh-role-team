# dsh-role-team Contributor Guide

Four-role team orchestrator (`@local/dsh-role-team`) for DeepSeek Harness: **PLAN**, **WORKER**, **ADVISOR**, **REVIEWER**, plus `Settings -> Models` role picker and `/roles`. See [README.md](README.md), [README.ru.md](README.ru.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [../AGENTS.md](../AGENTS.md).

## Layout

- Root compatibility facades: `index.ts`, `client.ts`, `background-runs.ts`, `commands.ts`, `config.ts`, `prompts.ts`, `state.ts`, `tools.ts`, `types.ts`, `verdict.ts`, `web-route-auth.ts`.
- `src/`: layered architecture (`domain/`, `application/`, `adapters/`, `infrastructure/`, `presentation/`) with `xstate` as the sole runtime dependency.
- `src/domain/machines/`: `teamPipeline`, `roleFallback`, `runtimeRole`, `backgroundJob`.
- `locale/`: `en.json`, `ru.json`, `zh.json`.
- `test/`: `node:test` suites (`role-team`, `machines`, `runtime-role`, `runtime-picker`, `background-runs`, `client`, `web-route-auth`).

## Invariants

- **Strict TS/lint/format:** Follow `strict`, `noUncheckedIndexedAccess`, `oxlint --deny-warnings`, and `oxfmt`.
- **Classic-script `client.ts`:** Zero top-level `import`/`export`; compiled via `moduleDetection: "legacy"` and tested in `node:vm`.
- **Execution & safety:** Preserve native child cleanup, session-scoped background runs, conservative verdict parsing, and fail-closed `web-route-auth` HTTP admission.
- **Committed `dist/`:** Build (`npm run build`) and commit `dist/` outputs; Nix builds `dist/` independently via `importNpmLock` (`packages/deepseek-harness.nix`).

## Verification

```sh
npm ci
npm run check     # oxfmt --check, oxlint --deny-warnings, tsc --noEmit, build + node --test dist/test/*.test.js
npm run format
npm run lint:fix
```

Sync `../machines` if state machines change, and update `../repositories.json` snapshot metadata when files here change.
