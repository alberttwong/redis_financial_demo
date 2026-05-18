#!/usr/bin/env bash
set -euo pipefail

: "${REDIS_HOST:?REDIS_HOST is required}"
: "${REDIS_PORT:?REDIS_PORT is required}"
: "${REDIS_PASSWORD:?REDIS_PASSWORD is required}"

mkdir -p memtier-output

tls_args=()
if [[ "${REDIS_TLS:-false}" == "true" ]]; then
  tls_args+=(--tls)
fi

memtier_benchmark \
  --server "$REDIS_HOST" \
  --port "$REDIS_PORT" \
  --authenticate "$REDIS_PASSWORD" \
  "${tls_args[@]}" \
  --threads "${MEMTIER_THREADS:-4}" \
  --clients "${MEMTIER_CLIENTS:-50}" \
  --pipeline "${MEMTIER_PIPELINE:-16}" \
  --rate-limiting "${MEMTIER_RATE_PER_CONNECTION:-75}" \
  --test-time "${MEMTIER_TEST_TIME:-60}" \
  --monitor-input monitor-input/account-reads.txt \
  --monitor-pattern R \
  --json-out-file memtier-output/account-reads.json \
  --print-percentiles 50,95,99,99.9
