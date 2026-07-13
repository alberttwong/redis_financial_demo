#!/usr/bin/env bash
set -euo pipefail

# shellcheck disable=SC1091
. ./scripts/load-redis-env.sh

: "${REDIS_HOST:?REDIS_HOST is required}"
: "${REDIS_PORT:?REDIS_PORT is required}"
: "${REDIS_PASSWORD:?REDIS_PASSWORD is required}"

mkdir -p memtier-output

npm run redis:functions

trade_run_id="${MEMTIER_TRADE_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
trade_date="${MEMTIER_TRADE_DATE:-$(date -u +%Y-%m-%d)}"
trade_date_epoch="$(node -e 'console.log(Date.parse(`${process.argv[1]}T00:00:00.000Z`))' "$trade_date")"
trade_payload_bytes="${MEMTIER_TRADE_PAYLOAD_BYTES:-1024}"
position_key='pos:A00000001:SPX000001:LOAD'
trade_json_arg="$(
  node -e '
    const target = Number(process.argv[1]);
    const tradeDate = process.argv[2];
    const tradeDateEpoch = Number(process.argv[3]);
    const row = {
      _id: "__key__",
      transaction_id: "__key__",
      account_id: "A00000001",
      security_id: "SEC00000001",
      security_no: "SPX000001",
      trade_date: tradeDate,
      trade_date_epoch: tradeDateEpoch,
      acct_type_code: "LOAD",
      transaction_type: "BUY",
      quantity: 1,
      amount: 100,
      payload: ""
    };
    const base = JSON.stringify(row);
    row.payload = "x".repeat(Math.max(0, target - Buffer.byteLength(base)));
    process.stdout.write(JSON.stringify(JSON.stringify(row)));
  ' "$trade_payload_bytes" "$trade_date" "$trade_date_epoch"
)"
position_json_arg="$(
  node -e '
    const tradeDate = process.argv[1];
    const row = {
      _id: "A00000001|SPX000001|LOAD",
      account_id: "A00000001",
      security_id: "SEC00000001",
      security_no: "SPX000001",
      acct_type_code: "LOAD",
      quantity: 0,
      market_value: 0,
      as_of_date: tradeDate,
      payload: ""
    };
    process.stdout.write(JSON.stringify(JSON.stringify(row)));
  ' "$trade_date"
)"
trade_command="FCALL apply_transaction 2 __key__ ${position_key} ${trade_json_arg} ${position_json_arg}"

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
  --rate-limiting "${MEMTIER_TRADE_RATE_PER_CONNECTION:-38}" \
  --test-time "${MEMTIER_TEST_TIME:-60}" \
  --key-prefix "txn:{pos:A00000001:SPX000001:LOAD}:load:${trade_run_id}:" \
  --key-minimum 1 \
  --key-maximum "${MEMTIER_TRADE_KEY_MAXIMUM:-10000000}" \
  --command "$trade_command" \
  --command-key-pattern P \
  --json-out-file memtier-output/trade-writes.json \
  --print-percentiles 50,95,99,99.9
