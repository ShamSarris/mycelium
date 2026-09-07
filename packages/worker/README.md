# @mycelium/worker — the plan agent

One process per plan, started by the [supervisor](../supervisor/README.md) and torn down with the
environment. It listens on a unix socket, runs one task at a time through the Claude Agent SDK's
`query()` loop (`runner/agent-sdk.ts`), and reports what happened. It holds the plan's credentials
and is assumed prompt-injectable, so nothing in it is a containment boundary — that is the
supervisor's egress proxy and the sandbox.

Specified in ticket 0004. The original build ran a host-owned agent loop over a `ModelTransport`
seam; `tickets/agent-sdk-migration/` (tickets 09–14, 2026-09) replaced that loop with the Claude
Agent SDK, which now owns the loop, conversation state, and context compaction. `tickets/0004`'s §7
is annotated as historical rather than rewritten.

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
| `HOME` | — | not read by `loadConfig()` — the OS-level `HOME` the `claude` subprocess itself picks up. Ticket 15: the supervisor points it inside the plan's `runDir`, isolated per plan |
| `CLAUDE_CONFIG_DIR` | sibling of `WORKDIR` named `claude-config` | the Agent SDK's own state (sessions, auto-memory, connector config). Ticket 15: the supervisor injects a real one nested in `runDir`; the fallback here only matters for local dev or a test with no supervisor |
| `MODEL_ID` | `claude-opus-5` | |
| `MODEL_EFFORT` | `high` | `low` … `max` |
| `MAX_CONCURRENT_SUBAGENTS` | `2` | passed straight to `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`. Ticket 15: the supervisor derives this from its own memory ceiling (`deriveMaxConcurrentSubagents`) and injects it — `MAX_CONCURRENT_AGENTS` no longer exists. The default here only matters with no supervisor (local dev, a test) |
| `COMMIT_CADENCE_WARN_AFTER` | `25` | tool calls before one warn-only event |
| `BROKER_TIMEOUT_MS` / `ORCHESTRATOR_TIMEOUT_MS` | `10000` | |
| `STATUS_RETRY_LIMIT` / `STATUS_RETRY_WINDOW_MS` | `3` / `30000` | |
| `SHUTDOWN_GRACE_MS` / `SHUTDOWN_STATUS_TIMEOUT_MS` | `4000` / `2000` | both under B15's five seconds |

*(2026-09-07: `MODEL_MAX_TOKENS` and `BYTES_PER_TOKEN` used to be listed here as dead variables
pending ticket 14's cleanup. Ticket 14 has since removed both from `config.ts`, so the rows are
gone from this table too. `fileReadMaxBytes` / `fileWriteMaxBytes` / `listFilesMaxEntries` below are
now the same kind of leftover — ticket 10 deleted the `read_file`/`write_file`/`list_files` tools
they bounded, but `config.ts` and its test still declare all three. Flagged for the operator, not
removed here — it is source code, out of this ticket's scope.)*

## Tools

*(2026-09-07: rewritten. `tickets/agent-sdk-migration/10-tools-as-mcp-server.md` and
`11-agent-sdk-runner.md` replaced the three custom file tools this section used to describe
(`read_file`, `write_file`, `list_files`) with the SDK's built-in file tools, described below.)*

Two groups. The worker's own four tools — `sandbox`, `git`, `task_complete`, `task_failed`
(`runner/tools.ts`) — are declared as an in-process MCP server with Zod schemas and validated the
same way as before, just through `createSdkMcpServer()` instead of hand-written JSON Schema and
`domain/args.ts`. `sandbox` runs a command in the gVisor container with the checkout mounted at
`/workspace`; `git` holds the bot token and commits/pushes host-side; `task_complete` /
`task_failed` are the only way a task ends.

Reading and editing files no longer goes through custom tools. The Agent SDK's own built-in
`Read`/`Write`/`Edit`/`Glob`/`Grep` are enabled instead, contained by a `PreToolUse` hook
(`runner/containment.ts`, ticket 12) that rejects any absolute path escaping the checkout — the
same containment rules `domain/paths.ts` always enforced, wired into the one place the SDK lets a
host deny a tool call before it runs. **`Bash` is deliberately not enabled**: the verification
spike's `/proc` environ-leak question (Q7, `tickets/agent-sdk-migration/01-findings.md`) came back
FAIL, so a `Bash` tool could read the agent's own process environment (and the credentials in it)
in a way the sandbox cannot. `tickets/agent-sdk-migration/17-credential-relocation.md` is a
placeholder follow-up for that; it exists but is not implemented.

A task ends only when one of the terminating tools is called. Text alone does not end it: the model
gets one nudge and then the task fails `no_terminal_call`.

## Running it

Nothing here needs the network. The whole suite runs against a `FakeTaskRunner` (the `TaskRunner`
seam ticket 09 introduced above `runner/agent-sdk.ts`) and in-memory fakes for the broker, the
orchestrator client, and git:

```bash
pnpm vitest run packages/worker
pnpm --filter @mycelium/worker typecheck
```

Two suites are opt-in:

- `packages/worker/test/drivers-git.test.ts` needs `git` on `PATH` and skips itself without it. It
  builds a real repository and a real bare remote in a temp directory.
- `packages/worker/test/integration/live-model.test.ts` **spends real money**. It needs
  `WORKER_LIVE_TESTS=1` and a real `MODEL_API_KEY`, and runs the actual Agent SDK runner end to
  end: a trivial task completing with a real non-zero cost, confirmation that the model can never
  reach a tool outside the declared set (`Bash` included), and — for ticket 12's `PreToolUse`
  containment hook, which is otherwise only checked against the SDK's shipped `.d.ts` types — a
  live check that `file_path` really arrives absolute and that a `deny` decision really blocks the
  call.

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
