#!/usr/bin/env bash
# Runs the real v1 VM/Gitea/model smoke fixture. It creates a new project and
# makes a paid model call; see infra/REAL-SMOKE.md before using it.
set -Eeuo pipefail
umask 077

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly TEMPLATE="${SCRIPT_DIR}/fixtures/real-smoke-plan.template.json"

stage='initializing'
failure_reason=''
plan_id=''
project_name=''
branch=''
smoke_file=''
head_sha=''
pr_url=''

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
nonce="$(od -An -N8 -tx1 /dev/urandom | tr -d '[:space:]')"
evidence_root="${SMOKE_EVIDENCE_DIR:-${PWD}/smoke-evidence}"
evidence_dir="${evidence_root}/real-${timestamp}-${nonce}"
mkdir -p -- "$evidence_dir"

write_summary() {
  local exit_code="$1"
  local outcome='failed'
  if [[ "$exit_code" -eq 0 ]]; then outcome='passed'; fi

  jq -n \
    --arg outcome "$outcome" --arg stage "$stage" --arg failure_reason "$failure_reason" \
    --arg plan_id "$plan_id" --arg project_name "$project_name" --arg branch "$branch" \
    --arg smoke_file "$smoke_file" --arg head_sha "$head_sha" --arg pr_url "$pr_url" \
    --arg started_at "$timestamp" --arg finished_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg evidence_dir "$evidence_dir" \
    '{outcome: $outcome, stage: $stage, failure_reason: $failure_reason,
      plan_id: $plan_id, project_name: $project_name, branch: $branch,
      smoke_file: $smoke_file, head_sha: $head_sha, pr_url: $pr_url,
      started_at: $started_at, finished_at: $finished_at, evidence_dir: $evidence_dir,
      evidence: {fixture: "fixture.json", proposal: "proposal.json", approval: "approval.json",
        status: "status.json", transitions: "status-transitions.ndjson", events: "events.json",
        gitea_branch: "gitea-branch.json", gitea_file: "gitea-file.json", gitea_prs: "gitea-prs.json"}}' \
    >"${evidence_dir}/summary.json"
}

on_exit() {
  local exit_code=$?
  trap - EXIT
  write_summary "$exit_code" || true
  if [[ "$exit_code" -eq 0 ]]; then
    printf 'PASS: real smoke evidence is in %s\n' "$evidence_dir"
  else
    printf 'FAIL: stage=%s; %s. Evidence is in %s\n' "$stage" "${failure_reason:-see evidence}" "$evidence_dir" >&2
  fi
  exit "$exit_code"
}
trap on_exit EXIT

fail() { failure_reason="$1"; exit 1; }
require_command() { command -v "$1" >/dev/null 2>&1 || fail "preflight: required command '$1' is unavailable"; }
require_env() { [[ -n "${!1:-}" ]] || fail "preflight: required environment variable $1 is unset"; }

http_json() {
  local label="$1" method="$2" url="$3" output="$4" body="${5:-}" auth="${6:-}" http_code
  local -a args=(--silent --show-error --location --request "$method" --output "$output" --write-out '%{http_code}'
    --header 'accept: application/json')
  args+=(--header "Tailscale-User-Login: ${SMOKE_OPERATOR_LOGIN}")
  if [[ -n "$auth" ]]; then args+=(--header "authorization: ${auth}"); fi
  if [[ -n "$body" ]]; then args+=(--header 'content-type: application/json' --data-binary "@${body}"); fi
  stage="$label"
  if ! http_code="$(curl "${args[@]}" "$url")"; then
    fail "${label}: transport failure; see $(basename -- "$output")"
  fi
  if [[ ! "$http_code" =~ ^2[0-9][0-9]$ ]]; then
    fail "${label}: HTTP ${http_code}; see $(basename -- "$output")"
  fi
  jq -e . "$output" >/dev/null || fail "${label}: response was not JSON; see $(basename -- "$output")"
}

stage='preflight'
require_command curl
require_command jq
require_command od
[[ -f "$TEMPLATE" ]] || fail "preflight: fixture template is missing: $TEMPLATE"
require_env CONFIRM_REAL_SMOKE
[[ "$CONFIRM_REAL_SMOKE" == '1' ]] || fail 'preflight: set CONFIRM_REAL_SMOKE=1 to authorise a paid, real-infrastructure run'
require_env SMOKE_ORCHESTRATOR_URL
require_env SMOKE_OPERATOR_LOGIN
require_env SMOKE_GITEA_BASE_URL
require_env SMOKE_GITEA_OWNER
require_env SMOKE_GITEA_READ_TOKEN

orchestrator_url="${SMOKE_ORCHESTRATOR_URL%/}"
gitea_url="${SMOKE_GITEA_BASE_URL%/}/api/v1"
project_name="mycelium-smoke-${timestamp,,}-${nonce:0:8}"
smoke_file="SMOKE-${timestamp}-${nonce:0:8}.md"
smoke_text="Mycelium real-infrastructure smoke ${timestamp} ${nonce:0:8}"
goal="Verify real VM, Gitea, and model execution by creating ${smoke_file} in this isolated project repository."
description="Create ${smoke_file} at the repository root containing exactly this single line followed by a newline: '${smoke_text}'. Commit the change on the plan branch, push it, then call task_complete with the commit SHA. Do not modify any other file."

