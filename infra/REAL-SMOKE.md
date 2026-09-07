# Real-infrastructure smoke run

This V2-001 fixture proves the deployed v1 path end to end: plan proposal and approval, worker
dispatch, repository checkout, a real model call, commit and push, task completion, finalization,
and pull-request creation. It is separate from the local orchestrator smoke run, which only proves
that the dispatcher backs off from an unreachable worker.

`real-smoke.sh` creates a fresh private Gitea project repository on every run. It makes a paid
model call, but it does not modify existing projects or merge its PR. It will not run without
`CONFIRM_REAL_SMOKE=1`.

## Prerequisites

Complete the applicable checks in `infra/README.md` first:

- The orchestrator and a **dev** worker have passed `infra/verify.sh`; the worker is registered,
  healthy, and enabled.
- The worker's `STANDING_EGRESS` includes `api.anthropic.com` and the actual Gitea host.
- The worker's `model_api_key` credential is valid and has a provider-side spend limit.
- Gitea is reachable from the worker; `GITEA_OWNER` is an organisation; and the orchestrator
  credential can create a repository, plan branch, and per-plan bot user.
- Run from a tailnet machine that can reach Tailscale Serve and Gitea. The authenticated caller is
  in `OPERATOR_ALLOWLIST`.
- Create a separate read-only Gitea token. The script uses it only after execution to verify the
  branch, smoke file, and PR; never supply the Gitea admin token.
- `bash`, `curl`, `jq`, and `od` are installed.

Do not put these values in shell history, a checked-in `.env`, or an evidence file.

## Run

From a trusted tailnet checkout (normally the orchestrator VM):

```bash
export SMOKE_ORCHESTRATOR_URL='https://orchestrator.tailnet.example'
export SMOKE_OPERATOR_LOGIN='you@example.com'
export SMOKE_GITEA_BASE_URL='http://100.64.0.10:3000'
export SMOKE_GITEA_OWNER='mycelium'
export SMOKE_GITEA_READ_TOKEN='read-only-token'
export SMOKE_EVIDENCE_DIR="$PWD/smoke-evidence" # optional; defaults to ./smoke-evidence
export SMOKE_TIMEOUT_SECONDS=900                  # optional; defaults to 15 minutes
CONFIRM_REAL_SMOKE=1 bash infra/real-smoke.sh
```

`SMOKE_OPERATOR_LOGIN` supports a direct loopback development run. In the real topology Tailscale
Serve strips it and supplies the caller identity. A 403 that names another identity is an
ingress/allowlist problem, not a pass.

## Evidence and failure handling

Each run writes a new mode-0700 directory under `SMOKE_EVIDENCE_DIR`. `summary.json` is the entry
point: it names the plan, branch, final SHA, PR URL, current stage, result, and the linked
artifacts. Those artifacts are sanitized API evidence: generated fixture, proposal, approval,
state transitions, terminal status/manifest, event stream, and read-only Gitea branch/file/PR
responses. Request headers and credentials are never written by the runner.

The script exits non-zero at the exact failed stage and still writes `summary.json`. A missing VM,
Gitea outage, authorization failure, model/worker failure, timeout, absent pushed commit, or absent
PR is an outstanding gate, never a passing result. Preserve the evidence before retrying. A
successful run deliberately leaves its isolated repository and open PR for inspection; cleanup is
an explicit operator decision.
