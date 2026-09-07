# 9 · Known Drift

> Places where the code and the written record disagreed, found while writing this documentation
> set. **§9.1–§9.3 were resolved on 2026-09-07**; they are kept here with what was decided, because
> a drift log that deletes its own entries teaches nothing. §9.4 onward are still open.

Some of these were the expected residue of the Agent SDK migration, which chose to *annotate*
history rather than rewrite it. Others were genuine oversights.

---

## 9.1 Resolved — behaviour that did not match its documentation

### D1 · The "one nudge" did not exist — **fixed by correcting the documents**

| | |
| --- | --- |
| **Docs said** | `packages/worker/README.md`: *"the model gets one nudge and then the task fails `no_terminal_call`."* Baseline §5 step 6 said the same. |
| **Code did** | Failed immediately with `no_terminal_call`. **No nudge.** `NUDGE` was exported from `runner/prompt.ts` with zero call sites — the host loop that sent it died in ticket 14 and the SDK runner never reinstated one. |
| **Why it mattered** | A model that produced a good final answer as *text* and forgot the terminating call lost the whole task, where the documented behaviour would have recovered it. |
| **Resolution** | **Treat the current behaviour as correct.** `NUDGE` is deleted; the worker README and a dated baseline revision note now describe what the code does. Reinstating a real nudge would need the SDK's multi-turn prompt form and is a deliberate behavioural change, not a fix — it was considered and not made. |

### D2 · `maxBudgetUsd` did not subtract prior spend — **fixed in code**

| | |
| --- | --- |
| **Design says** | `limits.cost_microusd` is *"task-wide across execution attempts"*; `cost_spent_so_far_microusd` exists so *"a retry does not re-grant the whole ceiling."* |
| **Code did** | Passed the **full** ceiling to the SDK on every attempt. Reporting was cumulative; enforcement was not. A task under `retry {max_attempts: 3}` could spend three ceilings. |
| **Resolution** | A new pure module, `packages/worker/src/domain/budget.ts`, computes an attempt's share: `min(ceiling, max(ceiling - spentSoFar, MIN_ATTEMPT_BUDGET_MICROUSD))`. Seven unit tests plus two runner-level tests cover it. |

The floor (`MIN_ATTEMPT_BUDGET_MICROUSD`, $0.05) is the one deliberate exception to strict
task-wide accounting: a retry that can afford nothing produces no diagnosis at all, and an honest
`task_failed` is worth more than the last cents of an already-spent ceiling. It is bounded on both
sides — the clamp means an attempt never gets more than the ceiling, so a task whose whole ceiling
is under $0.05 gets its ceiling rather than the floor, and the plan ceiling remains the real bound
on total spend.

The SDK still checks its budget **after a turn is tallied**, so a single attempt can overshoot by
up to one turn. That regression is inherent — the host never sees a request before it goes out —
and is unchanged.

---

## 9.2 Resolved — documentation that described deleted code

### D3 · The worker README's own "leftovers" note was itself stale

It flagged `fileReadMaxBytes` / `fileWriteMaxBytes` / `listFilesMaxEntries` as still declared in
`config.ts`. They were already gone. **Fixed:** the note now records that all five removed
variables are absent, and claims nothing about what remains.

### D4 · `packages/worker/src/tools/complete.ts` was dead code

`complete()` and `failed()` had no caller — `runner/tools.ts` declares the terminating tools
directly with Zod and writes the outcome box itself. The file's own header admitted it; it survived
only because ticket 14's delete table named it a survivor. **Fixed:** the file is deleted, and the
three comments in `runner/tools.ts` that described it as present are corrected.

`ToolOutcome` keeps its `complete` / `failed` arms deliberately: `TerminalOutcome` is written from
those shapes, and `toCallToolResult` throws loudly if a non-`result` outcome ever reaches it.

### D5 · A stale comment accepted a credential risk that no longer exists

`packages/supervisor/src/environments/provision.ts:73` carried:

> *"The bot token ends up in `.git/config` inside the environment. **Accepted:** the agent holds
> the same token by design, and the tree is scrubbed at teardown."*

It no longer does — the credential-helper change (ticket 0005 part A) passes the token
per-invocation so git persists nothing. This was worse than no comment: a reader auditing the
credential path would have concluded the token was still on disk. **Fixed:** the comment now
describes the credential helper and *why* `.git` inside the checkout made the old arrangement
dangerous.

---

## 9.3 Still open — promises slightly wider than the pipeline

These were reported alongside the four above but not fixed; neither is a defect, and both are
consistent with v1's stated non-goals.

### D6 · `task_complete.notes` has no consumer

The tool describes `notes` as *"Anything the next task should know."* The orchestrator stores it on
the task row — but **`TaskDispatch` carries no upstream-result field**, so nothing feeds it into the
next task's prompt. Today it is an operator-facing record, not a machine-readable hand-off.

