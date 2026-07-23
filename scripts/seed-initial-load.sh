#!/usr/bin/env bash
set -euo pipefail

seed_phase="${1:-all}"

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

if [[ -z "${REDIS_URL:-}" && -z "${REDIS_CLUSTER_ROOT_NODES:-}" ]]; then
  echo "REDIS_URL or REDIS_CLUSTER_ROOT_NODES is required in .env.local." >&2
  exit 1
fi
: "${CONFIRM_INITIAL_LOAD:?Set CONFIRM_INITIAL_LOAD=${SEED_ACCOUNTS} to run the ${SEED_ACCOUNTS}-account initial load.}"

if [[ "$CONFIRM_INITIAL_LOAD" != "$SEED_ACCOUNTS" ]]; then
  echo "Refusing initial load: CONFIRM_INITIAL_LOAD must be ${SEED_ACCOUNTS}." >&2
  exit 1
fi

cat <<EOF
Initial load profile:
  accounts: ${SEED_ACCOUNTS}
  securities: ${SEED_SECURITIES}
  positions: $(( SEED_ACCOUNTS * SEED_POSITIONS_PER_ACCOUNT ))
  transactions: ${SEED_TRANSACTIONS}
  snapshots: ${SEED_ACCOUNTS}
  account payload: disabled
  batch size: ${SEED_BATCH_SIZE:-500}
  write concurrency: ${SEED_WRITE_CONCURRENCY:-4}
  snapshot concurrency: ${SEED_SNAPSHOT_CONCURRENCY:-25}
  partition: ${SEED_PARTITION_INDEX:-0}/$(( ${SEED_PARTITION_COUNT:-1} - 1 ))
  transactions/account: $(( SEED_TRANSACTIONS / SEED_ACCOUNTS )) minimum
  resumable: ${SEED_RESUME:-true}
  index timeout: ${SEED_INDEX_TIMEOUT_MS:-1200000} ms
  drop indexes before load: ${SEED_DROP_INDEXES_BEFORE_LOAD:-false}
  skip snapshots: ${SEED_SKIP_SNAPSHOTS:-false}
  phase: ${seed_phase}

EOF

node --import tsx scripts/seed.ts "$seed_phase"
if [[ "$seed_phase" == "all" || "$seed_phase" == "finalize" ]]; then
  npm run redis:functions
fi
