# Role team

Four roles with independent models, driven as one team:

- **PLAN** — a strong planner. Produces the ordered plan, risks and acceptance
  checks; does not edit files.
- **WORKER** — the implementer. Edits the shared workspace, runs tests and
  reports `CHANGES` / `EVIDENCE` / `STATUS`.
- **ADVISOR** — an independent auditor from a different model family. Inspects
  the real diff after every worker attempt and returns approved/changes with
  concrete issues.
- **REVIEWER** — the final independent gate. Runs only after the worker reports
  completion and the advisor approves; verifies from scratch.

`roles_run` drives the loop: plan, implement, audit, feed issues back to the
worker, and finish with the reviewer. `role_plan`, `role_worker`,
`role_advisor` and `role_reviewer` run one role once; the standalone reviewer
refuses to start until a worker has reported completion in the session. `/roles` shows and
changes the model route for each role, lists available models, checks that the
routes resolve, and warns when the auditor and gate are not independent from
the worker.

## Choosing models

Run `/roles` to see the current table. Change a role with:

```
/roles set plan anthropic/claude-opus-5:high
/roles set worker opencode-go/deepseek-v4.1-flash
/roles set advisor zai/glm-5.3
/roles set reviewer openai-codex/gpt-6-sol
```

Routes are validated against the live adapters before they are saved; credentials are verified by the first role run. Use
`/roles models` to discover provider ids and `/roles models <provider>` to list
a provider's models. `/roles reset <role>` returns to the recommended default;
a role configured as `null` in `cordis.patch.yml` follows the session model.

The recommended setup keeps the worker, advisor and reviewer in different
families (DeepSeek, GLM, OpenAI). `/roles doctor` reports the resolved routes
and warns about shared families.

## Settings

**Settings → Models** contains a **Role team** section below the provider
cards. Each row shows the current model, route, effort and source. **Change**
opens a provider/model picker backed by the live adapter catalogue, with model
search and the model's reasoning efforts; **Reset** returns a saved role to the
recommended default. The section saves immediately and shows the same
independence warnings as `/roles doctor`. A route whose provider is no longer
routable stays visible and is marked unavailable.

The page needs a browser refresh after installation or after its client half
changes.

## Running

Ask the lead for substantial work as usual, or call the team explicitly:

```
/roles run Implement the retry policy described in docs/design.md and prove it with tests.
```

The call blocks until the reviewer approves or the configured number of worker
attempts is exhausted. The report contains the plan, every worker attempt,
every advisor verdict, the final reviewer verdict and any outstanding feedback
for another round.

## Limits

Role children are fresh agents: they do not see the lead's conversation, so the
task and context must be self-contained. They inherit the session's tools and
permission policy; the advisor and reviewer prompts forbid edits, but the
permission layer is what actually enforces file access. A full run can take
several minutes and spends tokens in every role and round; `maxRounds` bounds
it.
