#!/usr/bin/env bash
set -euo pipefail

mkdir -p memtier-output

transactions_log="memtier-output/concurrent-transactions.log"
trade_writes_log="memtier-output/concurrent-trade-writes.log"

echo "Starting concurrent benchmark:"
echo "  transactions: npm run bench:transactions"
echo "  trade writes: npm run bench:trade-writes"
echo "  test time: ${MEMTIER_TEST_TIME:-60}s"

npm run bench:transactions >"$transactions_log" 2>&1 &
transactions_pid=$!

npm run bench:trade-writes >"$trade_writes_log" 2>&1 &
trade_writes_pid=$!

set +e
wait "$transactions_pid"
transactions_status=$?
wait "$trade_writes_pid"
trade_writes_status=$?
set -e

if [[ "$transactions_status" -ne 0 || "$trade_writes_status" -ne 0 ]]; then
  echo "Concurrent benchmark failed." >&2
  echo "transactions exit code: ${transactions_status}" >&2
  echo "trade-writes exit code: ${trade_writes_status}" >&2
  echo "Last transaction log lines:" >&2
  tail -n 40 "$transactions_log" >&2 || true
  echo "Last trade-write log lines:" >&2
  tail -n 40 "$trade_writes_log" >&2 || true
  exit 1
fi

perl -0pi -e 's/\"authenticate\": \"[^\"]+\"/\"authenticate\": \"[redacted]\"/g' memtier-output/transactions.json memtier-output/trade-writes.json

if command -v jq >/dev/null 2>&1; then
  transactions_ops="$(jq -r '."ALL STATS".Totals."Ops/sec"' memtier-output/transactions.json)"
  trade_writes_ops="$(jq -r '."ALL STATS".Totals."Ops/sec"' memtier-output/trade-writes.json)"
  total_ops="$(awk "BEGIN { printf \"%.2f\", ${transactions_ops} + ${trade_writes_ops} }")"

  echo "Concurrent benchmark complete:"
  echo "  transactions ops/sec: ${transactions_ops}"
  echo "  trade writes ops/sec: ${trade_writes_ops}"
  echo "  combined ops/sec: ${total_ops}"
fi

echo "Logs:"
echo "  ${transactions_log}"
echo "  ${trade_writes_log}"
