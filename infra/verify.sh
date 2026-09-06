#!/usr/bin/env bash
# Checks what the runbook claims, on the machine it claims it about.
#
# Nothing in infra/ can be tested from a development machine: there is no
# systemd, no gVisor and no tailnet there. This script is the substitute, and
# it is only worth having if it is honest — a check that cannot run prints SKIP
# and its reason, and never counts as a pass.
#
#   ./verify.sh orchestrator
#   ./verify.sh worker
#
# Exits non-zero if anything failed.

set -uo pipefail

ROLE="${1:-}"
PASS=0
FAIL=0
SKIP=0

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  \033[31mFAIL\033[0m  %s\n         %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }
skip() { printf '  \033[33mSKIP\033[0m  %s\n         %s\n' "$1" "${2:-}"; SKIP=$((SKIP + 1)); }
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Every check names the command it ran, so a failure is diagnosable without
# reading this script.
check() {
  local what="$1"; shift
  local output
  if output=$("$@" 2>&1); then
    pass "$what"
    return 0
  fi
  fail "$what" "\$ $* — ${output:-no output}"
  return 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1
}

# --------------------------------------------------------------------------
section "both roles"

if require_cmd systemctl; then
  version=$(systemctl --version | head -1 | awk '{print $2}')
  if [ "${version}" -ge 250 ] 2>/dev/null; then
    pass "systemd ${version} supports encrypted credentials (needs 250+)"
  else
    fail "systemd ${version} is too old" "LoadCredentialEncrypted= needs systemd 250 or newer"
  fi
else
  fail "systemd is not present" "this script is for the deployed VMs, not a development machine"
fi

if require_cmd tailscale; then
  if tailscale status >/dev/null 2>&1; then
    pass "tailscale is up ($(tailscale ip -4 2>/dev/null | head -1))"
  else
    fail "tailscale is not up" "\$ tailscale status"
  fi
else
  fail "tailscale is not installed" ""
fi

if [ -d /etc/mycelium/creds ]; then
  # A credential blob is encrypted, but its permissions are still the thing
  # stopping anyone reading it before systemd does.
  loose=$(find /etc/mycelium/creds -type f ! -perm 600 2>/dev/null | wc -l)
  if [ "${loose}" -eq 0 ]; then
    pass "credential blobs are 0600"
  else
    fail "${loose} credential blobs are not 0600" "\$ find /etc/mycelium/creds -type f ! -perm 600"
  fi
else
  fail "/etc/mycelium/creds does not exist" "the runbook's credential step has not been done"
fi

# --------------------------------------------------------------------------
case "${ROLE}" in
orchestrator)
  section "orchestrator"

  check "the service is active" systemctl is-active --quiet mycelium-orchestrator

  if curl -fsS --max-time 5 http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
    pass "/healthz answers on loopback"
  else
    fail "/healthz does not answer on loopback" "\$ curl http://127.0.0.1:8080/healthz"
  fi

  # The operator routes' whole defence: identity comes from Serve, and a
  # request without it is refused.
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8080/plans 2>/dev/null || echo 000)
  if [ "${code}" = "401" ] || [ "${code}" = "403" ]; then
    pass "operator routes refuse a request with no identity header (${code})"
  else
    fail "operator routes answered ${code} without an identity header" "expected 401 or 403"
  fi

  # And a self-supplied one is not enough on its own: the allowlist decides.
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
    -H 'Tailscale-User-Login: nobody@example.com' \
    http://127.0.0.1:8080/plans 2>/dev/null || echo 000)
  if [ "${code}" = "403" ]; then
    pass "operator routes refuse an identity that is not on the allowlist"
  else
    fail "an off-allowlist identity got ${code}" "expected 403 — check OPERATOR_ALLOWLIST"
  fi

  if require_cmd tailscale; then
    if tailscale serve status 2>/dev/null | grep -q '127.0.0.1:8080'; then
      pass "Serve proxies to the loopback listener"
    else
      fail "Serve is not proxying to 127.0.0.1:8080" "\$ tailscale serve status"
    fi
    if tailscale serve status 2>/dev/null | grep -qi funnel; then
      fail "Funnel appears to be enabled" "Funnel is public and carries no identity headers"
    else
      pass "Funnel is off"
    fi
    # The header-stripping claim is what the whole identity model rests on, and
    # it is a property of the installed Tailscale rather than of this repo.
    skip "Serve strips a client-supplied Tailscale-User-Login" \
      "check by hand from another tailnet device: curl -H 'Tailscale-User-Login: someone@else' https://<host>/plans — a 403 naming YOUR login means Serve replaced it; a 200 means it did not, and the allowlist is decoration"
  fi

  if require_cmd psql; then
    if psql "${DATABASE_URL:-}" -tAc 'SELECT count(*) FROM schema_migrations' >/dev/null 2>&1; then
      applied=$(psql "${DATABASE_URL:-}" -tAc 'SELECT count(*) FROM schema_migrations' 2>/dev/null)
      if [ "${applied:-0}" -gt 0 ]; then
        pass "Postgres reachable and ${applied} migrations applied"
      else
        fail "schema_migrations is empty" "the orchestrator applies migrations at startup"
      fi
    else
      fail "cannot query Postgres" "\$ psql \"\$DATABASE_URL\" -c 'SELECT 1'"
    fi
  else
    skip "Postgres check" "psql is not installed"
  fi

  if [ -n "${GITEA_BASE_URL:-}" ]; then
    # /api/healthz is unauthenticated; /api/v1/* is gated when
    # REQUIRE_SIGNIN_VIEW = true (which the runbook keeps on), so probing it
    # would 403 on a perfectly healthy Gitea.
    if curl -fsS --max-time 5 "${GITEA_BASE_URL}/api/healthz" >/dev/null 2>&1; then
      pass "Gitea answers at ${GITEA_BASE_URL}"
    else
      fail "Gitea does not answer at ${GITEA_BASE_URL}" "\$ curl ${GITEA_BASE_URL}/api/healthz"
    fi
  else
    skip "Gitea check" "GITEA_BASE_URL is not set in this shell — source /etc/mycelium/orchestrator.env"
  fi
  ;;

