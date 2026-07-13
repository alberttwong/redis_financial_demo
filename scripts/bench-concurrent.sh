#!/usr/bin/env bash
set -euo pipefail

mkdir -p memtier-output

query_benchmarks=(
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
benchmarks=("${query_benchmarks[@]}" trade-writes)
pids=()
trade_target_rps="${MEMTIER_TRADE_TARGET_RPS:-30000}"
export LOAD_TEST_OUTPUT_DIR=memtier-output
export LOAD_TEST_START_AT_EPOCH_MS=$((( $(date +%s) + ${LOAD_TEST_START_DELAY_SECONDS:-10} ) * 1000))

echo "Starting concurrent benchmark:"
echo "  standard query target: ${QUERY_DEFAULT_TARGET_RPS:-10000} reads/sec each"
echo "  join query target: ${QUERY_JOIN_TARGET_RPS:-50000} reads/sec each"
echo "  trade-write target: ${trade_target_rps} writes/sec"
echo "  test time: ${QUERY_TEST_TIME:-${MEMTIER_TEST_TIME:-60}}s"
echo "  synchronized start: ${LOAD_TEST_START_AT_EPOCH_MS} epoch ms"

for benchmark in "${query_benchmarks[@]}"; do
  log="memtier-output/concurrent-query-${benchmark}.log"
  echo "  query ${benchmark}: npm run bench:query:${benchmark}"
  npm run "bench:query:${benchmark}" >"$log" 2>&1 &
  pids+=("$!")
done

trade_log="memtier-output/concurrent-trade-writes.log"
MEMTIER_TRADE_TARGET_RPS="$trade_target_rps" \
  MEMTIER_TEST_TIME="${QUERY_TEST_TIME:-${MEMTIER_TEST_TIME:-60}}" \
  npm run bench:trade-writes >"$trade_log" 2>&1 &
pids+=("$!")

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
      tail -n 40 "memtier-output/concurrent-query-${benchmark}.log" >&2 || true
    fi
  fi
done
set -e

if [[ "$failed" -ne 0 ]]; then
  echo "Concurrent benchmark failed." >&2
  exit 1
fi

perl -0pi -e 's/"authenticate": "[^"]+"/"authenticate": "[redacted]"/g' memtier-output/trade-writes.json

if command -v jq >/dev/null 2>&1; then
  target_rate=0
  achieved_rate=0

  echo "Concurrent benchmark complete:"
  for benchmark in "${query_benchmarks[@]}"; do
    result="memtier-output/query-${benchmark}.json"
    benchmark_target="$(jq -r '.target_rps' "$result")"
    benchmark_achieved="$(jq -r '.achieved_rps' "$result")"
    target_rate="$(awk "BEGIN { printf \"%.2f\", ${target_rate} + ${benchmark_target} }")"
    achieved_rate="$(awk "BEGIN { printf \"%.2f\", ${achieved_rate} + ${benchmark_achieved} }")"
    echo "  ${benchmark}: ${benchmark_achieved} reads/sec (target ${benchmark_target})"
  done

  trade_achieved="$(jq -r '."ALL STATS".Totals."Ops/sec"' memtier-output/trade-writes.json)"
  target_rate="$(awk "BEGIN { printf \"%.2f\", ${target_rate} + ${trade_target_rps} }")"
  achieved_rate="$(awk "BEGIN { printf \"%.2f\", ${achieved_rate} + ${trade_achieved} }")"
  echo "  trade-writes: ${trade_achieved} writes/sec (target ${trade_target_rps})"
  echo "  combined: ${achieved_rate} operations/sec (target ${target_rate})"
fi

echo "Logs:"
for benchmark in "${query_benchmarks[@]}"; do
  echo "  memtier-output/concurrent-query-${benchmark}.log"
done
echo "  ${trade_log}"
