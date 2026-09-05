# @mycelium/supervisor

The one persistent daemon on a worker VM. It accepts a plan dispatch from the orchestrator, provisions an ephemeral plan-agent environment, proxies task dispatch to it, brokers gVisor sandbox launches, enforces the plan's egress allowlist, relays events, and tears the environment down when the plan ends. It has no LLM loop and no durable state beyond its event spool.

Built to ticket 0003, baseline step 3.

## Configuration

Everything comes from the environment through `loadConfig()`. Secrets do not: they are read through `loadSecret()` from `$CREDENTIALS_DIRECTORY`, which systemd populates from `LoadCredentialEncrypted=` (B13).

| Variable | Default | Notes |
| --- | --- | --- |
| `SUPERVISOR_ID` | required | The `agents` row id, from the orchestrator's `register-supervisor.mjs`. |
| `ORCHESTRATOR_URL` | required | |
| `ORCHESTRATOR_PEERS` | required | Comma-separated tailnet addresses allowed to dispatch (B19). Empty is refused. |
| `HOST` | required | The tailnet address. A wildcard bind is refused — see below. |
| `PORT` | `8081` | Must match the `base_url` on the `agents` row. |
| `STATE_DIR` | `/var/lib/mycelium` | Plan checkouts, sockets, and the spool. |
| `MAX_ENVIRONMENTS` | `2` | Capacity (B21). |
| `MAX_SANDBOXES_PER_ENVIRONMENT` | `4` | |
| `SANDBOX_IMAGES` | empty | Comma-separated. Empty means no sandbox can run. |
| `SANDBOX_CPUS`, `SANDBOX_MEMORY_MB` | `1`, `1024` | Ceilings. An agent may ask for less, never more. |
| `SANDBOX_TIMEOUT_SEC`, `SANDBOX_TIMEOUT_CEILING_SEC` | `300`, `3600` | |
| `OUTPUT_HEAD_BYTES`, `OUTPUT_TAIL_BYTES`, `OUTPUT_MAX_BYTES` | `8192`, `8192`, `10 MiB` | |
| `STANDING_EGRESS` | npm and PyPI hosts | Always allowed alongside the plan's list. Set it to include your Gitea host. |
| `HEARTBEAT_INTERVAL_MS` | `30000` | Baseline §10. |
| `RELAY_INTERVAL_MS` | `2000` | |
| `SPOOL_MAX_BYTES` | 1 GiB | On overflow the oldest records are dropped and a marker records the gap. |
| `TEARDOWN_GRACE_MS` | `5000` | SIGTERM to SIGKILL (B15). |
| `TTL_GRACE_MIN` | `5` | How long past a plan's TTL to wait for the orchestrator before acting. |
| `AGENT_COMMAND` | empty | argv for the plan agent, e.g. `/usr/bin/node /opt/mycelium/packages/worker/dist/src/index.js`. Empty means this node can accept no plan. |
| `AGENT_SLICE` | unset | The slice the agent's transient scope is started in. **Not optional in deployment**: without it there is no scope to signal, and an agent left by a previous supervisor process cannot be killed at all (ticket 0004 gap 8). `infra/worker/mycelium-plans.slice` is the slice. |
| `ALLOW_INSECURE_BIND` | unset | Test escape hatch. No unit file sets it. |

**Why the bind address is checked.** B19 authenticates the orchestrator by its tailnet address. That is real authentication only because the process is on the WireGuard interface and nowhere else — a packet arriving there cannot forge its source. On a wildcard bind, one arriving on any other interface can, and the allowlist becomes decoration. `loadConfig()` therefore throws at boot on `0.0.0.0` or `::`.

## Running it

```sh
# One-off, against a local orchestrator. Register the supervisor first:
node packages/orchestrator/scripts/register-supervisor.mjs --name dev-vm --env dev \
  --url http://127.0.0.1:8081

SUPERVISOR_ID=<the id it printed> \
SUPERVISOR_TOKEN=<the token it printed once> \
ORCHESTRATOR_URL=http://127.0.0.1:8080 \
ORCHESTRATOR_PEERS=127.0.0.1 \
HOST=127.0.0.1 \
STATE_DIR=/tmp/mycelium \
SANDBOX_IMAGES=alpine:3.20 \
ALLOW_INSECURE_BIND=1 \
node packages/supervisor/dist/src/index.js
```

`GET /healthz` needs no allowlist and reports occupancy and capacity, nothing else:

```sh
curl -s http://127.0.0.1:8081/healthz
{"ok":true,"environments":0,"capacity":2}
```

It will not get far without `AGENT_COMMAND`, because the plan agent is baseline step 4. A dispatch reaches the point of starting one and reports `capacity_exceeded` with a message saying so, which is the correct answer: this node genuinely cannot run a plan yet.

## Tests

```sh
pnpm test                    # everything, against the driver fakes. No Docker, no Postgres.
pnpm typecheck
```

The suite runs on Windows, macOS, and Linux. Two things make that true, both for the reason B22 gives — a suite the operator cannot run is worse than a seam:

- Docker, cgroups, and git sit behind driver interfaces with in-memory fakes.
- Node implements local domain sockets on Windows as named pipes rather than AF_UNIX, so `listenAddress()` falls back to one there.

The real container driver is exercised by one opt-in suite, on Linux with Docker and gVisor:

```sh
SUPERVISOR_DOCKER_TESTS=1 pnpm test
SUPERVISOR_DOCKER_TESTS=1 SUPERVISOR_TEST_IMAGE=alpine:3.20 pnpm test
```

It asserts the properties the fakes cannot: that the container runs under gVisor rather than the host kernel, that its root filesystem is read-only, that it has no route off the host on either the plan network or none at all, that it can still reach a listener on the network gateway where the proxy sits, and that the wall clock kills it.

## What is not here

- The plan agent itself. This ships the seam it is started through; the agent is [`@mycelium/worker`](../worker/README.md), built in ticket 0004.
- systemd units, gVisor installation, and the user namespace — see below.
- The `infra/` units themselves, gVisor installation, and the user namespace — a later ticket. The unit must set `TimeoutStopSec=30s`, comfortably above the 5 s teardown grace, and it must set a **slice**: without one there is no systemd scope to signal, and an agent left behind by a previous supervisor process cannot be killed at all (ticket 0004 section 13).
- The MCP gateway, registry push, and deploy brokers. All are baseline §3 non-goals for v1.
