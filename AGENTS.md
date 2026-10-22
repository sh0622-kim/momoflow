# momoflow development rules

## Product intent

momoflow is a personal web app for agent-led, recursive improvement. It may grow into a team
product. Its own development is the first use case. Docker is the deployment environment,
Codex is the coding agent, and OpenAI Symphony is the initial execution engine.

## MVP first

- Implement the smallest end-to-end change that satisfies the current goal.
- Use existing Symphony functionality before adding a momoflow implementation.
- Add abstractions, dependencies, services, and persistent data only for a demonstrated need.
- Do not implement speculative team features or replace the engine in one rewrite.
- Keep each iteration reviewable and reversible. Record follow-up work separately.

## Autonomous improvement

- The conversational assistant discusses goals and results; it does not proactively develop
  features. It intervenes minimally when the loop stops or the system fails. Explicit user
  requests such as documentation edits remain in scope. Implementation belongs to loop agents.
- Initially, the conversational assistant may operate user-requested deployments and recovery.
  Loop agents implement deployment automation; eligible routine deployments should ultimately
  run automatically. Never replace the running engine from its own coding session.
- Inspect → implement → validate → review → correct is the default development loop.
- Make routine engineering decisions independently within the user's scope.
- Ask a human only for missing authority, unresolved product direction, or a genuine blocker.
- A successful agent exit is not evidence that the work is correct. Record actual checks.
- Fix concrete review findings and rerun affected checks before handing off.
- Do not lower checks, widen permissions, or increase budgets just to complete an iteration.
- Do not claim mock tests are live Codex or Symphony validation.
- Fast mode is OFF for every role; never enable it or change model/reasoning/budget policy
  autonomously. Follow [agent policy](docs/agent-policy.md) before any issue execution.

## Current boundaries

The bootstrap runs upstream Symphony directly and uses its built-in web dashboard. Scheduling,
workspace isolation, retries, and Codex app-server sessions belong to Symphony.
The only upstream patch adds expiring token-file authentication. GitHub App key custody and
token renewal belong to the isolated github-auth service; see README.md before changing auth.
Use GitHub Issues → PR → CI/review → merge → evidence-backed next issue. Start with one goal,
one execution, and one PR. Waiting is not executable work; merge is not deployment.
Automatic successor dispatch and event-driven resumption are planned, not implemented.
Do not auto-label successor issues in the bootstrap or bypass checks to keep the loop moving.

## Read only the context needed

Read [the constitution](docs/constitution.md) once when starting a task or when it changes.
Then select the relevant document below; do not preload all docs or reread unchanged content.

| Task | Read before acting |
| --- | --- |
| Issue execution, PR, CI, review, merge, loop diagnosis | [GitHub flow](docs/github-flow.md); the current issue/workpad and PR head |
| Runtime settings, dispatch, retries, budgets | [WORKFLOW.md](WORKFLOW.md); GitHub flow's current-versus-planned boundaries |
| Role assignment, models, reasoning, Fast mode, execution preflight | [Agent policy](docs/agent-policy.md); distinguish agreed policy from enforced settings |
| Setup, authentication, startup, recovery | [README.md](README.md) relevant section |
| Docker sandbox failures or seccomp changes | [Sandbox boundaries](security/README.md); real sandbox smoke, not just engine health |
| Deployment, rollback, deployment automation | [Deployment policy](docs/deployment.md); exact candidate version and validation evidence |
| Choosing the next improvement or absorbing engine functionality | [Roadmap](docs/roadmap.md); evidence from the completed task |
| Finding or maintaining documentation | [Documentation map](docs/README.md) |
| Writing docs, issues, PRs, or workpad comments | [Record conventions](docs/records.md) and only the relevant linked template |
| Human review, decisions, labels, or action detection | [Human actions](docs/human-actions.md); current request, actor authority, and PR head |

Read only relevant sections of longer documents. Expand context when a dependency or conflict
requires it. Documents describe intent; inspect code and runtime evidence before claiming a
feature works. A roadmap item is not authorization to implement it. Record decisions in their
owning document and link to them; avoid copying whole policies into issues or other docs.
If the intended design conflicts with the running WORKFLOW.md, report the gap rather than
silently changing execution policy. Keep this file a short routing guide and invariant summary.

Keep durable decisions in docs, actionable work in issues, change evidence in PRs, and progress
in one updated workpad comment. Start with a short outcome; use comparison/evidence tables,
optional Mermaid for nontrivial flows, and collapsed details for long logs. API-created issues
and PRs must also use the templates; never auto-apply execution labels from a template.
Surface human review/decision requests with the documented labels and a visible action summary.
Labels are not approvals; shared human/agent credentials do not prove human authorship.

## Verification

- Configuration changes: `docker compose config --quiet`.
- Engine image changes: `docker compose build` and `sh scripts/smoke.sh`.
- Shell scripts: `sh -n scripts/git-askpass.sh` and `sh -n scripts/smoke.sh`.
- Local authentication setup: `sh -n scripts/start-local.sh`; never print credentials.
- GitHub App authentication: `node scripts/smoke-github-auth.mjs`, token-file smoke in README.md,
  and `sh -n scripts/start-github-app.sh scripts/init-codex.sh`; never print keys or token files.
- Documentation-only changes: check links, commands, and consistency with implementation.
- Live agent execution requires a configured repository and Codex/GitHub authentication.
  Do not invent credentials or run paid/external tasks solely to make a check appear complete.
