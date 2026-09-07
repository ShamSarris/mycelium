# 2 · Flow of Use

> One plan, from a conversation to a merged pull request — and what every component does at each
> step, why it exists, and how it behaves when things go wrong.

---

## 2.1 The eight steps

```mermaid
flowchart LR
    S1["1 · Plan<br/><i>conversation</i>"] --> S2["2 · Propose<br/><i>validate</i>"]
    S2 --> S3["3 · Approve<br/><i>the gate</i>"]
    S3 --> S4["4 · Provision<br/><i>place + build</i>"]
    S4 --> S5["5 · Dispatch<br/><i>lease a task</i>"]
    S5 --> S6["6 · Execute<br/><i>the agent</i>"]
    S6 -->|"more ready tasks"| S5
    S6 --> S7["7 · Finalize<br/><i>criteria + PR</i>"]
    S7 --> S8["8 · Teardown<br/><i>kill the environment</i>"]
```

---

## 2.2 The whole thing, end to end

```mermaid
sequenceDiagram
    actor Op as Operator
    participant LC as Claude Code + plan skill
    participant OR as Orchestrator
    participant GT as Gitea
    participant SU as Supervisor
    participant PX as Egress proxy
    participant AG as Plan agent
    participant SB as gVisor sandbox

    Op->>LC: describe the goal, iterate
    LC->>LC: draft plan.json — goal, assumptions, non-goals,<br/>task DAG, limits, egress, success criteria
    LC->>OR: POST /plans
    OR->>OR: validate: schema, acyclic DAG,<br/>deps resolve, bounds in range
    OR->>GT: create the repo (new project only)
    OR-->>LC: assumptions + declared egress
    LC-->>Op: surface them AS QUESTIONS

    Note over Op,OR: THE APPROVAL GATE — nothing dispatches before this

    Op->>OR: approve
    OR->>OR: write approved_at / approved_by → queued
    OR->>GT: create plan/{id} · mint a per-plan bot user + token

    OR->>OR: select a supervisor: env, enabled,<br/>heartbeat &lt; 2 min, ORDER BY priority, id
    OR->>SU: dispatch plan
    SU->>SU: authenticate the tailnet peer · admission check
    SU->>GT: clone, checkout plan/{id}
    SU->>SU: internal network · broker socket · egress proxy on its gateway
    SU->>AG: start the agent in a systemd scope,<br/>credentials INJECTED (never inherited)
    SU-->>OR: 202 accepted → plan is running

    loop each ready task
        OR->>SU: dispatch task under a 60s lease
        SU->>AG: forward the envelope WHOLE
        AG->>OR: status: running (this clears the lease)
        AG->>AG: query() — fresh context: system prompt + one task
        AG->>SU: sandbox.run over the broker socket
        SU->>SB: docker create --runtime runsc, no credentials
        SB->>PX: HTTP CONNECT
        PX->>SU: egress.allowed / egress.denied
        SB-->>SU: exit status + bounded output
        SU-->>AG: result
        AG->>GT: commit + push at checkpoints
        AG->>SU: events.emit per tool call
        SU->>SU: stamp seq, fsync to the spool
        SU->>OR: relay events (held on disk during an outage)
        AG->>OR: status: done | failed
    end

    Note over OR,GT: Results

    OR->>OR: evaluate the success criteria
    OR->>GT: open a PR — plan/{id} → main
    OR->>OR: write the manifest, NULL the plan token
    OR->>SU: authorize teardown (sent once, result unchecked)
    SU->>SB: kill the sandboxes FIRST
    SU->>AG: SIGTERM
    AG->>SU: one terminal event naming the reason
    AG-->>SU: exit (SIGKILL at 5s)
    SU->>SU: close sockets + network, remove the cgroup, scrub scratch
    SU->>OR: drain the spool ONCE
    OR-->>Op: done / failed, with the manifest
    Op->>GT: review and merge the PR
```

---

## 2.3 Step by step

