#!/usr/bin/env bash
# Nightly dump of the two things that hold state, per baseline section 10.
#
# Neither carries a plaintext secret: Postgres holds only token hashes, and the
# systemd credential blobs stay on their VM and are restored from the
# operator's password manager rather than from here.
#
# Retention and off-VM copying are deliberately left to the operator's own
# tooling (rsync, restic, a provider snapshot) - see ticket 0007 section 3.

set -euo pipefail

DEST="${BACKUP_DIR:-/var/backups/mycelium}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "${DEST}"

# The password arrives as a credential, never in the environment (B13).
if [ -n "${CREDENTIALS_DIRECTORY:-}" ] && [ -f "${CREDENTIALS_DIRECTORY}/postgres_password" ]; then
  PGPASSWORD="$(cat "${CREDENTIALS_DIRECTORY}/postgres_password")"
  export PGPASSWORD
fi

pg_dump --format=custom --no-owner --file="${DEST}/postgres-${STAMP}.dump" \
  "${PGDATABASE:-mycelium}"

# Gitea's own dump command; it knows what its data directory contains.
if command -v gitea >/dev/null 2>&1; then
  ( cd "${DEST}" && gitea dump --file "gitea-${STAMP}.zip" --config /etc/gitea/app.ini )
fi

# Keep a fortnight locally. Anything older should already be off this VM.
find "${DEST}" -type f -mtime +14 -delete

echo "backed up to ${DEST} at ${STAMP}"