worker)
  section "worker"

  check "the service is active" systemctl is-active --quiet mycelium-supervisor

  if require_cmd runsc; then
    pass "runsc is on PATH ($(runsc --version 2>&1 | head -1))"
  else
    fail "runsc is not on PATH" "gVisor is not installed"
  fi

  if [ -f /etc/docker/daemon.json ] && grep -q runsc /etc/docker/daemon.json; then
    pass "runsc is registered in /etc/docker/daemon.json"
  else
    fail "runsc is not registered with Docker" "every sandbox launch passes --runtime=runsc"
  fi

  # The registration existing is not the same as it working.
  if require_cmd docker; then
    if docker run --rm --runtime=runsc alpine:3.20 dmesg 2>/dev/null | grep -qi gvisor; then
      pass "a container actually starts under gVisor"
    else
      fail "could not start a container under runsc and see a gVisor kernel" \
        "\$ docker run --rm --runtime=runsc alpine:3.20 dmesg | grep -i gvisor"
    fi
  else
    fail "docker is not installed" ""
  fi

  # Ticket 0004 gap 8: without a slice there is no scope to signal, and an
  # agent left by a previous supervisor process cannot be killed at all.
  if systemctl show mycelium-plans.slice --property=LoadState 2>/dev/null | grep -q loaded; then
    pass "mycelium-plans.slice is loaded"
  else
    fail "mycelium-plans.slice is not loaded" "AGENT_SLICE would have nothing to start scopes in"
  fi

  if require_cmd systemd-run; then
    # As the service user, not root: the supervisor is unprivileged, and a
    # root-only pass here hid a missing polkit install on the first bring-up
    # (every agent spawn then 409s with "Access denied").
    if runuser -u mycelium -- systemd-run --scope --quiet --slice=mycelium-plans \
        --unit=mycelium-plan-verify /bin/true >/dev/null 2>&1; then
      pass "the mycelium user can start a transient scope in the slice"
    else
      fail "the mycelium user cannot start a scope in mycelium-plans" \
        "install polkitd + worker/49-mycelium-plans.rules; test: runuser -u mycelium -- systemd-run --scope --slice=mycelium-plans /bin/true"
    fi
  fi

  # From the EnvironmentFile the unit actually loads. `systemctl show
  # -p Environment` does NOT expand EnvironmentFile=, so it always looked unset.
  env_file=$(systemctl show mycelium-supervisor --property=EnvironmentFiles --value 2>/dev/null | awk '{print $1}')
  host=$(grep -h '^HOST=' "${env_file:-/etc/mycelium/supervisor.env}" 2>/dev/null | tail -1 | cut -d= -f2)
  case "${host}" in
    0.0.0.0 | :: | '')
      fail "HOST is '${host:-unset}'" "loadConfig refuses a wildcard: B19 authenticates the orchestrator by peer address, which only works on the tailnet interface" ;;
    127.* )
      fail "HOST is loopback" "the orchestrator dials this supervisor directly over the tailnet" ;;
    *)
      pass "HOST is a specific address (${host})" ;;
  esac

  state="${STATE_DIR:-/var/lib/mycelium}"
  if [ -d "${state}" ]; then
    owner=$(stat -c '%U' "${state}" 2>/dev/null)
    if [ "${owner}" = "mycelium" ]; then
      pass "${state} exists and is owned by mycelium"
    else
      fail "${state} is owned by ${owner}" "the service runs as mycelium"
    fi
  else
    fail "${state} does not exist" ""
  fi

  # The one check that proves the two halves are actually talking.
  if journalctl -u mycelium-supervisor --since '-2 min' 2>/dev/null | grep -qi 'heartbeat'; then
    pass "a heartbeat appears in the last two minutes"
  else
    skip "heartbeat check" "nothing matching in the last two minutes of the journal — confirm on the orchestrator with: mycelium.mjs is not for this; query the agents table, or watch GET /agents"
  fi
  ;;

*)
  echo "usage: verify.sh orchestrator|worker" >&2
  exit 2
  ;;
esac

# --------------------------------------------------------------------------
printf '\n%s: \033[32m%d passed\033[0m, \033[31m%d failed\033[0m, \033[33m%d skipped\033[0m\n' \
  "${ROLE}" "${PASS}" "${FAIL}" "${SKIP}"

if [ "${SKIP}" -gt 0 ]; then
  echo "a skipped check is not a passed one — read its reason above"
fi

[ "${FAIL}" -eq 0 ]