### 1 · Plan — the operator and Claude Code

The `plan` skill lives in `~/.claude/skills/plan/`, **not in this repository**, so it is available
from any Claude Code session. It turns a conversation into a schema-valid `plan.json`.

Its most important instruction is what it refuses to do:

> *"The schema is checked by the orchestrator, not by you. **Never write your own copy of
> `plan.schema.json`, and never validate against a remembered version of it** — submit the plan
> and read the issues that come back. That is the only arrangement in which your idea of the
> schema cannot quietly drift from the real one."*

It is also told to **have the conversation first** — *"Do not interrupt it to collect fields;
collect them afterwards from what was said. A plan written from a half-formed goal wastes a whole
environment finding that out"* — and to **show a summary, not JSON**, before submitting: the goal,
each task and what it produces, what the plan is judged by, the non-goals, and the ceilings.
*This is where a bad plan is cheapest to fix.*

### 2 · Propose — the orchestrator validates, once

```mermaid
flowchart TB
    P["POST /plans"] --> V1["JSON Schema — Ajv 2020, every object closed"]
    V1 -->|"fails"| ISSUES["400 with EVERY issue<br/>by JSON-Pointer path and message"]
    V1 --> V2["semantic checks — only once the shape is trusted"]
    V2 --> D1["duplicate_task_id"] & D2["self_dependency"] & D3["unknown_dependency"] & D4["dependency_cycle — reports the actual cycle"]
    V2 -->|"clean"| TX["ONE transaction: project · plan (state=proposed) ·<br/>tasks (state=pending) · dependency edges · events"]
    TX --> REPO["ensureRepo — OUTSIDE the transaction"]
```

Schema defaults are filled in by Ajv (`useDefaults`) and **stored**, so the persisted `spec` is
the complete document, not the submitted one.

Repo creation happens *after* the commit deliberately: Gitea is a separate system, and a network
failure there must not lose the plan. Approve retries it.

### 3 · Approve — the gate

The skill reads the assumptions and non-goals back **as questions**, then:

```sh
mycelium.mjs show <plan-id>      # what approval covers
mycelium.mjs approve <plan-id>   # ONLY on an explicit yes
mycelium.mjs reject <plan-id>    # otherwise
```

A rejected plan is **terminal**. A revision is a new plan — there is no lineage, and that is
deliberate.

Approval does four things atomically-enough: creates `plan/<id>` from `main`, mints a per-plan
Gitea **bot user** with write access to exactly one repo, mints a per-plan orchestrator API token,
and sets `approved_at` / `approved_by` under a compare-and-set so a concurrent approve cannot
double-mint. Plaintext lands only in process memory.

