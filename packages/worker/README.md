# @mycelium/worker — the plan agent

One process per plan, started by the [supervisor](../supervisor/README.md) and torn down with the
environment. It listens on a unix socket, runs one task at a time through a host-owned agent loop,
and reports what happened. It holds the plan's credentials and is assumed prompt-injectable, so
nothing in it is a containment boundary — that is the supervisor's egress proxy and the sandbox.

Specified in ticket 0004.

## The two sockets

Each is one-way, because a server cannot push.

- **`AGENT_SOCKET`** — the supervisor's broker. The agent dials out for `events.emit` and
  `sandbox.run`.
- **`DISPATCH_SOCKET`** — this agent's own listener. The supervisor dials in for `task.dispatch`,
  and restart re-attachment dials in for `agent.ping`.

Both speak one JSON request per connection, one response, close.

Task status does **not** go through the supervisor: the agent posts it to
`POST /plans/:id/tasks/:taskId/status` itself, with the per-plan token. That is what lets a
supervisor restart re-attach without recovering any in-flight task state.

## Environment

Everything without a default is injected by the supervisor at provision time and is required;
missing one throws at startup rather than failing a task later.

| Variable | Default | |
| --- | --- | --- |
| `PLAN_ID`, `PROJECT_ID`, `PROJECT_NAME` | — | identity |
| `ORCHESTRATOR_URL`, `ORCHESTRATOR_TOKEN` | — | the status route and its per-plan token |
| `GITEA_BOT_TOKEN`, `GITEA_BRANCH` | — | the only branch this agent may push |
| `MODEL_API_KEY` | — | |
| `AGENT_SOCKET`, `DISPATCH_SOCKET`, `WORKDIR` | — | the two sockets and the checkout |
| `MODEL_ID` | `claude-opus-5` | |
| `MODEL_EFFORT` | `high` | `low` … `max` |
| `MODEL_MAX_TOKENS` | `64000` | reserved in full before every call |
| `BYTES_PER_TOKEN` | `3` | the estimator's divisor; deliberately pessimistic |
| `MAX_CONCURRENT_AGENTS` | `2` | read and reported, unused until sub-agents exist |
| `FILE_READ_MAX_BYTES` / `FILE_WRITE_MAX_BYTES` | `256 KiB` / `1 MiB` | |
| `LIST_FILES_MAX_ENTRIES` | `500` | |
| `COMMIT_CADENCE_WARN_AFTER` | `25` | tool calls before one warn-only event |
| `BROKER_TIMEOUT_MS` / `ORCHESTRATOR_TIMEOUT_MS` | `10000` | |
| `STATUS_RETRY_LIMIT` / `STATUS_RETRY_WINDOW_MS` | `3` / `30000` | |
| `SHUTDOWN_GRACE_MS` / `SHUTDOWN_STATUS_TIMEOUT_MS` | `4000` / `2000` | both under B15's five seconds |

## Tools

`sandbox` (a gVisor container with the checkout at `/workspace`), `read_file` / `write_file` /
`list_files` (host-side, confined to the checkout), `git` (host-side, holds the bot token), and
`task_complete` / `task_failed`. Every call is validated host-side against the same schema sent to
the provider; a failed call comes back as a tool result the model can correct, never as an
exception.

A task ends only when one of the terminating tools is called. Text alone does not end it: the model
gets one nudge and then the task fails `no_terminal_call`.

## Running it

Nothing here needs the network. The whole suite runs against a scripted transport and in-memory
fakes:

```bash
pnpm vitest run packages/worker
pnpm --filter @mycelium/worker typecheck
```

Two suites are opt-in:

- `packages/worker/test/drivers-git.test.ts` needs `git` on `PATH` and skips itself without it. It
  builds a real repository and a real bare remote in a temp directory.
- `packages/worker/test/integration/` **spends real money**. It needs `WORKER_LIVE_TESTS=1` and a
  real `MODEL_API_KEY`, and makes three calls: one for usage, one to prove the cache prefix is
  actually being read back, one for a tool call.

```bash
WORKER_LIVE_TESTS=1 MODEL_API_KEY=sk-ant-... pnpm vitest run packages/worker/test/integration
```

To run the agent by hand against a supervisor, set `AGENT_COMMAND` on the supervisor to
`node /path/to/packages/worker/dist/src/index.js` after `pnpm --filter @mycelium/worker build`.

## Shutdown

`SIGTERM` from the supervisor's teardown. In order: abort the model call, record the abort as an
event on the supervisor's local spool, report the task failed on a two-second deadline with no
retries, unlink the socket, exit. The whole path fits inside B15's five seconds.

**There is no rescue push.** B15 rejected one: it makes teardown unbounded, manufactures WIP
commits, and contradicts the operator on a cancel. Uncommitted work is lost, and the commit cadence
is the cure.
