#!/usr/bin/env bash
set -euo pipefail

comparison_output_dir="${LOAD_TEST_OUTPUT_DIR:-memtier-output/query-comparison-$(date -u +%Y%m%dT%H%M%SZ)}"
comparison_target_rps="${QUERY_COMPARISON_TARGET_RPS:-100}"
comparison_sample_pool_size="${QUERY_SAMPLE_POOL_SIZE:-1000}"

export LOAD_TEST_OUTPUT_DIR="$comparison_output_dir"
export QUERY_DEFAULT_TARGET_RPS="$comparison_target_rps"
export QUERY_SAMPLE_POOL_SIZE="$comparison_sample_pool_size"
export QUERY_VIEW_SAMPLE_POOL_SIZE="${QUERY_VIEW_SAMPLE_POOL_SIZE:-$comparison_sample_pool_size}"
export QUERY_SAMPLE_POOL_FILE="$comparison_output_dir/comparison-sample-pool.json"
export QUERY_WARMUP_TIME="${QUERY_WARMUP_TIME:-10}"
export QUERY_BENCHMARKS="security-by-no,security-by-no-direct,transactions-by-security,transactions-by-security-materialized,transactions-by-account-security,transactions-by-account-security-materialized"
export RUN_QUERY_BENCHMARKS=1
export RUN_TRADE_WRITES=0

if [[ "${QUERY_COMPARISON_PREPARE_VIEWS:-1}" == "1" ]]; then
  npm run materialize:query-comparison
fi

set +e
bash scripts/bench-concurrent.sh
benchmark_status=$?
set -e

node --import tsx scripts/summarize-query-comparison.ts "$comparison_output_dir"

echo "Comparison artifacts: $comparison_output_dir"
exit "$benchmark_status"
