# Layer · Orchestrator (the control plane)

> **Package:** `packages/orchestrator` · **Stack:** Fastify 5, `pg` 8, PostgreSQL 17, uuid v7
> **Deployment:** one process, bound to `127.0.0.1:8080`, fronted by Tailscale Serve
> **Trust tier:** trusted

**The orchestrator is deterministic. It is not an agent** (B1). Thinking happens locally in the
planning client; the orchestrator validates, gates, dispatches, records and finalizes. It cannot
misread a plan because it never interprets one.

Postgres is its only state store, and **every database write in the system goes through it** (B4)
— one auth point, one audit trail, one schema owner.

---

## 1 · Internal shape

```mermaid
flowchart TB
    subgraph ROUTES["routes/ — thin: authenticate → call a service → return"]
        OPR["operator.ts<br/>loopback + Tailscale identity"]
        MCH["machine.ts<br/>bearer token"]
        UI["ui.ts<br/>server-rendered HTML"]
    end
    subgraph SERVICES["services/ — each owns its own SQL, no repository layer"]
        PL["plans"]; TK["tasks"]; DI["dispatcher"]; EV["events"]
        FI["finalize"]; AL["alerts"]; MO["monitor"]; SR["supervisorsRegistry"]; PJ["projects"]
    end
    subgraph DOMAIN["domain/ — pure, touches no database"]
        ST["states"]; SE["selection"]; BU["budget"]; CR["criteria"]
        BA["backoff"]; ALD["alerts"]; TE["telemetry"]
    end
    subgraph CLIENTS["clients/"]
        GT["gitea"]; SU["supervisor"]
    end
    PG[("PostgreSQL 17")]

    ROUTES --> SERVICES --> DOMAIN
    SERVICES --> PG
    SERVICES --> CLIENTS
    UI --> VIEWS["views/ — template literals, no framework"]
```

The dispatcher is **one `tick()` function** that tests drive directly with an injected clock.

---

## 2 · The two state machines

Both are encoded as data, and **every transition outside them is refused**, so no handler can
invent one.

```mermaid
stateDiagram-v2
    [*] --> proposed
    proposed --> queued: approved
    proposed --> rejected
    queued --> provisioning: selecting_supervisor
    provisioning --> running: supervisor_accepted
    provisioning --> queued: no_healthy_supervisor /<br/>all_candidates_rejected /<br/>dispatch_prepare_failed
    provisioning --> finalizing: validation_failed
    running --> finalizing: all_tasks_terminal / halt /<br/>ttl_expired / supervisor_lost
    finalizing --> done: criteria_passed
    finalizing --> failed: criteria_failed
    proposed --> cancelled
    queued --> cancelled
    provisioning --> cancelled
    running --> cancelled
    finalizing --> cancelled
    done --> [*]
    failed --> [*]
    rejected --> [*]
    cancelled --> [*]
```

`provisioning → finalizing` is a direct edge because a supervisor's `validation_failed` rejection
is **terminal and still needs a manifest**. Cancellation is folded into every non-terminal row
rather than special-cased.

```mermaid
stateDiagram-v2
    [*] --> pending
    pending --> ready: dependencies_satisfied
    ready --> dispatched: claimed
    dispatched --> running: acknowledged
    dispatched --> ready: lease_expired /<br/>dispatch_failed
    running --> done: reported
    running --> failed: reported
    running --> ready: retry_N_of_M
    pending --> cancelled
    ready --> cancelled
    dispatched --> cancelled
    running --> cancelled
```

Two edges are deliberately **illegal**:

| Not allowed | Why |
| --- | --- |
| `dispatched → done` | The agent must acknowledge first. That acknowledgement is what clears the lease |
| `failed → ready` | A failed task cannot be retried by state change alone — retry happens *before* `failed`, inside `applyFailure` |

**A terminal task failure halts its plan** (B17): siblings are cancelled and the plan moves to
`finalizing`. v1 has no `skip`, so a failed task can never become satisfied and `all_tasks_done`
can never pass; letting siblings run on would spend money on a plan already lost. The plan still
*finalizes*, so the manifest records what happened rather than the plan simply stopping.

### Two counters, never confused

