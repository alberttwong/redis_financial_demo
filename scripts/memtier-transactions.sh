#!/usr/bin/env bash
set -euo pipefail

# shellcheck disable=SC1091
. ./scripts/load-redis-env.sh

: "${REDIS_HOST:?REDIS_HOST is required}"
: "${REDIS_PORT:?REDIS_PORT is required}"
: "${REDIS_PASSWORD:?REDIS_PASSWORD is required}"

mkdir -p memtier-output

tls_args=()
if [[ "${REDIS_TLS:-false}" == "true" ]]; then
  tls_args+=(--tls)
  if [[ -n "${MEMTIER_TLS_CACERT:-}" ]]; then
    tls_args+=(--cacert "${MEMTIER_TLS_CACERT}")
  elif [[ "${MEMTIER_TLS_SKIP_VERIFY:-true}" == "true" ]]; then
    tls_args+=(--tls-skip-verify)
  fi
fi

memtier_benchmark \
  --server "$REDIS_HOST" \
  --port "$REDIS_PORT" \
  --authenticate "$REDIS_PASSWORD" \
  "${tls_args[@]}" \
  --threads "${MEMTIER_THREADS:-8}" \
  --clients "${MEMTIER_CLIENTS:-100}" \
  --pipeline "${MEMTIER_PIPELINE:-64}" \
  --rate-limiting "${MEMTIER_TRANSACTION_RATE_PER_CONNECTION:-188}" \
  --test-time "${MEMTIER_TEST_TIME:-60}" \
  --command "__monitor_line@__" \
  --monitor-input monitor-input/transactions.txt \
  --monitor-pattern R \
  --json-out-file memtier-output/transactions.json \
  --print-percentiles 50,95,99,99.9
