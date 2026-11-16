# Development

Use Node.js 22.13 or newer and npm. From this directory, run:

```sh
npm ci
npm run check
```

`npm ci` runs `prepare`, compiling the TypeScript host, browser client and
tests. The output lives in ignored `dist/`. `npm run check` checks formatting,
type-aware lint, strict types and the tests against that output. Use
`npm run format` and `npm run lint:fix` for automatic fixes. Versions are
pinned in `package-lock.json`; update dependencies and the lockfile together.

The TypeScript, Oxlint and Oxfmt settings follow `extensions/omp/cursor`.
Preserve `strict`, `noUncheckedIndexedAccess` and the promise-handling rules.
DSH services have structural contracts in `types.ts` and the corresponding
runtime modules; the extension has no runtime package dependencies.

Keep `client.ts` free of top-level imports and exports. DSH loads its compiled
output as a classic script via `window.__ModuleLoader__`; `moduleDetection:
legacy` preserves that format, and the VM tests exercise the emitted script.

Keep native child cleanup, session-scoped background runs, conservative verdict
parsing and fail-closed HTTP admission intact. Existing tests cover these
compatibility and failure paths. Add behavioral regression cases when changing
them, including the failure path. Preview capture instructions are in
[docs/preview/README.md](docs/preview/README.md).

`npm pack` runs a fresh build and includes the runtime JavaScript, documentation,
locales, icon, bundle patch and MIT license. For a source-directory or `link:`
installation, run `npm ci` first and keep `dist/` with the installed copy.
The workstation macOS installer builds its staged plugin before activation.
The Nix package builds it separately with `importNpmLock` from the same lockfile.

Changes are licensed under [MIT](LICENSE).