`tasks` carries **`dispatch_attempt`** (transport recovery — lease expiry, a supervisor that
refused) and **`execution_attempt`** (failure-policy retries). Conflating them would make a
flaky network look like a failing task.

---

## 3 · The dispatcher tick

Runs every `DISPATCHER_INTERVAL_MS` (default 2 s), plus on a `LISTEN mycelium_wake` notification.
*The interval is the guarantee that work progresses; the notification is only a hint that
shortens the wait.* A failing tick is logged and never kills the loop.

```mermaid
flowchart TB
    T1["1 · provisionQueuedPlans"] --> T2["2 · expireLeases"]
    T2 --> T3["3 · enforceWallClock"]
    T3 --> T4["4 · promoteAcrossRunningPlans"]
    T4 --> T5["5 · dispatchReadyTasks"]
    T5 --> T6["6 · detectLostSupervisors"]
    T6 --> T7["7 · enforceTtl"]
    T7 --> T8["8 · finalizeTerminalPlans"]
```

**Order matters:** promotion runs before dispatch so a task unblocked *this* tick can also be
dispatched by it.

### Phase 1 — provisioning and first-fit failover

```mermaid
flowchart TB
    Q["plans WHERE state='queued'<br/>AND approved_at IS NOT NULL<br/>AND next_provision_at &lt;= now"] --> CLAIM["claim: state → provisioning"]
    CLAIM --> SEL["selectSupervisors(env, healthy, ORDER BY priority, id)"]
    SEL -->|"no candidates"| RQ["back to queued<br/>+ exponential backoff"]
    SEL --> LOOP["first-fit over candidates"]
    LOOP -->|"accepted"| RUN["state → running, agent_id set (STICKY)<br/>ttl_expires_at set, promote tasks"]
    LOOP -->|"429 capacity_exceeded<br/>OR network error"| NEXT["try the next candidate"]
    LOOP -->|"400 validation_failed"| FAIL["state → finalizing<br/>TERMINAL — stop trying"]
    NEXT -->|"exhausted"| RQ
```

> **B12 — selection is an optimisation, not a correctness mechanism.** The supervisor owns
> capacity truth and rejects, so a poor pick self-corrects. First-fit buys failover and multi-VM
> capacity for the cost of an `ORDER BY`, stays deterministic enough to replay from the event
> log, and leaves `priority` as a manual placement lever. **Nothing in `selection.ts` consults
> capacity** — that would give the orchestrator a second, heartbeat-stale copy of a fact the
> supervisor already owns.

The client turns an **unreachable** supervisor into `capacity_exceeded` — treating a dead VM
exactly like a full one is what makes first-fit *failover* rather than just placement. A
supervisor that cannot explain its rejection is likewise treated as full; only an explicit
`validation_failed` is terminal.

Backoff on requeue is exponential from 5 s, doubling, capped at 300 s, recorded on the plan row
as `provision_attempts` / `next_provision_at`.

### Phase 5 — claiming a task

```sql
UPDATE tasks SET state='dispatched', dispatch_id=$2,
                 dispatch_attempt = dispatch_attempt + 1, lease_expires_at=$3
 WHERE id = ( SELECT id FROM tasks
                WHERE plan_id=$1 AND state='ready'
                ORDER BY local_id
                FOR UPDATE SKIP LOCKED          -- the queue mechanism
                LIMIT 1 )
```

The whole claim runs inside a transaction that **takes the plan row `FOR UPDATE` first**, so two
concurrent ticks cannot both read the same in-flight count and overshoot the concurrency cap.

> **Lock order is always plan-then-tasks.** Every writer takes those two in that order —
> `cancelPlan`, `haltPlan`, `abortRunningPlan`, `enforceWallClock`, `claimNextTask` — which is
> what makes concurrent ticks deadlock-free.

**Postgres is the queue** (B3): durable task rows plus leases, `FOR UPDATE SKIP LOCKED` to claim,
and `LISTEN/NOTIFY` as a wake-up hint backed by a periodic sweep. Fewer moving parts than a
broker at this scale.

### Recovery mechanisms

