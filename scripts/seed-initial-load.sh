#!/usr/bin/env bash
set -euo pipefail

if [[ -f .env.local ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.local
  set +a
fi

if [[ -f .env.initial-load ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.initial-load
  set +a
elif [[ -f .env.initial-load.example ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.initial-load.example
  set +a
fi

: "${REDIS_URL:?REDIS_URL is required. Put Terraform output redis_url in .env.local.}"
: "${CONFIRM_INITIAL_LOAD:?Set CONFIRM_INITIAL_LOAD=1000 to run the 1000-account initial load.}"

if [[ "$CONFIRM_INITIAL_LOAD" != "1000" ]]; then
  echo "Refusing initial load: CONFIRM_INITIAL_LOAD must be 1000." >&2
  exit 1
fi

account_bytes=$(( SEED_ACCOUNTS * SEED_ACCOUNT_BYTES ))
account_gib=$(awk "BEGIN { printf \"%.2f\", $account_bytes / 1024 / 1024 / 1024 }")

cat <<EOF
Initial load profile:
  accounts: ${SEED_ACCOUNTS}
  securities: ${SEED_SECURITIES}
  positions: $(( SEED_ACCOUNTS * SEED_POSITIONS_PER_ACCOUNT ))
  transactions: ${SEED_TRANSACTIONS}
  account payload only: ${account_gib} GiB before Redis/index overhead
  batch size: ${SEED_BATCH_SIZE:-500}
  snapshot concurrency: ${SEED_SNAPSHOT_CONCURRENCY:-25}
  skip snapshots: ${SEED_SKIP_SNAPSHOTS:-false}

EOF

node --import tsx scripts/seed.ts all
