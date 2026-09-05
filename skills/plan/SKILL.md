---
name: plan
description: Author, submit, and approve a Mycelium plan. Use when the operator wants to run work on the Mycelium system — planning a change to a repository, a scrape, or a research job — or wants to check on, approve, reject, or follow a plan already submitted. Turns a conversation into a schema-valid plan.json, surfaces its assumptions before approval, and drives the orchestrator's operator routes.
---

# Planning work for Mycelium

Mycelium runs a plan as a DAG of tasks, one task at a time, on a worker VM, with an
LLM agent doing the work and committing to a branch. Your job here is the part that
happens before any of that: turning what the operator wants into a plan worth
running, and being honest with them about what it will do.

The schema is checked by the orchestrator, not by you. **Never write your own copy of
`plan.schema.json`, and never validate against a remembered version of it** — submit
the plan and read the issues that come back. That is the only arrangement in which
your idea of the schema cannot quietly drift from the real one.

## The workflow

**1. Understand the goal.** Have the conversation. Do not interrupt it to collect
fields; collect them afterwards from what was said. If the operator is still working
out what they want, help with that first — a plan written from a half-formed goal
wastes a whole environment finding that out.

**2. Draft from `template.json`.** Read it and the two files in `examples/`. The
examples are more use than the rules below: they show task sizing and criteria in a
way prose does not.

**3. Show the plan before submitting it.** Not JSON — a summary the operator can
judge: the goal, each task and what it produces, what the plan is judged by, the
non-goals, and the ceilings. This is where a bad plan is cheapest to fix.

**4. Submit.**

```bash
node skills/plan/mycelium.mjs propose plan.json
```

On a rejection you get every issue by path and message. Fix exactly what they name.
**Do not guess at a rule the issues did not state** — if something is unclear, the
schema is at `packages/contracts/schemas/plan.schema.json` and is readable.

**5. Echo the assumptions, then approve.**

```bash
node skills/plan/mycelium.mjs show <plan-id>
```

Read the assumptions and non-goals back to the operator **as questions**, not as a
list to skim. The gate exists so a wrong assumption is caught here rather than three
tasks in. Then:

```bash
node skills/plan/mycelium.mjs approve <plan-id>   # only on an explicit yes
node skills/plan/mycelium.mjs reject <plan-id>    # otherwise
```

A rejected plan is terminal. A revision is a new plan — there is no lineage, and that
is deliberate.

**6. Follow it.**

```bash
node skills/plan/mycelium.mjs status <plan-id>
node skills/plan/mycelium.mjs events <plan-id>
```

`status` shows per-task state and spend, and the manifest once the plan ends.

## Writing a plan worth running

**Small tasks, small feedback loops.** A task that cannot be verified without
finishing two others is too big — split it. Each task should produce something
concrete: a file, a passing test, a committed change.

**Size limits to the task, not to the maximum.** `limits.tokens` of 500,000 on a task
that should take 20,000 is not headroom; it is an unbounded task with a number next
to it. The same applies to `max_tokens` on the plan: omitting it means the sum of
every task ceiling, which is generous by construction. Name a real number.

**Criteria have to be checkable.** The orchestrator understands exactly two:
`all_tasks_done`, and `file_exists_in_branch` with a path. Anything else must become
a file the plan produces — "a written comparison" becomes `findings.md`. "Works well"
is not a criterion.

**Non-goals are effectively required.** The schema permits an empty list; do not
leave one. The agent is assumed prompt-injectable, and the non-goals are the only
thing that bounds what it will treat as in scope.

**Assumptions carry their blast radius.** They are plain strings, so write them that
way: what you are assuming, how confident you are, and what breaks if it is wrong.
That is what makes the approval gate useful rather than ceremonial.

**Failure policy is a choice.** `halt` is the default and is right for most things.
`retry` is for genuine flakiness — a network fetch, a slow service — never for a task
that failed because it was wrong. A wrong task retried three times is a wrong task
three times.

**Egress is deny-by-default.** List every host a sandbox needs. Gitea and the package
registries are always allowed; nothing else is. `*.example.com` is permitted and does
**not** match the apex, so list both if you need both. A missing host fails at the
proxy, visibly, mid-plan.

**Rollback notes go in the description.** Any task touching something outside the plan
branch says what undoing it looks like.

## What the schema does not have

Do not reach for these; they have no field, and inventing one produces a plan the
orchestrator rejects. Cost budgets in dollars, spawn reserves, context capsules or
typed references, `required_connections` for external APIs or MCP servers, model
profiles, per-task `env` tiers, review-gate pause points, scheduled or recurring runs,
and agent-spawned subtasks. A v1 task is a plain-text description; a v1 DAG is fixed
at approval.

## Connecting to the orchestrator

```
MYCELIUM_URL       default http://127.0.0.1:8080
MYCELIUM_OPERATOR  the login to send; must be on the orchestrator's allowlist
```

The operator routes accept loopback connections only and take the caller's identity
from a `Tailscale-User-Login` header. In deployment, Tailscale Serve injects that
header having stripped any client-supplied copy, and the loopback rule is what makes
it trustworthy.

**Serve is configured in `infra/`, which is not built yet.** Until it is, point
`MYCELIUM_URL` at an orchestrator running on the operator's own machine. In that mode
the header is self-asserted rather than proven — acceptable on your own loopback,
where there is nobody else, and not a deployment. Say so if the operator seems to
think otherwise.
