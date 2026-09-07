# @mycelium/orchestrator

The deterministic control plane: plan validation, the approval gate, the DAG
dispatcher, and the event sink. It makes no model calls. See
baseline sections 4 to 7.

## Running it

```bash
pnpm db:up                     # Postgres 17 on host port 15432
pnpm --filter @mycelium/orchestrator build
DATABASE_URL='postgres://mycelium:mycelium@localhost:15432/mycelium' \
OPERATOR_ALLOWLIST='you@example.com' \
node packages/orchestrator/dist/src/index.js
```

Migrations run at startup. The process then takes a session advisory lock and
exits if another orchestrator already holds it: two writers would both claim
leased tasks.

## Environment

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://mycelium:mycelium@localhost:15432/mycelium` | Host port 15432 (5432 and 5433 are both already in use on this machine). |
| `PORT` | `8080` | |
| `HOST` | `127.0.0.1` | Loopback only. Tailscale Serve is the front door. |
| `OPERATOR_ALLOWLIST` | empty | Comma-separated logins. Empty authorises nobody. |
| `GITEA_BASE_URL` | `http://localhost:3000` | |
| `GITEA_OWNER` | `mycelium` | |
| `GITEA_ADMIN_TOKEN` | empty | Replaced by `loadSecret()` when `infra/` lands (B13). |
| `MIGRATIONS_DIR` | found by walking up | |
| `LEASE_SECONDS` | `60` | Not fixed by the baseline. |
| `WALL_CLOCK_GRACE_MIN` | `2` | Not fixed by the baseline. |
| `SUPERVISOR_LOST_MIN` | `5` | Not fixed by the baseline. Set very high to disable. |
| `HEARTBEAT_HEALTHY_MIN` | `2` | Baseline section 10. |
| `DISPATCHER_INTERVAL_MS` | `2000` | The tick interval. `LISTEN` only shortens the wait. |

## Registering a supervisor

Supervisors do not self-register. The token is shown once; only its hash is
stored.

```bash
DATABASE_URL='postgres://mycelium:mycelium@localhost:15432/mycelium' \
node packages/orchestrator/scripts/register-supervisor.mjs \
  --name worker-dev-1 --env dev --url http://worker-dev-1.tailnet:8080
```

## Tests

```bash
pnpm db:up
pnpm test        # 300+ tests, against real Postgres
pnpm typecheck
pnpm build
```

Test files share one database and truncate between tests, so the root Vitest
config sets `fileParallelism: false`.

## Smoke run

This is the sequence used to verify the build by hand. There is no Gitea yet, so
it uses the stub in `scripts/stub-gitea.mjs`, which answers only the endpoints
`HttpGiteaClient` calls. The worker URL points at a closed port on purpose: the
point is to watch provisioning back off.

```bash
docker exec mycelium-postgres createdb -U mycelium mycelium_smoke
node packages/orchestrator/scripts/stub-gitea.mjs --port 3111 &

DATABASE_URL='postgres://mycelium:mycelium@localhost:15432/mycelium_smoke' \
OPERATOR_ALLOWLIST='sam@example.com' PORT=8099 \
GITEA_BASE_URL='http://127.0.0.1:3111' GITEA_ADMIN_TOKEN='stub' \
DISPATCHER_INTERVAL_MS=1000 \
node packages/orchestrator/dist/src/index.js &

curl -s http://127.0.0.1:8099/healthz

DATABASE_URL='postgres://mycelium:mycelium@localhost:15432/mycelium_smoke' \
node packages/orchestrator/scripts/register-supervisor.mjs \
  --name worker-dev-1 --env dev --url http://127.0.0.1:9999

H='tailscale-user-login: sam@example.com'
PLAN=$(curl -s -X POST http://127.0.0.1:8099/plans \
  -H 'content-type: application/json' -H "$H" -d @plan.json)
PLAN_ID=$(echo "$PLAN" | python -c "import sys,json;print(json.load(sys.stdin)['plan_id'])")

curl -s -X POST "http://127.0.0.1:8099/plans/$PLAN_ID/approve" -H "$H"
curl -s "http://127.0.0.1:8099/plans/$PLAN_ID" -H "$H"
```

What it shows, in order:

1. `POST /plans` returns `proposed` and echoes the assumptions and the declared egress.
2. `POST /plans/:id/approve` returns `queued` with `approved_by` set and the `plan/<id>` branch created.
3. The plan does not run. `provision_attempts` climbs and `next_provision_at` moves out on the 5 s doubling backoff, because the registered supervisor never heartbeat.
4. Heartbeat it, and `GET /agents` reports it healthy. The next attempt reaches the VM, gets `ECONNREFUSED`, and records `all_candidates_rejected`: an unreachable VM is treated exactly like a full one, which is what turns first-fit into failover.

Take the whole thing down with `docker exec mycelium-postgres dropdb -U mycelium mycelium_smoke` and stopping the two node processes.

## Shape of the code

- `domain/` is pure and has no database: the state machines, supervisor selection, backoff, and criteria evaluation.
- `services/` owns its own SQL. There is no repository layer.
- `clients/` holds the two outbound interfaces plus HTTP implementations. Tests use in-process fakes; the HTTP implementations are covered separately against `undici`'s `MockAgent`.
- `routes/` is thin: authenticate, call a service, return.
- The dispatcher is one `tick(deps)` function. Tests call it directly with a controlled clock.
