#!/usr/bin/env bash
set -euo pipefail

PROCESS_COUNT="${QUERY_GENERATOR_PROCESSES:-4}"
TOTAL_TARGET_RPS="${QUERY_DEFAULT_TARGET_RPS:-10000}"
TOTAL_MAX_IN_FLIGHT="${QUERY_MAX_IN_FLIGHT:-10000}"
TOTAL_MAX_SOCKETS="${QUERY_MAX_SOCKETS:-10000}"
TOTAL_MAX_FREE_SOCKETS="${QUERY_MAX_FREE_SOCKETS:-512}"
BASE_RANDOM_SEED="${QUERY_RANDOM_SEED:-20260714}"
WARMUP_TIME="${QUERY_WARMUP_TIME:-0}"
START_DELAY_SECONDS="${QUERY_SHARD_START_DELAY_SECONDS:-10}"
RUN_ID="${QUERY_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
OUTPUT_ROOT="${LOAD_TEST_OUTPUT_DIR:-memtier-output}/query-account-by-id-${PROCESS_COUNT}-shards-${RUN_ID}"

for value_name in PROCESS_COUNT TOTAL_TARGET_RPS TOTAL_MAX_IN_FLIGHT TOTAL_MAX_SOCKETS TOTAL_MAX_FREE_SOCKETS BASE_RANDOM_SEED WARMUP_TIME START_DELAY_SECONDS; do
  value="${!value_name}"
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    echo "${value_name} must be a non-negative integer." >&2
    exit 1
  fi
done

if [[ "$PROCESS_COUNT" -lt 2 ]]; then
  echo "QUERY_GENERATOR_PROCESSES must be at least 2 for the sharded runner." >&2
  exit 1
fi

for value_name in TOTAL_TARGET_RPS TOTAL_MAX_IN_FLIGHT TOTAL_MAX_SOCKETS TOTAL_MAX_FREE_SOCKETS; do
  if [[ "${!value_name}" -lt 1 ]]; then
    echo "${value_name} must be a positive integer." >&2
    exit 1
  fi
done

if [[ ! "$RUN_ID" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "QUERY_RUN_ID may contain only letters, numbers, dots, underscores, and hyphens." >&2
  exit 1
fi

mkdir -p "$OUTPUT_ROOT"
START_AT_EPOCH_MS=$(( $(date +%s) * 1000 + START_DELAY_SECONDS * 1000 ))
PIDS=()

allocate_share() {
  local total="$1"
  local index="$2"
  local base=$(( total / PROCESS_COUNT ))
  local remainder=$(( total % PROCESS_COUNT ))
  if [[ "$index" -lt "$remainder" ]]; then
    echo $(( base + 1 ))
  else
    echo "$base"
  fi
}

stop_children() {
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap stop_children INT TERM

echo "Starting ${PROCESS_COUNT} generator processes at ${START_AT_EPOCH_MS} with aggregate target ${TOTAL_TARGET_RPS} req/sec..."
for ((index = 0; index < PROCESS_COUNT; index += 1)); do
  shard_number=$(( index + 1 ))
  shard_name="$(printf 'shard-%02d' "$shard_number")"
  shard_directory="${OUTPUT_ROOT}/${shard_name}"
  mkdir -p "$shard_directory"

  shard_target_rps="$(allocate_share "$TOTAL_TARGET_RPS" "$index")"
  shard_max_in_flight="$(allocate_share "$TOTAL_MAX_IN_FLIGHT" "$index")"
  shard_max_sockets="$(allocate_share "$TOTAL_MAX_SOCKETS" "$index")"
  shard_max_free_sockets="$(allocate_share "$TOTAL_MAX_FREE_SOCKETS" "$index")"
  shard_random_seed=$(( BASE_RANDOM_SEED + index * 1000003 ))

  (
    export LOAD_TEST_OUTPUT_DIR="$shard_directory"
    export LOAD_TEST_START_AT_EPOCH_MS="$START_AT_EPOCH_MS"
    export QUERY_DEFAULT_TARGET_RPS="$shard_target_rps"
    export QUERY_WARMUP_TIME="$WARMUP_TIME"
    export QUERY_MAX_IN_FLIGHT="$shard_max_in_flight"
    export QUERY_MAX_SOCKETS="$shard_max_sockets"
    export QUERY_MAX_FREE_SOCKETS="$shard_max_free_sockets"
    export QUERY_RANDOM_SEED="$shard_random_seed"
    export QUERY_GENERATOR_SHARD_INDEX="$shard_number"
    export QUERY_GENERATOR_SHARD_COUNT="$PROCESS_COUNT"
    export QUERY_EXPORT_LATENCY_HISTOGRAM=1
    npm run bench:query:account-by-id
  ) >"${shard_directory}/generator.log" 2>&1 &
  PIDS+=("$!")
done

benchmark_status=0
for pid in "${PIDS[@]}"; do
  if ! wait "$pid"; then
    benchmark_status=1
  fi
done
trap - INT TERM

for log_file in "${OUTPUT_ROOT}"/shard-*/generator.log; do
  echo "Generator log: ${log_file}"
  sed -n '1,240p' "$log_file"
done

aggregate_status=0
node --env-file-if-exists=.env.local --import tsx scripts/aggregate-query-shards.ts "$OUTPUT_ROOT" || aggregate_status=$?
echo "Sharded generator artifacts: ${OUTPUT_ROOT}"

if [[ "$benchmark_status" -ne 0 || "$aggregate_status" -ne 0 ]]; then
  exit 1
fi