| Mechanism | Trigger | Effect |
| --- | --- | --- |
| **Lease expiry** | `lease_expires_at < now` on a `dispatched` task | → `ready`, `task.lease_expired` event. Default `LEASE_SECONDS=60` |
| **Immediate requeue** | the supervisor refused or was unreachable | → `ready` **without waiting out the lease** |
| **Wall clock** | `started_at + wall_clock_min + WALL_CLOCK_GRACE_MIN` | `limit.exceeded` event, then the failure policy applies |
| **TTL** | `ttl_expires_at < now` on a running plan | abort → `finalizing`, reason `ttl_expired` |
| **Lost supervisor** | no heartbeat for `SUPERVISOR_LOST_MIN` (5) | abort → `finalizing`, reason `supervisor_lost` |

> **`detectLostSupervisors` is a deliberate divergence from baseline §10**, which said a running
> plan on an unhealthy VM continues to its TTL — which may be four hours away. Setting
> `SUPERVISOR_LOST_MIN` very high restores the original behaviour.

---

## 4 · The approval gate (G2)

**Approval is a database precondition, not a prompt convention** (B2). The dispatcher's query
filters on `approved_at IS NOT NULL` — not on `state = 'queued'` alone. No prompt can bypass a
column.

```mermaid
sequenceDiagram
    participant OP as Operator (plan skill)
    participant OR as Orchestrator
    participant GT as Gitea
    participant MEM as TokenCache (process memory)

    OP->>OR: POST /plans/:id/approve
    OR->>OR: already approved? → idempotent return, no Gitea work
    OR->>OR: state must be 'proposed' → else 409
    OR->>GT: ensureRepo (if needed) · createBranch plan/&lt;id&gt; from main
    OR->>GT: createBotToken → a per-plan BOT USER with write on one repo
    Note over GT: Gitea tokens are user-scoped, not repo-scoped.<br/>Isolation = a bot user + branch protection.<br/>The "ref" IS the username; revoking = deleting the user.
    OR->>OR: mintToken() — 32 random bytes
    OR->>OR: UPDATE … WHERE state='proposed' AND approved_at IS NULL
    Note right of OR: compare-and-set: a concurrent approve<br/>cannot double-mint. Loser revokes its bot and 409s.
    OR->>MEM: tokens.set(planId, {orchestratorToken, giteaBotToken})
```

Gitea failure returns **502 `gitea_unavailable`** and leaves the plan `proposed` — approve is
retryable. Repo creation at propose time is likewise done *outside* the transaction, so a network
failure at Gitea cannot lose the plan.

---

## 5 · Secrets and per-plan tokens (B18)

```mermaid
flowchart LR
    APPROVE["approve"] --> MINT["mintToken() + createBotToken()"]
    MINT --> HASH[("Postgres:<br/>agent_token_hash,<br/>gitea_bot_token_ref")]
    MINT --> CACHE["TokenCache — process memory ONLY"]
    CACHE --> DISPATCH["plan dispatch<br/>the one time it leaves this process"]
    DISPATCH --> SUP["Supervisor → agent env"]
    RESTART["orchestrator restart"] --> EMPTY["cache empty"]
    EMPTY --> REMINT["ensurePlanSecrets: mint a REPLACEMENT,<br/>rewrite the hash, revoke the old bot"]
```

> §7 requires these are never at rest, and the gap between approval and dispatch is the only
> window in which storing them would be convenient. A process-local cache keeps the property
> literally true, and **a restart costs a fresh token rather than a stuck plan.** The
> alternative — a plaintext column cleared after dispatch — would put both secrets into every
> `pg_dump` taken during that window.

**Long-lived secrets** go through one `loadSecret(name)` helper (B13), reading systemd's
`$CREDENTIALS_DIRECTORY` in preference to the environment, *so a stale variable cannot outrank
what systemd decrypted*. An absent secret is empty, not fatal — an unconfigured Gitea token is a
legitimate development state.

**Destruction points:** `agent_token_hash = NULL` on cancel and on finalize; `tokens.delete()` in
`releasePlanResources`, which also revokes the Gitea bot user and authorises teardown.

---

## 6 · Budget enforcement

```ts
wouldCrossCeiling({ spentOnOtherTasks, taskCeiling, planCeiling })
  => spentOnOtherTasks + taskCeiling > planCeiling
```

Checked **inside the claim transaction, after the plan row is locked**, so check and claim cannot
be split.

Three properties are deliberate:

