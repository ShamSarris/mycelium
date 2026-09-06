# Mycelium

A single-operator system for agentic software development, scraping, and research.

You plan conversationally in Claude Code, approve the plan, and it executes on a remote VM: an
LLM agent works through a task DAG, runs code in a gVisor sandbox, and commits to a branch. Every
tool call, limit and error is recorded append-only and visible in a dashboard on your phone. Nothing
is exposed to the public internet — the tailnet is the perimeter.

The design and the reasoning behind every decision are in a baseline document kept outside this
repository, alongside one ticket per build step. What is here is the system itself; the READMEs
cite baseline sections and ticket numbers where the *why* lives, and those citations point at
documents a clone does not carry.

---

## Status, honestly

Everything is built and tested — 892 tests, four packages, the plan skill and the dashboard.

**The system has never run end to end.** Every test is against a fake, a local Postgres, or a
temporary git repository. `infra/` was written from the configuration the code reads and
self-checked as far as a development machine allows, but no VM has ever executed a plan. Your first
bring-up is the first run, and it will find things. [`infra/verify.sh`](infra/verify.sh) exists to
make that discovery orderly rather than mysterious.

---

## What is where

```
packages/contracts/     the plan and event schemas, and their validators
packages/orchestrator/  the control plane: validation, approval, the DAG dispatcher, events, the dashboard
packages/supervisor/    one daemon per worker VM: environments, the sandbox broker, the egress proxy
packages/worker/        the plan agent: the host-owned model loop, its tools, its budget
infra/                  systemd units, credentials, gVisor, Serve, and the bring-up runbook
migrations/             Postgres DDL, numbered and roll-forward only
```

Each package has its own README covering its configuration and how to run it alone.

---

## Developing locally, without any VMs

Enough to develop against and to exercise the control plane. No gVisor, no Tailscale, no real agent.

```sh
pnpm install
pnpm build
pnpm db:up                          # Postgres 17 on host port 5433

# A database of its own. The test suite owns `mycelium` and truncates it
# between tests, so an orchestrator running against it while the tests run
# will dispatch and mutate their plans underneath them — which surfaces as
# a scatter of unrelated failures rather than as anything that names the
# cause. Give the manual run its own database and the two never meet.
docker exec mycelium-postgres createdb -U mycelium mycelium_dev

DATABASE_URL='postgres://mycelium:mycelium@localhost:5433/mycelium_dev' \
OPERATOR_ALLOWLIST='you@example.com' \
node packages/orchestrator/dist/src/index.js
```

Stop it when you are done — a dispatcher left ticking in the background is the
same hazard as sharing the database, one process later.

Then point the plan skill at it:

```sh
export MYCELIUM_URL=http://127.0.0.1:8080
export MYCELIUM_OPERATOR=you@example.com
```

**In this mode the identity header is self-asserted**, because there is no Serve to inject it. That
is fine on your own loopback, where there is nobody else, and it is not a deployment.

Approval needs Gitea, so for a full local walk-through use the stub in
[`packages/orchestrator/scripts/stub-gitea.mjs`](packages/orchestrator/scripts/stub-gitea.mjs) —
the orchestrator's README has the exact sequence under "Smoke run".

```sh
pnpm test          # 892 tests, no network, no model calls
pnpm typecheck
```

Three suites are opt-in and skipped by default: the supervisor's Docker and gVisor tests
(`SUPERVISOR_DOCKER_TESTS=1`, Linux only), the agent's live model call (`WORKER_LIVE_TESTS=1`,
**spends real money**), and the git driver tests, which skip themselves if `git` is absent.

---

## Deploying it

Two Debian 13 VMs on a tailnet: an orchestrator running Postgres, Gitea and the control plane, and
one or more workers running a supervisor, Docker and gVisor. Neither needs a public firewall rule —
Tailscale makes its own connections outbound, and no service here binds a public interface.

[`infra/`](infra/) holds what a deployment needs: the systemd units, the Serve and Docker daemon
configuration, the nightly backup timer, and `verify.sh`, which checks a host role by role. The
runbook that walks through them in order is kept outside this repository, with the baseline.

## Operating it

- **The dashboard** is at `https://<orchestrator>/ui`. It shows what needs your attention, what
  broke and has not been acknowledged, every plan and why it is not running, and whether the
  workers are alive.
- **Cancel is your brake.** A running plan can be cancelled from the dashboard or with
  `mycelium.mjs`; it cascades to the tasks and tears the environment down.
- **A plan cannot outrun its budget.** Each task has a token ceiling, each plan has one across all
  its tasks, and the API key has a provider-side limit behind both.
- **Deploying a change:** `git pull && pnpm install --frozen-lockfile && pnpm build`, then
  `systemctl restart`. Restart the supervisor last — it re-attaches to plans whose agents are still
  answering rather than killing them.
