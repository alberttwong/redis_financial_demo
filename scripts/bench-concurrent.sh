#!/usr/bin/env bash
set -euo pipefail

OUTPUT_DIR="${LOAD_TEST_OUTPUT_DIR:-memtier-output}"
mkdir -p "$OUTPUT_DIR"

all_query_benchmarks=(
  account-by-id
  security-by-id
  security-by-no
  position-by-composite
  positions-by-account
  transaction-by-id
  transactions-by-account
  transactions-by-security
  transactions-by-account-security
  account-portfolio-join
  account-activity-join
  account-snapshot
)
query_benchmarks=("${all_query_benchmarks[@]}")
if [[ -n "${QUERY_BENCHMARKS:-}" ]]; then
  IFS=',' read -r -a query_benchmarks <<<"${QUERY_BENCHMARKS}"
fi
run_query_benchmarks="${RUN_QUERY_BENCHMARKS:-1}"
if [[ "$run_query_benchmarks" != "0" && "$run_query_benchmarks" != "1" ]]; then
  echo "RUN_QUERY_BENCHMARKS must be 0 or 1." >&2
  exit 1
fi
if [[ "$run_query_benchmarks" == "0" ]]; then
  query_benchmarks=()
fi
run_trade_writes="${RUN_TRADE_WRITES:-1}"
if [[ "$run_trade_writes" != "0" && "$run_trade_writes" != "1" ]]; then
  echo "RUN_TRADE_WRITES must be 0 or 1." >&2
  exit 1
fi

benchmarks=("${query_benchmarks[@]}")
if [[ "$run_trade_writes" == "1" ]]; then
  benchmarks+=(trade-writes)
fi
pids=()
trade_target_rps="${MEMTIER_TRADE_TARGET_RPS:-30000}"
export LOAD_TEST_OUTPUT_DIR="$OUTPUT_DIR"
export LOAD_TEST_START_AT_EPOCH_MS="${LOAD_TEST_START_AT_EPOCH_MS:-$((( $(date +%s) + ${LOAD_TEST_START_DELAY_SECONDS:-10} ) * 1000))}"
export QUERY_DEFAULT_TARGET_RPS="${QUERY_DEFAULT_TARGET_RPS:-9000}"
export QUERY_JOIN_TARGET_RPS="${QUERY_JOIN_TARGET_RPS:-45000}"

echo "Starting concurrent benchmark:"
if [[ "$run_query_benchmarks" == "1" ]]; then
  echo "  standard query target: ${QUERY_DEFAULT_TARGET_RPS} reads/sec each"
  echo "  join query target: ${QUERY_JOIN_TARGET_RPS} reads/sec each"
else
  echo "  query workload: disabled on this generator"
fi
if [[ "$run_trade_writes" == "1" ]]; then
  echo "  trade-write target: ${trade_target_rps} writes/sec"
else
  echo "  trade-write target: disabled on this generator"
fi
echo "  test time: ${QUERY_TEST_TIME:-${MEMTIER_TEST_TIME:-60}}s"
echo "  synchronized start: ${LOAD_TEST_START_AT_EPOCH_MS} epoch ms"

for benchmark in "${query_benchmarks[@]}"; do
  log="${OUTPUT_DIR}/concurrent-query-${benchmark}.log"
  echo "  query ${benchmark}: npm run bench:query:${benchmark}"
  npm run "bench:query:${benchmark}" >"$log" 2>&1 &
  pids+=("$!")
done

trade_log="${OUTPUT_DIR}/concurrent-trade-writes.log"
if [[ "$run_trade_writes" == "1" ]]; then
  MEMTIER_TRADE_TARGET_RPS="$trade_target_rps" \
    MEMTIER_TEST_TIME="${QUERY_TEST_TIME:-${MEMTIER_TEST_TIME:-60}}" \
    npm run bench:trade-writes >"$trade_log" 2>&1 &
  pids+=("$!")
fi

set +e
failed=0
for index in "${!benchmarks[@]}"; do
  benchmark="${benchmarks[$index]}"
  wait "${pids[$index]}"
  status=$?
  if [[ "$status" -ne 0 ]]; then
    failed=1
    echo "${benchmark} exit code: ${status}" >&2
    if [[ "$benchmark" == "trade-writes" ]]; then
      tail -n 40 "$trade_log" >&2 || true
    else
      tail -n 40 "${OUTPUT_DIR}/concurrent-query-${benchmark}.log" >&2 || true
    fi
  fi
