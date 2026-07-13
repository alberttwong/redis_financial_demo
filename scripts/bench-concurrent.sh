#!/usr/bin/env bash
set -euo pipefail

mkdir -p memtier-output

positions_log="memtier-output/concurrent-positions-by-account.log"
trade_writes_log="memtier-output/concurrent-trade-writes.log"

echo "Starting concurrent benchmark:"
echo "  positions by account: npm run bench:positions-by-account"
echo "  trade writes: npm run bench:trade-writes"
echo "  test time: ${MEMTIER_TEST_TIME:-60}s"

npm run bench:positions-by-account >"$positions_log" 2>&1 &
positions_pid=$!

npm run bench:trade-writes >"$trade_writes_log" 2>&1 &
trade_writes_pid=$!

set +e
wait "$positions_pid"
positions_status=$?
wait "$trade_writes_pid"
trade_writes_status=$?
set -e

if [[ "$positions_status" -ne 0 || "$trade_writes_status" -ne 0 ]]; then
  echo "Concurrent benchmark failed." >&2
  echo "positions-by-account exit code: ${positions_status}" >&2
  echo "trade-writes exit code: ${trade_writes_status}" >&2
  echo "Last positions-by-account log lines:" >&2
  tail -n 40 "$positions_log" >&2 || true
  echo "Last trade-write log lines:" >&2
  tail -n 40 "$trade_writes_log" >&2 || true
  exit 1
fi

perl -0pi -e 's/\"authenticate\": \"[^\"]+\"/\"authenticate\": \"[redacted]\"/g' memtier-output/positions-by-account.json memtier-output/trade-writes.json

if command -v jq >/dev/null 2>&1; then
  positions_ops="$(jq -r '."ALL STATS".Totals."Ops/sec"' memtier-output/positions-by-account.json)"
  trade_writes_ops="$(jq -r '."ALL STATS".Totals."Ops/sec"' memtier-output/trade-writes.json)"
  total_ops="$(awk "BEGIN { printf \"%.2f\", ${positions_ops} + ${trade_writes_ops} }")"

  echo "Concurrent benchmark complete:"
  echo "  positions-by-account ops/sec: ${positions_ops}"
  echo "  trade writes ops/sec: ${trade_writes_ops}"
  echo "  combined ops/sec: ${total_ops}"
fi

echo "Logs:"
echo "  ${positions_log}"
echo "  ${trade_writes_log}"
