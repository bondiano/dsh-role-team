# README screenshots

The screenshots render the built `dist/client.js` components and the installed
DSH theme in an isolated local browser. The model catalogue, progress and
verdicts are deterministic demonstration data; no live provider is called and
no user session is accessed. Both English and Russian use the plugin's actual
locale dictionaries.

From the workstation repository root:

```sh
npm ci --prefix extensions/dsh/dsh-role-team
node extensions/dsh/dsh-role-team/docs/preview/capture.ts
```

The script uses the existing React 18 UMD files and DSH theme from
`packages/dsh-runtime/node_modules`, plus Playwright from
`extensions/omp/cursor/node_modules`. It installs no dependencies. For a
standalone checkout, point `DSH_PREVIEW_MODULES` at a directory containing
React 18, React DOM 18 and `@deepseek-ai/dsh-client-ui-theme`, and
`DSH_PREVIEW_BROWSER_MODULES` at a directory containing Playwright. A matching
Playwright Chromium installation is required.

Eight PNG files are written to `docs/screenshots`. The live and result images
show one background `roles_start` card: the tool result is already settled,
while its run is still active. The capture advances the mocked run endpoint
from running to approved and checks that the same card refreshes by `runId`,
shows three verdict comments, and stops polling after settlement without
starting another tool or rendering a replacement tool result. An initially
approved result must not poll. Playwright's clock advances the real client
polling interval; the plugin's hooks and render logic are unchanged.

The capture also checks all four settings rows, five pipeline stages, the
highlighted live stage and absence of browser errors in both languages.
Visually inspect the resulting images after changing the client UI.