Consistent with baseline §3 ("large inputs live in the repo"), but the description promises a little
more than the wiring delivers. Either narrow the description or add the field.

### D7 · Two unrelated things are both called `TaskRunner`

- `runner/runner.ts` — the **interface** `run(dispatch, signal) → TaskOutcome`, the seam above the SDK.
- `dispatch.ts` — a **type alias** `(dispatch: TaskDispatch) => Promise<void>`, the dispatch server's callback.

They never collide at a call site, but the clash is a genuine tripwire when reading the two files
together.

---

## 9.4 Unverified rather than wrong

These are honest gaps the code already flags. They are listed here so a reader does not mistake
"tested" for "proven".

| | |
| --- | --- |
| **The end-to-end smoke run has never happened.** | `tickets/agent-sdk-migration/16-docs-and-smoke.md` §6.5 is the real acceptance gate for the whole migration and is **blocked on live infrastructure**. It needs a real worker VM, a real Gitea, and a real `MODEL_API_KEY`. |
| **The containment hook's deny has never been observed live.** | Spike question Q4 is recorded as **UNRESOLVED, not PASS**. The hook shape and deny capability are confirmed from the SDK's shipped `.d.ts` plus unit tests; the two things a `.d.ts` cannot prove — that `file_path` truly arrives absolute, and that `deny` truly blocks — sit behind a `WORKER_LIVE_TESTS=1` test that has not been run. |
| **`HttpGiteaClient` has never been fully exercised against a live Gitea.** | Its own header says so; it is verified against mocked HTTP. The first bring-up already found one real defect this way (`createBotToken` needed HTTP Basic as the bot user). Treat the remaining request shapes as unproven. |
| **Cost figures are estimates.** | Spike question Q8 is **PARTIAL**: `total_cost_usd` is populated and plausible, but reconciliation against an actual bill is deferred, and the SDK's own docs call these *"an estimate, not a billing statement."* |
| **Nothing in `infra/` is covered by CI.** | `verify.sh` proves the parts, not the whole. |

---

## 9.5 Known-and-accepted, recorded for completeness

Not drift — deliberate choices the code names as open.

- **`dispatchReadyTasks` claims up to 2 tasks per plan, but the worker takes one at a time** and
  409s a second. Effective parallelism is 1, and the extra claim costs a refuse-and-requeue round
  trip each tick. The comment records this as unresolved and left alone because changing it is a
  behaviour change.
- **`detectLostSupervisors` diverges from baseline §10 deliberately.** The baseline says a running
  plan on an unhealthy VM continues to its TTL; the code fails it after `SUPERVISOR_LOST_MIN`
  (5 min). Setting that very high restores the documented behaviour.
- **The orchestrator and supervisor shape their error bodies differently** — `{code, message}` at
  the top level versus `{error: {code, message}}`. Known and unfixed, because the orchestrator's
  already-shipped client reads the supervisor's `code` at the top level.
- **`authorizeTeardown` ignores its response status.** Which is exactly why the supervisor
  enforces its own TTL backstop rather than trusting the authorisation to arrive.
- **`config.ts`'s `intFrom` accepts trailing garbage** (`"5x"` → `5`) and enforces no range or
  positivity. Minor, but it means a typo in an interval silently becomes a plausible number.
- **`update_source.sh` line 15** prints `{Service is set to orchestrator.}` — a brace-wrapped
  echo. Cosmetic.
- **`events` has no retention policy.** One heartbeat row per VM every 30 seconds, forever.
- **`packages/worker` never configures `maxTurns`**, although the event mapper handles a
  `error_max_turns` result subtype. Any turn limit in force is the SDK's own default.

---

## 9.6 The documents this set does not replace

| Document | Status |
| --- | --- |
| `mycelium-baseline.md` | **The design record.** Carries dated revision notes where decisions were reversed (notably B9 and the §5/§6 budget notes) rather than being rewritten — *"a reader needs to see that a decision was reversed and why."* |
| `tickets/` | One ticket per build step, written **before** the code, carrying the decisions the baseline left open. `tickets/agent-sdk-migration/01-findings.md` is the live evidence table behind the harness design. |
| `future_work/` | **A read-only archive of earlier, more detailed thinking.** Where it conflicts with the baseline, the baseline wins for v1. Note especially that `context-management.md` is token-denominated where the code is cost-denominated, and its T10 asserts the very decision (host-owned conversation state) that the migration reversed. |
| Package `README.md`s | Configuration and how to run each package alone. Two known inaccuracies in the worker's, above. |

**Those four are gitignored** — the repository is public and the design reasoning is not. Prose in
the tracked READMEs cites them by name; those are references to documents a clone does not carry.

> **Note for whoever commits this set:** `docs/` is *not* in `.gitignore`, so it will be tracked
> and public. Everything here describes the code, which is already public, and cites the private
> documents by name only — the same convention the existing READMEs use.

---

*Back to: [README](README.md) · [01 · System Overview](01-system-overview.md)*
