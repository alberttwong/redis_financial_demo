#!/usr/bin/env bash
set -euo pipefail

# shellcheck disable=SC1091
. ./scripts/load-redis-env.sh

: "${REDIS_HOST:?REDIS_HOST is required}"
: "${REDIS_PORT:?REDIS_PORT is required}"
: "${REDIS_PASSWORD:?REDIS_PASSWORD is required}"

mkdir -p memtier-output

npm run redis:functions

trade_target_rps="${MEMTIER_TRADE_TARGET_RPS:-30000}"
trade_threads="${MEMTIER_TRADE_THREADS:-4}"
trade_clients="${MEMTIER_TRADE_CLIENTS:-50}"
for value in "$trade_target_rps" "$trade_threads" "$trade_clients"; do
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "Trade target, threads, and clients must be positive integers." >&2
    exit 1
  fi
done
trade_connections=$((trade_threads * trade_clients))
if ((trade_target_rps % trade_connections != 0)); then
  echo "MEMTIER_TRADE_TARGET_RPS must be divisible by MEMTIER_TRADE_THREADS * MEMTIER_TRADE_CLIENTS." >&2
  exit 1
fi
trade_rate_per_connection=$((trade_target_rps / trade_connections))

trade_run_id="${MEMTIER_TRADE_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
trade_date="${MEMTIER_TRADE_DATE:-$(date -u +%Y-%m-%d)}"
trade_date_epoch="$(node -e 'console.log(Date.parse(`${process.argv[1]}T00:00:00.000Z`))' "$trade_date")"
trade_payload_bytes="${MEMTIER_TRADE_PAYLOAD_BYTES:-1024}"
position_key='pos:{acct:A00000001}:SPX000001:LOAD'
snapshot_key='acct-snapshot:{acct:A00000001}'
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
      projection_version: 0,
      payload: ""
    };
    process.stdout.write(JSON.stringify(JSON.stringify(row)));
  ' "$trade_date"
)"
security_json_arg="$(
  node -e '
    const row = {
      _id: "SEC00000001",
      security_id: "SEC00000001",
      security_no: "SPX000001",
      symbol: "SPX1",
      cusip: "000000001",
      asset_class: "EQUITY",
      index_name: "S&P 500",
      index_member: true,
      sector: "Financials",
      industry: "Capital Markets",
      exchange: "NYSE",
      issuer_name: "Load Test Security",
      status: "ACTIVE"
    };
    process.stdout.write(JSON.stringify(JSON.stringify(row)));
  '
)"
generated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
trade_command="FCALL apply_transaction 3 __key__ ${position_key} ${snapshot_key} ${trade_json_arg} ${position_json_arg} ${security_json_arg} ${generated_at}"

tls_args=()
if [[ "${REDIS_TLS:-false}" == "true" ]]; then
  tls_args+=(--tls)
  if [[ -n "${MEMTIER_TLS_CACERT:-}" ]]; then
    tls_args+=(--cacert "${MEMTIER_TLS_CACERT}")
  elif [[ "${MEMTIER_TLS_SKIP_VERIFY:-true}" == "true" ]]; then
    tls_args+=(--tls-skip-verify)
  fi
fi

if [[ -n "${LOAD_TEST_START_AT_EPOCH_MS:-}" ]]; then
  node -e 'const waitMs = Number(process.argv[1]) - Date.now(); if (waitMs > 0) setTimeout(() => {}, waitMs);' \
    "$LOAD_TEST_START_AT_EPOCH_MS"
fi

memtier_benchmark \
  --server "$REDIS_HOST" \
  --port "$REDIS_PORT" \
  --authenticate "$REDIS_PASSWORD" \
  "${tls_args[@]}" \
  --threads "$trade_threads" \
  --clients "$trade_clients" \
  --pipeline "${MEMTIER_TRADE_PIPELINE:-64}" \
  --rate-limiting "$trade_rate_per_connection" \
  --test-time "${MEMTIER_TEST_TIME:-60}" \
  --key-prefix "txn:{acct:A00000001}:SPX000001:LOAD:load:${trade_run_id}:" \
  --key-minimum 1 \
  --key-maximum "${MEMTIER_TRADE_KEY_MAXIMUM:-10000000}" \
  --command "$trade_command" \
  --command-key-pattern P \
  --json-out-file memtier-output/trade-writes.json \
  --print-percentiles 50,95,99,99.9
