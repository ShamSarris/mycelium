# Mycelium

A single-operator system for agentic software development, scraping, and research.

You plan conversationally in Claude Code, approve the plan, and it executes on a remote VM: an
LLM agent works through a task DAG, runs code in a gVisor sandbox, and commits to a branch. Every
tool call, limit and error is recorded append-only and visible in a dashboard on your phone. Nothing
is exposed to the public internet — the tailnet is the perimeter.

The design and the reasoning behind every decision are in a baseline document kept outside this
repository, alongside one ticket per build step. What is here is the system and how to run it; the
READMEs cite baseline sections and ticket numbers where the *why* lives, and those citations point
at documents a clone does not carry.

---

## Status, honestly

Everything is built and tested — 892 tests, four packages, the plan skill and the dashboard.

**The system has never run end to end.** Every test is against a fake, a local Postgres, or a
temporary git repository. `infra/` was written from the configuration the code reads and
self-checked as far as a development machine allows, but no VM has ever executed a plan. Your first
bring-up is the first run, and it will find things. [`infra/verify.sh`](infra/verify.sh) exists to
make that discovery orderly rather than mysterious.

---

## What you need before you start

| | |
| --- | --- |
| **Two cloud VMs** | Debian 13. See sizing below. |
| **A Tailscale account** | The free plan is enough. Both VMs and your own machine join the same tailnet. |
| **An Anthropic API key** | From console.anthropic.com. **Set a spend limit on it** — it is the account-wide backstop behind the per-plan ceiling, and nothing in this repo can check that you did. |
| **A Gitea instance** | Installed on the orchestrator VM as part of the bring-up. It hosts the repositories mycelium creates for you — one per project. Not this one: mycelium's own source is cloned from GitHub. |
| **Claude Code, locally** | The plan skill runs there. It talks to the orchestrator over the tailnet. |

### Sizing

The defaults matter here, because the configured ceilings allow more than a small VM has.

**Orchestrator VM** — Postgres, Gitea, and a Node process that makes no model calls. Modest and
predictable.

> **2 vCPU, 4 GB RAM, 80 GB disk.** Disk is for Postgres, the Gitea repositories, and a fortnight of
> nightly dumps.

**Worker VM** — the supervisor, the plan agents, and their sandboxes. Its worst case is set by
configuration rather than by typical load:

| | Default | Worst case |
| --- | --- | --- |
| Plan agents | `MAX_ENVIRONMENTS=2`, slice capped at 4 GB | 4 GB |
| Sandboxes | `MAX_ENVIRONMENTS` × `MAX_SANDBOXES_PER_ENVIRONMENT` (4) × `SANDBOX_MEMORY_MB` (1024) | 8 GB |
| Supervisor, Docker, OS | | ~1.5 GB |

So the **defaults can ask for about 14 GB** even though a normal plan uses a fraction of it. Two
honest options:

> **16 GB, 8 vCPU** and leave the defaults alone; or
> **8 GB, 4 vCPU** with `MAX_SANDBOXES_PER_ENVIRONMENT=2`, which caps sandboxes at 4 GB and fits
> comfortably.

Start with the second. Raise it when a plan actually wants more parallelism.

**gVisor needs a real VM**, not a container-based VPS (OpenVZ, LXC): it runs its own kernel and
needs Docker. It does *not* need nested virtualisation — `runsc`'s default platform works on any
ordinary x86-64 or arm64 cloud instance.

### Cost

Baseline goal G5 is $50–200/month all in, and **token spend dominates** — agents are event-driven
and never poll a model while idle, which is what keeps that true.

At the shapes above, VMs land around $25–45/month on a provider like Hetzner, roughly double that on
DigitalOcean or Vultr. Prices move; the shapes are the point. That leaves most of the budget for
tokens, which is the right split.

---

## Running it in the cloud

### 1. Provision

Create both VMs with Debian 13. Give them names you will recognise on the tailnet —
`mycelium-orchestrator` and `mycelium-worker-1` — because those names end up in `serve.json`, in the
supervisor's configuration, and in every URL you type afterwards.

Nothing needs a public firewall rule. Tailscale makes its own connections outbound, and no service
here binds a public interface.

### 2. Join the tailnet

Install Tailscale on both VMs and on your own machine, and bring them all up on the same tailnet:

```sh
curl -fsSL https://tailscale.com/install.sh | sudo sh
sudo tailscale up
tailscale ip -4        # note this; you will need both VMs' addresses
```

Enable **MagicDNS** in the Tailscale admin console so the VMs have stable hostnames. Serve's
configuration uses one.

### 3. Bring up both VMs

Follow **[infra/README.md](infra/README.md)** from here. It covers, in order: the common base
(Node, the service user, the checkout), encrypting the credentials, Postgres and Gitea, the systemd
units, Tailscale Serve, registering the worker, Docker and gVisor, and `verify.sh` at each stage.

Two things in it are worth knowing before you start, because they are where a bring-up goes wrong:

- **Serve is the only ingress to the orchestrator — for supervisors as well as for you.** The
  orchestrator binds loopback and nothing else. That is what lets one listener serve two audiences
  without anything reaching a public interface, and it means Serve stopping takes heartbeats with it.
- **Verify by hand that Serve strips a client-supplied identity header.** The runbook gives the
  exact `curl`. Everything about the operator surface rests on it, and no script can check it for
  you. If it fails, stop.

### 4. Set the skill up locally

On your own machine, in this repository:

```sh
export MYCELIUM_URL=https://mycelium-orchestrator.your-tailnet.ts.net
export MYCELIUM_OPERATOR=you@example.com     # must match OPERATOR_ALLOWLIST on the VM
```

Then open Claude Code here and use the **plan** skill. It reads
[`skills/plan/SKILL.md`](skills/plan/SKILL.md), writes a plan from your conversation, submits it,
and shows you the assumptions to approve. There is a template and two worked examples beside it.

### 5. Run one plan

Make the first one small — one task, something obviously verifiable. It costs real tokens, and what
you are testing is the path, not the work.

```sh
node skills/plan/mycelium.mjs propose plan.json
node skills/plan/mycelium.mjs show <plan-id>       # read the assumptions properly
node skills/plan/mycelium.mjs approve <plan-id>
node skills/plan/mycelium.mjs status <plan-id>
```

Watch it at **`https://<orchestrator>/ui`** — from your phone if you like; it is on the tailnet. The
plan finishes with a manifest carrying the branch, the head SHA and the pull request URL. Merging
that PR is yours, always: the system opens it and stops.

---

## Running it locally, without any VMs

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

Then point the skill at it:

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

## What is where

```
packages/contracts/     the plan and event schemas, and their validators
packages/orchestrator/  the control plane: validation, approval, the DAG dispatcher, events, the dashboard
packages/supervisor/    one daemon per worker VM: environments, the sandbox broker, the egress proxy
packages/worker/        the plan agent: the host-owned model loop, its tools, its budget
skills/plan/            the Claude skill that authors and submits plans
infra/                  systemd units, credentials, gVisor, Serve, and the bring-up runbook
migrations/             Postgres DDL, numbered and roll-forward only
```

Each package has its own README covering its configuration and how to run it alone.

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
