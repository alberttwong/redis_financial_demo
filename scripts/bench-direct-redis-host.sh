#!/usr/bin/env bash
set -euo pipefail

OUTPUT_DIR="${LOAD_TEST_OUTPUT_DIR:-memtier-output/direct-resp-host}"
PROCESS_COUNT="${DIRECT_QUERY_PROCESS_COUNT:-4}"
HOST_TARGET_RPS="${DIRECT_QUERY_TOTAL_TARGET_RPS:-30000}"
BASE_RANDOM_SEED="${DIRECT_QUERY_RANDOM_SEED:-20260723}"

if [[ ! "$PROCESS_COUNT" =~ ^[1-9][0-9]*$ ]]; then
  echo "DIRECT_QUERY_PROCESS_COUNT must be a positive integer." >&2
  exit 1
fi
if ! awk "BEGIN { exit !(${HOST_TARGET_RPS} > 0) }"; then
  echo "DIRECT_QUERY_TOTAL_TARGET_RPS must be a positive number." >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
process_target_rps="$(awk "BEGIN { printf \"%.8f\", ${HOST_TARGET_RPS} / ${PROCESS_COUNT} }")"
pids=()

echo "Starting ${PROCESS_COUNT} direct RESP processes at ${process_target_rps}/sec each (${HOST_TARGET_RPS}/sec host target)."
for ((index=1; index<=PROCESS_COUNT; index+=1)); do
  process_name="$(printf 'process-%02d' "$index")"
  process_dir="${OUTPUT_DIR}/${process_name}"
  process_seed=$((BASE_RANDOM_SEED + (index - 1) * 1000003))
  mkdir -p "$process_dir"
  DIRECT_QUERY_TOTAL_TARGET_RPS="$process_target_rps" \
    DIRECT_QUERY_PROCESS_INDEX="$index" \
    DIRECT_QUERY_PROCESS_COUNT="$PROCESS_COUNT" \
    DIRECT_QUERY_RANDOM_SEED="$process_seed" \
    LOAD_TEST_OUTPUT_DIR="$process_dir" \
    node --env-file-if-exists=.env.local --import tsx scripts/load-direct-redis-queries.ts \
      >"${process_dir}/direct-query.log" 2>&1 &
  pids+=("$!")
done

status=0
for index in "${!pids[@]}"; do
  if ! wait "${pids[$index]}"; then
    process_name="$(printf 'process-%02d' "$((index + 1))")"
    echo "${process_name} failed:" >&2
    tail -n 80 "${OUTPUT_DIR}/${process_name}/direct-query.log" >&2 || true
    status=1
  fi
done

node --import tsx scripts/aggregate-direct-redis-results.ts "$OUTPUT_DIR" || status=1
exit "$status"
