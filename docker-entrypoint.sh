#!/usr/bin/env bash
# Applies the schema and seeds the admin account (if ADMIN_PASS is set and no
# users exist yet), then runs the given command.
set -e

if [ -n "${ADMIN_PASS:-}" ]; then
  node src/db/migrate.js --seed-admin || true
else
  node src/db/migrate.js || true
fi

exec "$@"
