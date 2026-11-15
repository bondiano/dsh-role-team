# Role team

A four-role working model for DeepSeek Harness, ported from omp (oh-my-pi):
**PLAN** designs, **WORKER** implements, **ADVISOR** audits every attempt from
another model family, and **REVIEWER** is the final independent gate. Each role
runs as a real DSH subagent with its own model and provider, and the bundled
`roles_run` tool drives the whole loop until the reviewer approves or the round
limit is reached.

## What it adds

Five model-facing tools:

- `roles_run` — the full team loop on one self-contained task. PLAN drafts a
  rigorous plan, the ADVISOR audits that plan before WORKER starts (a rejected
  plan is revised from the advisor's issues), WORKER implements it in the
  shared workspace, ADVISOR audits every worker attempt, and REVIEWER is the
  final gate whose approval is the only approved outcome. When the rounds run
  out without approval the run asks the user how to proceed: continue without
  approval, try three more rounds, change the WORKER model (with a model
  choice), or stop. Returns the plan, every attempt, every verdict, the user's
  decisions and the final status.
- `role_plan`, `role_worker`, `role_advisor`, `role_reviewer` — run a single role
  once and return its report. Useful when the lead wants one plan, one audit or
  one final review without the whole loop.

Two human commands:

- `/roles` — show the routes and their sources.
- `/roles set <role> <provider>/<model>[:effort]` — validate the route against
  the live LLM runtime, then persist it in the profile patch.
- `/roles reset <role>` — remove a saved override and fall back to the
  recommended default (or the inherited session model).
- `/roles models [provider]` — list registered providers and their advertised
  models, so the route ids are discoverable.
- `/roles doctor` — validate every route and warn when the worker, advisor and
  reviewer are not from independent model families.
- `/roles run <task>` — run the full team directly from the command surface.
- `/role-plan <task or plan.md>` — start the full role-team process on demand,
  instead of the lead agent's ordinary execution. With a task, PLAN writes the
  plan; with a path to a Markdown plan file (for example a Jev plan artifact,
  resolved against the session workspace), the plan is read from the file and
  PLAN is skipped. The command drives the complete pipeline and returns the
  team's report.

## Default routes

The recommended setup keeps all four roles on the configured OpenCode Go
route but uses four different model families:

| Role | Default route | Family | Why |
|---|---|---|---|
| PLAN | `opencode-go/gpt-6-luna` | OpenAI | strong planning model |
| WORKER | `opencode-go/deepseek-v4.1-flash` | DeepSeek | fast, cheap implementer |
| ADVISOR | `opencode-go/glm-5.3` | ZAI | a different family from the worker |
| REVIEWER | `opencode-go/qwen3.8-max` | Qwen | independent from both worker and advisor |

The defaults deliberately use the provider that is configured in this profile,
while keeping the four families distinct. When another provider is available
(for example Codex with GPT-6 Astra, or Anthropic with Claude Opus), point a
role at it with `/roles set`; the role model and provider are independent of
the others.

Change any route with `/roles set` or from **Settings → Models**. A role set to
`null` (or `"inherit"`) follows the caller's session model; this is useful when
a provider is not configured. The plugin also accepts `roles` in
`cordis.patch.yml`:

```yaml
- id: role-team
  name: '@local/dsh-role-team'
  config:
    roles:
      plan: { provider: anthropic, model: claude-opus-5, reasoningEffort: high }
      worker: { provider: opencode-go, model: deepseek-v4.1-flash }
      advisor: { provider: zai, model: glm-5.3 }
      reviewer: { provider: openai-codex, model: gpt-6-sol }
    maxRounds: 3       # worker attempts per run, 1-6
    maxPlanPasses: 2   # ADVISOR plan-audit passes before WORKER, 1-3
    childMaxDepth: 2   # delegation depth available to role children
    prompts:           # optional extra instructions per role
      worker: 'Prefer the repository conventions over new abstractions.'
```

Compact `provider/model[:effort]` strings work too. Routes are validated with
the adapter before a run starts, so an unknown provider, model or reasoning
effort fails with the role name and route instead of starting a child. Route
validation does not test credentials: a provider that is registered but not
signed in fails on the first role request with its own diagnostic.

## Settings → Models

The package ships a browser half, so **Settings → Models** gains a **Role team**
section below the provider cards:

- one row per role with the model name, the exact `provider/model` route, the
  reasoning effort, and a **Recommended / Custom / Inherits the session model**
  badge;
- **Change** opens a picker over the live adapter catalogue: provider list,
  model search, and the model's reasoning efforts, with **Default** meaning no
  explicit effort;
- **Reset** removes a saved route and returns the role to the recommended
  default;
- the section shows the same cross-family warnings as `/roles doctor` and marks
  a stored route that no routable provider advertises as not currently
  available.

Changes save immediately through the same profile configuration editor as
`/roles set`, so the chat command and the page stay one source of truth. The
page needs a browser refresh after the bundle is installed or its client half
changes.

## Installation

Install the directory through **Plugins → Add plugin**, or with the plugin
manager:

```
plugin_manager action=install_bundle target=/absolute/path/to/dsh-role-team
```

The bundle inserts one Host row, `role-team`. It requires the subagent service
and the in-process `spawn` provider (both are in the standard Desktop and Web
presets). Persisting `/roles set` additionally requires the profile
configuration editor; without it, edit the `role-team` row in
`cordis.patch.yml` directly.

## How the loop works

1. **PLAN** receives the task verbatim plus optional context and returns a plan
   with four labeled parts: `STEPS` (each naming the exact file or module path
   and the concrete change), `RISKS` (named risks and edge cases, each stating
   what to verify), `VERIFY` (the exact commands that prove completion) and
   `ACCEPT` (acceptance checks an independent reviewer can verify).
2. **Plan audit** — the ADVISOR audits the plan itself before any WORKER
   attempt. A rejected plan goes back to PLAN with the advisor's issues
   (bounded by `maxPlanPasses`, default 2); issues that survive every pass are
   carried into the WORKER prompt.
3. **WORKER** receives the task, the plan, and the outstanding advisor/reviewer
   feedback. It runs as a fresh agent with the caller's normal tools, edits the
   shared workspace, runs checks, and must end with `CHANGES:`, `EVIDENCE:`,
   `STATUS: done|blocked` and `NOTES:`.
4. **ADVISOR** inspects the real workspace and diff from a different model
   family. It returns strict JSON: `approved`, `summary`, `issues[]`. A
   rejection feeds every issue into the next WORKER attempt.
5. **REVIEWER** runs only after ADVISOR approves. It verifies the diff and tests
   from scratch, with the plan, the worker report and the advisor verdict, and
   returns the same strict JSON. A rejection also returns to WORKER and the
   loop repeats. The REVIEWER's approval is the run's only APPROVED verdict.
6. When the rounds are exhausted without approval, the run asks the user how to
   proceed — continue without approval, try three more rounds, change the
   WORKER model (followed by a model choice from the live catalogue), or stop.
   Extra rounds respect a hard cap of 12 total worker attempts; the decision is
   recorded in the report. Without an interactive answerer the run ends
   NOT APPROVED with a note.
7. The report is verdict-first: the status header, then the labeled ADVISOR and
   REVIEWER comment sections (each with the stage's route), then the plan, the
   round-by-round detail, and the user's decisions.

The same gate applies to the standalone tools: `role_reviewer` refuses to start
until `role_worker` (or a `roles_run` worker) has reported completion in that
session, so the gate cannot be used as a first reviewer by accident.

## Role cards in the chat timeline

The browser half registers dedicated cards for the five role tools in the chat
timeline (keyed `tool.call.toolview` rows):

- a role badge with the stage's provider/model route, and a status pill
  (running, approved, changes required, continued without approval, failed);
- while a run is in flight, the card polls the live run state
  (`GET /plugin-api/role-team/run/<callId>`, loopback-guarded) and shows the
  pipeline with the currently active role highlighted;
- once settled, the card reads the structured metadata persisted with the tool
  result and renders the ADVISOR and REVIEWER comments — verdict, summary and
  each issue with its severity — plus the user's exhaustion decisions, with the
  raw report behind a disclosure. When the metadata is absent (for example an
  older result), the card falls back to the raw report text.

The structured results also remain inspectable in the Trajectory view's Result
inspector, which shows the canonical value (stages, comments, decisions) next
to the rendered report.

Role children are started with caller delivery, so they do not send completion
notices into the lead's inbox; the tool result contains the complete report.
Children are disposed after each attempt to keep the subagent pool free.

## Independence

The point of the roles is that the auditor and the gate are not the worker's
model. `familyOf` classifies a route by its model id (Anthropic, OpenAI, Google,
ZAI/GLM, DeepSeek, Qwen, Kimi, Grok, MiniMax, Meta, Mistral) and
`/roles doctor` warns when WORKER/ADVISOR or WORKER/REVIEWER or
ADVISOR/REVIEWER share a family. The classification is a heuristic: a route
whose id does not reveal its family is treated as its provider id.

## Configuration and persistence

- Role routes are read from the plugin's Loader config. `/roles set` writes the
  complete current config through `ctx.configEditor.edit`, so the override
  lands in the active profile's `cordis.patch.yml` and survives restart.
- `maxRounds` is clamped to 1-6; `childMaxDepth` to 0-8. `roles_run` accepts a
  per-call `max_rounds` override.
- The prompt section adds roughly 100 tokens to the lead's system prompt. The
  five tool schemas are visible to the lead and to role children; role prompts
  tell children not to call the role tools, and `childMaxDepth` prevents
  unbounded recursion.

## Limits

- `/roles doctor` and the Settings page check that each route resolves, not that
  its provider is authenticated. The first role run reports a missing credential
  or an unconfigured provider.
- The Settings page offers only providers the running profile can route. A
  route stored earlier for a now-unconfigured provider stays visible, marked
  unavailable, and can be reset or replaced.
- Role children inherit the caller's preset, tools and permission policy. The
  plugin does not create read-only presets for ADVISOR/REVIEWER; their prompts
  forbid edits, but the permission system still allows them. Use a
  read-only preset for the session if that must be enforced.
- Role children start fresh: they do not see the lead's conversation. Pass
  every fact they need in `task` and `context`.
- `roles_run` is a foreground tool call. It can take several minutes and spends
  tokens for every role in every round; the round limit is the budget guard.
- The standalone `role_reviewer` tool requires a completed `role_worker` call
  in the same session. It cannot tell whether the worker's claim of completion
  is true; it verifies from scratch, which is the point of the gate.
- `/roles set` triggers a Loader reload of the plugin row, which is safe while
  idle. Do not change routes in the middle of a run.
- The plugin imports no DSH packages; it resolves everything from the live Host
  context. It needs `ctx.tools`, `ctx.systemPrompt` and `ctx.subagents`; the
  command and route persistence degrade gracefully when their services are
  absent.

## Tests

```sh
node --test test/*.test.js
```

The suite uses a fake Host context and canned role outputs: it checks config
parsing, route validation failures, the plan-audit order and revision, the
strict pipeline order, feedback propagation, the reviewer gate, the four
exhaustion choices and their hard cap, `/role-plan` (task and plan-file forms),
`/roles set`/`reset` persistence, family warnings, the structured presentation
metadata, the live run-state route, the Settings snapshot, and the settings
route's GET/POST/reset and admission checks.