1. **`spentOnOtherTasks` excludes the candidate task's own spend.** `limits.cost_microusd` is
   task-wide across execution attempts; counting both would charge the allowance twice and make
   every retry impossible.
2. **It sums every *other* task whatever state it ended in** — a failed attempt spent its cost
   too.
3. **It checks the task's *ceiling*, not an estimate of its use.** A ceiling is what the plan
   authorised.

`max_cost_microusd` is **required and has no default**: nothing in the process holds a price
table, so a cost ceiling cannot be inferred from task ceilings the way a token ceiling once was.
Requesting it is what replaced the default.

Crossing it **halts the plan** rather than stalling it, so the operator gets a manifest. The
event payload — `{limit: 'plan_cost', allowed, spent_on_other_tasks, next_task_ceiling}` — is
exactly what the alert rule keys on.

> **`sum(cost_spent_microusd)` over `tasks` is the *only* definition of a plan's spend.** No plan
> row carries one. Every such sum casts `::bigint`, never `::int` — microusd overflows int4 at
> $2,147.48.

---

## 7 · The database

```mermaid
erDiagram
    projects ||--o{ plans : has
    plans ||--o{ tasks : has
    tasks ||--o{ task_dependencies : "task_id"
    tasks ||--o{ task_dependencies : "depends_on_task_id"
    agents ||--o{ plans : "agent_id (sticky)"
    agents ||--o{ events : "ingested_by"
    events ||--o| alert_acknowledgements : "acknowledged"
```

| Table | Notable columns |
| --- | --- |
| `projects` | `name` UNIQUE, `gitea_repo` nullable |
| `agents` | a registered supervisor: `env`, `enabled`, `priority`, `last_heartbeat_at`, `token_hash`, `last_metrics` jsonb, `last_metrics_at` |
| `plans` | `spec` jsonb (validated, defaults filled), `approved_at`/`approved_by`, `agent_id` (**sticky**), `agent_token_hash`, `gitea_bot_token_ref`, `provision_attempts`/`next_provision_at`, `running_at`/`ttl_expires_at`, `manifest`, `terminal_reason` |
| `tasks` | `local_id` (UNIQUE with `plan_id`), `spec`, **`execution_attempt` + `dispatch_attempt`**, `dispatch_id`, `lease_expires_at`, `tokens_spent` int, `cost_spent_microusd` **bigint** |
| `task_dependencies` | the DAG edges |
| `events` | append-only; `event_id` PK, UNIQUE `(stream_id, seq)`, `ingested_by` |
| `alert_acknowledgements` | `event_id` PK — acknowledgement is a *separate row*, never a mutation |

### Two guarantees written into the schema

**Append-only by trigger, not by convention** — *"a silent rewrite of history is the one bug the
log cannot help debug"*:

```sql
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION events_are_append_only();
```

`TRUNCATE` does not fire row-level triggers, so test teardown still works.

**Two distinct idempotency keys on ingest:**

| Key | Meaning | Response |
| --- | --- | --- |
| `event_id` | benign replay after a spool crash | silently dropped (`ON CONFLICT DO NOTHING`) |
| `(stream_id, seq)` | *a reused sequence number* — an emitter bug | **409 `seq_reused`** |

### Migrations

Plain SQL, numbered, **roll-forward only** — a bad migration is corrected by the next one, never
undone. Applied at startup, each in its own transaction. `0004_cost_budgets.sql` did the
token→cost conversion, including in-place JSONB rewrites of `plans.spec` and `tasks.spec`, and
deliberately **did not touch `plans.manifest`** — those are historical, immutable totals, so
readers stay dual-read rather than have a migration rewrite history.

### One writer, enforced (B16)

```sql
SELECT pg_try_advisory_lock(hashtext('mycelium-orchestrator'))
```

Taken at startup on a **dedicated connection** held for the life of the process. Two
orchestrators would both claim leased tasks and dispatch them twice — *and in the event log that
looks like a supervisor bug rather than a control-plane one, the hardest class of failure to
trace.* The lock costs one connection and fails loudly at boot instead of quietly under load.

**UUIDv7 keys are minted app-side**: opaque like v4 — plan ids appear in dashboard URLs and
branch names and must leak nothing — but time-ordered, so high-insert tables do not fragment
their indexes.