See [Orchestrator §4](layers/orchestrator.md#4--the-approval-gate-g2).

### 4 · Provision — placement and construction

```mermaid
flowchart TB
    SEL["selectSupervisors: env matches · enabled ·<br/>heartbeat within 2 min · ORDER BY priority, id"] --> FF["first-fit"]
    FF -->|"429 full, or unreachable"| NEXT["next candidate"]
    NEXT -->|"all exhausted"| BACK["→ queued, exponential backoff<br/>5s → 10s → … → 300s"]
    FF -->|"400 validation_failed"| TERM["→ finalizing. TERMINAL.<br/>A manifest names the reason"]
    FF -->|"202"| PROV["the supervisor has ALREADY built everything"]
```

**The 202 arrives only once the agent is up**, because the orchestrator marks the plan `running`
on that answer and begins dispatching tasks at once.

**Placement is sticky for the life of the plan.** There is no mid-plan rescheduling, so a VM lost
mid-plan fails the plan back to its last pushed commit.

What the supervisor builds, in order: directories → clone (token via a credential helper, never
in the URL) → an `--internal` Docker network → the egress proxy **on that network's gateway** →
the broker socket (**before** the agent, so its first call cannot race) → the agent in a systemd
scope with a full environment replacement → the ledger entry → the on-disk record, **last**.

### 5 · Dispatch — leased, one at a time

The orchestrator claims a task transactionally with `FOR UPDATE SKIP LOCKED` under a 60-second
lease, and pushes it to the agent *through* the supervisor.

**The supervisor forwards the envelope whole and reads nothing out of it.** If it cannot hand the
task over it refuses immediately — carrying the agent's own reason — rather than accepting
quietly, and the orchestrator returns the task to `ready` **without waiting out the lease**.

**Agents never self-schedule.** A task is `ready` when every dependency is `done` and the plan is
`running`.

### 6 · Execute — the agent

Covered in full in [03 · Agentic Harness](03-agentic-harness.md). The shape:

1. Acknowledge (`status: running`) — **first and unconditionally**, because that is what clears
   the lease. If the POST fails the task still runs; refusing to work because one POST failed
   would guarantee the failure it was worried about.
2. Announce the subagent roster as an event, *before* the run, so a stalled plan still shows what
   it was configured with.
3. Run `query()` with a **fresh context**: the system prompt and one task description. No plan
   DAG, no sibling transcripts, no event stream.
4. Map every SDK message into events and emit them to the local spool.
5. End on a terminating tool call — or fail. **Silence is never success.**
6. Report the outcome with cumulative cost and tokens.

### 7 · Finalize — criteria, PR, manifest

Evaluate the two supported success criteria against durable state, open the pull request, write
the manifest — **and only then** authorise teardown, because pushed commits are the only thing
that survives. Any throw leaves the plan in `finalizing` for the next tick to retry, *rather than
writing a manifest that claims less than actually happened.*

A plan carrying any `terminal_reason` can never be `done`, even if its criteria pass.

See [07 · Evaluation](07-evaluation.md).

### 8 · Teardown

Sandboxes die first, then SIGTERM, then a 100 ms poll up to five seconds, then SIGKILL of the
**process group**; then sockets, network, cgroup, and an `rm -rf` of the plan root; then **one
spool drain**, which is what actually pushes the agent's terminal event off the VM.

Every step is individually `.catch()`ed, because `authorizeTeardown` is **sent once and its
response is not checked** — so teardown must not be able to fail. The supervisor's own 30-second
TTL sweep is the backstop for a dropped authorisation.

---

## 2.4 What each component is *for*

| Component | Its one job | The thing it deliberately does **not** do |
| --- | --- | --- |
| **Plan skill** | Turn a conversation into a valid plan and surface it for approval | Hold a copy of the schema, or approve anything itself |
| **Orchestrator** | Validate, gate, dispatch, record, finalize | Interpret a plan, or run any model |
| **Postgres** | State, queue and event log in one place | Anything a second writer could touch — one advisory lock enforces it |
| **Gitea** | A repo per project, a branch per plan, a PR per result | Give any agent access to `main` |
| **Supervisor** | Provision, broker, proxy, spool, tear down | Read a task envelope, hold durable plan state, or run a model |
| **Plan agent** | Execute exactly one task at a time and report honestly | Retry itself, self-schedule, or contain anything |
| **Sandbox** | Run untrusted code | Hold a credential, or reach anything but the proxy |
| **Dashboard** | Show what needs you and why nothing is moving | Exist as a separate deployable — it is the same process |

---

## 2.5 What happens when things go wrong

```mermaid
flowchart TB
    subgraph TRANSPORT["Transport failures — recovered automatically"]
        A1["Supervisor refuses / unreachable"] --> A2["task → ready immediately;<br/>plan tries the next candidate"]
        B1["Lease expires (60s)"] --> B2["task → ready, task.lease_expired"]
        C1["Orchestrator down"] --> C2["events wait on the fsynced spool;<br/>the agent keeps working"]
        D1["Orchestrator restarts"] --> D2["per-plan secrets re-minted, not recovered"]
        E1["Supervisor restarts"] --> E2["adopts plans whose agents still answer;<br/>kills everything else"]
    end
    subgraph TERMINAL["Terminal failures — the plan ends with a manifest"]
        F1["Task fails, policy exhausted"] --> F2["siblings cancelled → finalizing (B17)"]
        G1["Plan budget would be crossed"] --> G2["halted before dispatch, manifest names the overspend"]
        H1["Env TTL expires"] --> H2["plan aborted, environment torn down"]
        I1["No heartbeat for 5 min"] --> I2["plan failed back to its last pushed commit"]
        J1["Supervisor says validation_failed"] --> J2["terminal everywhere — no other VM is tried"]
    end
```

**The distinction that runs through all of it:** a failure that *will* resolve on its own is
retried (an unreachable VM, a 5xx, a dropped lease); a failure that *cannot* is made terminal
immediately with a manifest (a missing branch, a refused event batch, an exhausted budget).
Retrying the second class only hides it.

---

## 2.6 Operating it

```sh
# author and follow a plan
node ~/.claude/skills/plan/mycelium.mjs propose plan.json
node ~/.claude/skills/plan/mycelium.mjs show    <plan-id>
node ~/.claude/skills/plan/mycelium.mjs approve <plan-id>
node ~/.claude/skills/plan/mycelium.mjs status  <plan-id>
node ~/.claude/skills/plan/mycelium.mjs events  <plan-id>
```

- **The dashboard** is at `https://<orchestrator>/ui`.
- **Cancel is your brake.** A running plan can be cancelled from the dashboard or the CLI; it
  cascades to the tasks and tears the environment down.
- **A plan cannot outrun its budget.** A cost ceiling per task, one across the whole plan, and a
  provider-side limit on a dedicated API key behind both.
- **Deploying a change:** `git pull && pnpm install --frozen-lockfile && pnpm build`, then
  `systemctl restart` — **supervisor last**, because it re-attaches to plans whose agents are
  still answering rather than killing them.

> **Never add `--prod` or `--omit=optional` to the install.** The Agent SDK ships its `claude`
> binary as a platform optional dependency; dropping it makes `query()` throw synchronously.

---

## 2.7 Developing locally, without any VMs

Enough to exercise the whole control plane. No gVisor, no Tailscale, no real agent.

```sh
pnpm install && pnpm build
pnpm db:up                                   # Postgres 17 on host port 15432
docker exec mycelium-postgres createdb -U mycelium mycelium_dev

DATABASE_URL='postgres://mycelium:mycelium@localhost:15432/mycelium_dev' \
OPERATOR_ALLOWLIST='you@example.com' \
node packages/orchestrator/dist/src/index.js

export MYCELIUM_URL=http://127.0.0.1:8080
export MYCELIUM_OPERATOR=you@example.com
```

> **Give the manual run its own database.** The test suite owns `mycelium` and truncates it
> between tests, so an orchestrator running against it will dispatch and mutate their plans
> underneath them — which surfaces as a scatter of unrelated failures rather than as anything
> that names the cause. And stop it when you are done: a dispatcher left ticking in the
> background is the same hazard, one process later.

**In this mode the identity header is self-asserted**, because there is no Serve to inject it.
That is fine on your own loopback, where there is nobody else, **and it is not a deployment.**

Approval needs Gitea; `packages/orchestrator/scripts/stub-gitea.mjs` covers a full local
walk-through.

```sh
pnpm test        # no network, no model calls
pnpm typecheck
```

Three suites are opt-in: the supervisor's Docker/gVisor tests (`SUPERVISOR_DOCKER_TESTS=1`, Linux
only), the systemd scope tests (`SUPERVISOR_SYSTEMD_TESTS=1`), and the agent's live model call
(`WORKER_LIVE_TESTS=1`, **spends real money**). The git driver suites skip themselves if `git` is
absent.

---

*See also: [01 · System Overview](01-system-overview.md) · [03 · Agentic Harness](03-agentic-harness.md) · [Infrastructure](layers/infrastructure.md)*