done
set -e

if [[ "$run_trade_writes" == "1" ]]; then
  perl -0pi -e 's/"authenticate": "[^"]+"/"authenticate": "[redacted]"/g' "${OUTPUT_DIR}/trade-writes.json"
fi

if command -v jq >/dev/null 2>&1; then
  client_target_rate=0
  client_achieved_rate=0
  redis_target_rate=0
  redis_achieved_rate=0

  echo "Concurrent benchmark complete:"
  if [[ "${#query_benchmarks[@]}" -gt 0 ]]; then
    printf '  %-38s %12s %14s %10s %10s %10s\n' "query" "target/sec" "achieved/sec" "p50 ms" "p95 ms" "p99 ms"
  fi
  for benchmark in "${query_benchmarks[@]}"; do
    result="${OUTPUT_DIR}/query-${benchmark}.json"
    benchmark_target="$(jq -r '.target_rps' "$result")"
    benchmark_achieved="$(jq -r '.achieved_rps' "$result")"
    benchmark_redis_target="$(jq -r '.estimated_target_redis_ops_per_second // 0' "$result")"
    benchmark_redis_achieved="$(jq -r '.achieved_redis_ops_per_second // 0' "$result")"
    benchmark_p50="$(jq -r '.latency_ms.p50' "$result")"
    benchmark_p95="$(jq -r '.latency_ms.p95' "$result")"
    benchmark_p99="$(jq -r '.latency_ms.p99' "$result")"
    client_target_rate="$(awk "BEGIN { printf \"%.2f\", ${client_target_rate} + ${benchmark_target} }")"
    client_achieved_rate="$(awk "BEGIN { printf \"%.2f\", ${client_achieved_rate} + ${benchmark_achieved} }")"
    redis_target_rate="$(awk "BEGIN { printf \"%.2f\", ${redis_target_rate} + ${benchmark_redis_target} }")"
    redis_achieved_rate="$(awk "BEGIN { printf \"%.2f\", ${redis_achieved_rate} + ${benchmark_redis_achieved} }")"
    printf '  %-38s %12s %14s %10s %10s %10s\n' \
      "$benchmark" "$benchmark_target" "$benchmark_achieved" "$benchmark_p50" "$benchmark_p95" "$benchmark_p99"
  done

  if [[ "$run_trade_writes" == "1" ]]; then
    trade_achieved="$(jq -r '.achieved_ops_per_second // ."ALL STATS".Totals."Ops/sec"' "${OUTPUT_DIR}/trade-writes.json")"
    client_target_rate="$(awk "BEGIN { printf \"%.2f\", ${client_target_rate} + ${trade_target_rps} }")"
    client_achieved_rate="$(awk "BEGIN { printf \"%.2f\", ${client_achieved_rate} + ${trade_achieved} }")"
    redis_target_rate="$(awk "BEGIN { printf \"%.2f\", ${redis_target_rate} + ${trade_target_rps} }")"
    redis_achieved_rate="$(awk "BEGIN { printf \"%.2f\", ${redis_achieved_rate} + ${trade_achieved} }")"
    echo "  trade-writes: ${trade_achieved} writes/sec (target ${trade_target_rps})"
  fi
  echo "  combined client operations: ${client_achieved_rate}/sec (target ${client_target_rate})"
  echo "  estimated Redis operations: ${redis_achieved_rate}/sec (target ${redis_target_rate})"
fi

if [[ "${#query_benchmarks[@]}" -gt 0 ]]; then
  if ! node --import tsx scripts/summarize-concurrent-results.ts "$OUTPUT_DIR"; then
    failed=1
  fi
fi

echo "Logs:"
for benchmark in "${query_benchmarks[@]}"; do
  echo "  ${OUTPUT_DIR}/concurrent-query-${benchmark}.log"
done
if [[ "$run_trade_writes" == "1" ]]; then
  echo "  ${trade_log}"
fi

if [[ "$failed" -ne 0 ]]; then
  echo "Concurrent benchmark failed." >&2
  exit 1
fi