---

## 8 · HTTP surface

### Operator routes — loopback + Tailscale identity

```mermaid
flowchart LR
    BR["Browser / plan skill"] -->|"HTTPS on the tailnet"| SERVE["Tailscale Serve<br/>terminates TLS<br/>STRIPS any client Tailscale-User-* header<br/>INJECTS the real one"]
    SERVE -->|"127.0.0.1:8080"| APP["requireOperator"]
    APP --> C1{"remoteAddress is loopback?"}
    C1 -->|no| F403["403"]
    C1 --> C2{"tailscale-user-login present?"}
    C2 -->|no| F401["401"]
    C2 --> C3{"on OPERATOR_ALLOWLIST?"}
    C3 -->|no| F403
    C3 --> OK["proceed — the login is the attribution"]
```

**The loopback rule is what makes the header trustworthy.** The orchestrator binds
`127.0.0.1` only, so the header cannot arrive from anywhere except Serve, which strips
client-supplied copies. An empty allowlist authorises nobody.

| Route | Purpose |
| --- | --- |
| `POST /plans` | propose — returns `{plan_id, project_id, state, assumptions, egress}` |
| `GET /plans` · `GET /plans/:id` | list / detail with tasks and manifest |
| `POST /plans/:id/approve` · `/reject` · `/cancel` | the gate |
| `GET /projects` · `/projects/:id` · `/agents` · `/events` | read models |

`publicPlan()` is a **deliberate allowlist projection** that omits `agent_token_hash` and
`gitea_bot_token_ref` — the shared `PLAN_COLUMNS` select list includes them because the
dispatcher needs them.

### Machine routes — bearer tokens, looked up by hash

| Route | Caller | Notes |
| --- | --- | --- |
| `POST /supervisors/:id/heartbeat` | supervisor | body deliberately **unvalidated at the route** |
| `GET /supervisors/:id/assignments` | supervisor | plans placed here + per-stream high-water marks |
| `POST /events` | supervisor **or** plan agent | batch ingest, ≤ 500 |
| `POST /plans/:id/tasks/:taskId/status` | plan agent | the agent's *only* write path into task state |

Only hashes are stored, and lookup is *by* hash, so a miss is indistinguishable from a wrong
token. Path ids are compared against the token's own identity — a token cannot act for another
supervisor or another plan.

> **Why the heartbeat body is unvalidated:** a bad metrics report must degrade to "no report",
> never to a 400 that costs a working VM its dispatch eligibility. The test suite states the
> guarantee directly: *can adding telemetry ever cost a working VM its place in the rotation?*
> The answer must be no for every shape — `{}`, `null`, a string, unknown keys, `Number.MAX_VALUE`
> — all return 200 and advance the heartbeat.

### Event ingest authorisation

```mermaid
flowchart TB
    B["POST /events — an array ≤ 500"] --> V["every envelope through validateEvent"]
    V --> S{"envelope.source == caller.kind?"}
    S -->|yes| P
    S -->|"supervisor carrying source='agent'"| REL["RELAY — allowed"]
    REL --> RP{"names a plan placed on THIS supervisor?"}
    RP -->|no| F403["403"]
    RP --> P
    S -->|otherwise| F403
    P{"any payload key looksLikeSecretKey?"} -->|yes| F400["400 secret_in_payload"]
    P -->|no| TX["ONE transaction for the whole batch"]
```

A supervisor may carry its agents' events because **the agent emits over the local RPC socket and
the supervisor spools to disk — the only path that survives an orchestrator outage.** The whole
batch is one transaction so a supervisor's disk spool never half-drains.

The secret-key predicate is imported from `@mycelium/contracts` and **shared with the
supervisor's emit guard**, because a key one side accepts and the other refuses would wedge the
spool permanently.

---

## 9 · The dashboard

Server-rendered HTML **inside the orchestrator process** — no Vite, no React, no build step, no
client-side routing. Ticket 0008 records the trade: with polling already chosen, one operator,
and a tailnet-only page, an SPA's advantages went almost entirely unused while its costs were
real. Rendering in Fastify also keeps identity enforcement at the same single point, *because it
is the same process*.