stage='build_fixture'
jq --arg project "$project_name" --arg goal "$goal" --arg description "$description" --arg path "$smoke_file" \
  '.project.name = $project | .goal = $goal | .tasks[0].description = $description | .success_criteria[1].path = $path' \
  "$TEMPLATE" >"${evidence_dir}/fixture.json"
jq -e '.project.name and .tasks[0].description and .success_criteria[1].path' "${evidence_dir}/fixture.json" >/dev/null \
  || fail 'build_fixture: generated fixture is incomplete'

http_json 'health_check' GET "${orchestrator_url}/healthz" "${evidence_dir}/health.json"
http_json 'plan_proposal' POST "${orchestrator_url}/plans" "${evidence_dir}/proposal.json" "${evidence_dir}/fixture.json"
plan_id="$(jq -er '.plan_id' "${evidence_dir}/proposal.json")" || fail 'plan_proposal: response omitted plan_id'
http_json 'plan_approval' POST "${orchestrator_url}/plans/${plan_id}/approve" "${evidence_dir}/approval.json"
branch="plan/${plan_id}"

deadline=$((SECONDS + ${SMOKE_TIMEOUT_SECONDS:-900}))
last_state=''
while (( SECONDS < deadline )); do
  http_json 'wait_for_completion' GET "${orchestrator_url}/plans/${plan_id}" "${evidence_dir}/status.json"
  current_state="$(jq -er '.plan.state' "${evidence_dir}/status.json")" || fail 'wait_for_completion: status omitted plan.state'
  if [[ "$current_state" != "$last_state" ]]; then
    jq -c --arg observed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '. + {observed_at: $observed_at}' \
      "${evidence_dir}/status.json" >>"${evidence_dir}/status-transitions.ndjson"
    last_state="$current_state"
  fi
  case "$current_state" in
    done) break ;;
    failed|cancelled|rejected) fail "wait_for_completion: plan entered terminal state ${current_state}" ;;
  esac
  sleep 5
done
[[ "$last_state" == 'done' ]] || fail "wait_for_completion: timed out after ${SMOKE_TIMEOUT_SECONDS:-900} seconds"

stage='validate_manifest'
jq -e '.tasks | length == 1 and .[0].state == "done"' "${evidence_dir}/status.json" >/dev/null \
  || fail 'validate_manifest: task did not complete successfully'
head_sha="$(jq -er '.manifest.head_sha' "${evidence_dir}/status.json")" || fail 'validate_manifest: final manifest omitted head_sha (no pushed commit)'
pr_url="$(jq -er '.manifest.pr_url' "${evidence_dir}/status.json")" || fail 'validate_manifest: final manifest omitted pr_url'
jq -e --arg path "$smoke_file" '.manifest.criteria | any(.type == "all_tasks_done" and .passed) and any(.type == "file_exists_in_branch" and .path == $path and .passed)' \
  "${evidence_dir}/status.json" >/dev/null || fail 'validate_manifest: required criteria did not pass'

http_json 'collect_events' GET "${orchestrator_url}/events?plan_id=${plan_id}&limit=1000" "${evidence_dir}/events.json"
jq -e '[.events[].type] | index("agent.model_call") != null and index("agent.tool_call") != null' "${evidence_dir}/events.json" >/dev/null \
  || fail 'collect_events: model or tool-call evidence is missing'

branch_encoded="$(jq -nr --arg value "$branch" '$value | @uri')"
path_encoded="$(jq -nr --arg value "$smoke_file" '$value | @uri')"
gitea_auth="token ${SMOKE_GITEA_READ_TOKEN}"
http_json 'verify_gitea_branch' GET "${gitea_url}/repos/${SMOKE_GITEA_OWNER}/${project_name}/branches/${branch_encoded}" \
  "${evidence_dir}/gitea-branch.json" '' "$gitea_auth"
jq -e --arg sha "$head_sha" '.commit.id == $sha' "${evidence_dir}/gitea-branch.json" >/dev/null \
  || fail 'verify_gitea_branch: Gitea head does not match final manifest'
http_json 'verify_gitea_file' GET "${gitea_url}/repos/${SMOKE_GITEA_OWNER}/${project_name}/contents/${path_encoded}?ref=${branch_encoded}" \
  "${evidence_dir}/gitea-file.json" '' "$gitea_auth"
http_json 'verify_gitea_pr' GET "${gitea_url}/repos/${SMOKE_GITEA_OWNER}/${project_name}/pulls?state=open&limit=50" \
  "${evidence_dir}/gitea-prs.json" '' "$gitea_auth"
jq -e --arg branch "$branch" '.[] | select(.head.ref == $branch and .base.ref == "main")' "${evidence_dir}/gitea-prs.json" >/dev/null \
  || fail 'verify_gitea_pr: no open pull request for the plan branch'

stage='complete'