| Page | Regions | Shows |
| --- | --- | --- |
| **Overview** `/ui` | attention, alerts, plans, workers | what needs you, what broke and is unacknowledged, every plan and **why it is not running**, whether the VMs are alive |
| **Plan** `/ui/plans/:id` | header, actions, assumptions, non-goals, envelope, tasks, subagents, manifest, events | the approval gate, per-task cost/attempts, the subagent roster and runs, the manifest |
| **Projects** | projects, plans | per-project rollup, reusing the overview's plan table so two tables cannot drift |
| **Servers** | servers | heartbeat age *and metrics age separately*, CPU/memory/disk, counts labelled `(reported)` |
| **Monitor** | window, throughput, spend, latency, failures, events | 1/7/30-day rollups, a hand-rolled inline-SVG sparkline, p50/p95 latency |

### Rendering and safety

`html` is a **tagged template that escapes every interpolation**, so forgetting is impossible.
`views/model.ts` builds `PlanView`/`AgentView` by naming fields, making the view types
*structurally incapable of holding a credential hash* — previously that was caught only by a test
scanning rendered output for hash-shaped strings.

### Live updates: polling with a version check

```mermaid
flowchart LR
    DOC["Document: every region rendered inline<br/>&lt;section data-region data-v='fnv1a'&gt;"] --> JS["LIVE_SCRIPT — the only client-side code"]
    JS -->|"every 5s, fetch /ui/live/*"| FR["{as_of, attention, regions:{id:{v, html}}}"]
    FR --> CMP{"v unchanged?"}
    CMP -->|yes| SKIP["skip entirely — an idle system mutates no DOM"]
    CMP -->|no| FOC{"contains document.activeElement?"}
    FOC -->|yes| SKIP2["leave it alone"]
    FOC -->|no| SWAP["swap innerHTML,<br/>restoring open &lt;details&gt;"]
```

- **401 / 403 / 404 stop the poll permanently** — none of those recover on their own.
- **Two consecutive failures** mark the page stale; one miss is a blip.
- A hidden tab stops its timer and refetches on return, because a throttled poll would report a
  time it did not really check at.
- Without JavaScript every page is a complete snapshot that says `static`.

This replaced a `location.reload()` every five seconds, which discarded scroll, selection, focus
and open `<details>`.

### Colour carries meaning

One accent for links and for work that succeeded; **amber only ever means "waiting on you"; red
only ever means "this broke."** Nothing else is coloured — *"which is what lets a red row be
noticed from across a room."*

`formatCost` converts at the view boundary, never in a query, and renders **`<$0.01`** for a
non-zero amount under one cent, because *a task that cost something must never render as free*.

---

## 10 · Configuration reference

| Env var | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://mycelium:mycelium@localhost:15432/mycelium` | password folded in from the systemd credential if absent |
| `HOST` / `PORT` | `127.0.0.1` / `8080` | **loopback only** — Serve is the front door |
| `OPERATOR_ALLOWLIST` | `''` → `[]` | Tailscale **LoginName** (e.g. `you@github`), not necessarily an email. Empty authorises nobody |
| `GITEA_BASE_URL` / `GITEA_OWNER` | `http://localhost:3000` / `mycelium` | owner must be a Gitea **organisation** |
| `LEASE_SECONDS` | `60` | |
| `WALL_CLOCK_GRACE_MIN` | `2` | |
| `SUPERVISOR_LOST_MIN` | `5` | set very high to restore hold-to-TTL |
| `HEARTBEAT_HEALTHY_MIN` | `2` | |
| `DISPATCHER_INTERVAL_MS` | `2000` | |

All three timings above the interval are *judgement calls rather than anything the goals imply*,
which is exactly why they are configuration.

---

## 11 · Known caveat

> `HttpGiteaClient` **has never been exercised against a live Gitea** in its entirety — it is
> verified against mocked HTTP. Its header says so. The first bring-up already found one real
> defect this way: `POST /users/{name}/tokens` requires HTTP Basic auth *as the user itself*, and
> an admin token cannot mint another user's token, so no plan could get push access until
> `createBotToken` was rewritten to delete-then-create the bot user and authenticate as it.

---

*See also: [Flow of use](../02-flow-of-use.md) · [Evaluation](../07-evaluation.md) · [Observability](../08-observability.md) · [Supervisor](supervisor.md)*
