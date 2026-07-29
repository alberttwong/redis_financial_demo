#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF_DIR="${ROOT_DIR}/infra/aws-direct-redis-runner"
REMOTE_DIR="${AWS_DIRECT_REDIS_REMOTE_DIR:-/home/ec2-user/redis-financial-demo}"
SSH_USER="${AWS_DIRECT_REDIS_SSH_USER:-ec2-user}"
SSH_KEY_PATH="${AWS_DIRECT_REDIS_KEY_PATH:-}"
SSH_KNOWN_HOSTS_FILE="${AWS_DIRECT_REDIS_KNOWN_HOSTS_FILE:-${TMPDIR:-/tmp}/lpl-redis-direct-full-known-hosts-$$}"
HOST_READY_TIMEOUT_SECONDS="${AWS_DIRECT_REDIS_HOST_READY_TIMEOUT_SECONDS:-1200}"
READ_TARGET_RPS="${DIRECT_FULL_READ_TARGET_RPS:-180000}"
WRITE_TARGET_RPS="${DIRECT_FULL_WRITE_TARGET_RPS:-30000}"
TEST_TIME="${DIRECT_FULL_TEST_TIME:-120}"
START_DELAY_SECONDS="${DIRECT_FULL_START_DELAY_SECONDS:-120}"
READ_PROCESS_COUNT="${DIRECT_FULL_READ_PROCESS_COUNT:-4}"
READ_REDIS_POOL_SIZE="${DIRECT_FULL_READ_REDIS_POOL_SIZE:-1}"
READ_MAX_IN_FLIGHT_PER_HOST="${DIRECT_FULL_READ_MAX_IN_FLIGHT_PER_HOST:-2048}"
READ_DRAIN_TIMEOUT_MS="${DIRECT_FULL_READ_DRAIN_TIMEOUT_MS:-120000}"
WRITE_REDIS_POOL_SIZE="${DIRECT_FULL_WRITE_REDIS_POOL_SIZE:-4}"
WRITE_MAX_IN_FLIGHT_PER_HOST="${DIRECT_FULL_WRITE_MAX_IN_FLIGHT_PER_HOST:-4096}"
WRITE_DRAIN_TIMEOUT_MS="${DIRECT_FULL_WRITE_DRAIN_TIMEOUT_MS:-120000}"
WRITE_GENERATOR_COUNT="${DIRECT_FULL_WRITE_GENERATOR_COUNT:-3}"
CORRECTNESS_SAMPLE_EVERY="${DIRECT_FULL_CORRECTNESS_SAMPLE_EVERY:-1000}"
RUN_ID="${DIRECT_FULL_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
BASE_RANDOM_SEED="${DIRECT_FULL_RANDOM_SEED:-20260728}"
AWS_REGION="${AWS_REGION:-us-west-2}"
SKIP_SYNC="${AWS_DIRECT_REDIS_SKIP_SYNC:-0}"
CLOUDWATCH_METRIC_DELAY_SECONDS="${AWS_DIRECT_REDIS_CLOUDWATCH_METRIC_DELAY_SECONDS:-120}"
REDIS_CLOUD_PROMETHEUS_ENDPOINT="${REDISCLOUD_PROMETHEUS_ENDPOINT:-}"
REDIS_CLOUD_DATABASE_ID="${REDISCLOUD_DATABASE_ID:-}"
REDIS_CLOUD_DATABASE_NAME="${REDISCLOUD_DATABASE_NAME:-}"
REDIS_CLOUD_METRIC_POLL_INTERVAL_MS="${REDISCLOUD_METRIC_POLL_INTERVAL_MS:-15000}"
READ_ALLOCATION_JSON="${DIRECT_FULL_READ_ALLOCATION_JSON:-{
  \"accountById\": 1,
  \"securityById\": 1,
  \"securityByNo\": 1,
  \"positionByComposite\": 1,
  \"positionsByAccount\": 2,
  \"transactionById\": 1,
  \"transactionsByAccount\": 2,
  \"transactionsBySecurity\": 2,
  \"transactionsByAccountSecurity\": 1,
  \"accountPortfolioJoin\": 8,
  \"accountActivityJoin\": 5,
  \"accountSnapshot\": 4
}}"
REDIS_CLOUD_METRICS_ACTIVE=0
STATUS=0

if [[ -z "$SSH_KEY_PATH" || ! -f "$SSH_KEY_PATH" ]]; then
  echo "AWS_DIRECT_REDIS_KEY_PATH must point to the EC2 private key." >&2
  exit 1
fi
if [[ ! -f "${ROOT_DIR}/.env.local" ]]; then
  echo ".env.local is required with the provisioned Redis Cloud endpoint." >&2
  exit 1
fi
if [[ ! "$RUN_ID" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "DIRECT_FULL_RUN_ID may contain only letters, numbers, dots, underscores, and hyphens." >&2
  exit 1
fi
for integer in \
  "$TEST_TIME" "$START_DELAY_SECONDS" "$READ_PROCESS_COUNT" \
  "$READ_REDIS_POOL_SIZE" "$READ_MAX_IN_FLIGHT_PER_HOST" \
  "$WRITE_REDIS_POOL_SIZE" "$WRITE_MAX_IN_FLIGHT_PER_HOST" \
  "$WRITE_GENERATOR_COUNT" "$CORRECTNESS_SAMPLE_EVERY" \
  "$CLOUDWATCH_METRIC_DELAY_SECONDS"; do
  if [[ ! "$integer" =~ ^[0-9]+$ ]]; then
    echo "Full direct benchmark integer settings must be non-negative integers." >&2
    exit 1
  fi
done
if ! awk "BEGIN { exit !(${READ_TARGET_RPS} > 0 && ${WRITE_TARGET_RPS} > 0) }"; then
  echo "Read and write targets must be positive numbers." >&2
  exit 1
fi
if ! jq -e '
  type == "object" and
  length == 12 and
  all(to_entries[];
    (.key | IN(
      "accountById",
      "securityById",
      "securityByNo",
      "positionByComposite",
      "positionsByAccount",
      "transactionById",
      "transactionsByAccount",
      "transactionsBySecurity",
      "transactionsByAccountSecurity",
      "accountPortfolioJoin",
      "accountActivityJoin",
      "accountSnapshot"
    )) and
    (.value | type == "number" and floor == . and . > 0)
  )
' >/dev/null <<<"$READ_ALLOCATION_JSON"; then
  echo "DIRECT_FULL_READ_ALLOCATION_JSON must assign a positive host count to all 12 patterns." >&2
  exit 1
fi

GENERATOR_INSTANCE_IDS_JSON="$(terraform -chdir="$TF_DIR" output -json generator_instance_ids)"
GENERATOR_HOSTS=()
while IFS= read -r host; do
  GENERATOR_HOSTS+=("$host")
done < <(terraform -chdir="$TF_DIR" output -json generator_public_dns_names | jq -r '.[]')
QUERY_ASSIGNMENTS=()
while IFS= read -r pattern; do
  QUERY_ASSIGNMENTS+=("$pattern")
done < <(jq -r 'to_entries[] | .key as $pattern | range(0; .value) | $pattern' <<<"$READ_ALLOCATION_JSON")
READ_GENERATOR_COUNT="${#QUERY_ASSIGNMENTS[@]}"
REQUIRED_GENERATORS=$((READ_GENERATOR_COUNT + WRITE_GENERATOR_COUNT))
if [[ "${#GENERATOR_HOSTS[@]}" -ne "$REQUIRED_GENERATORS" ]]; then
  echo "The allocation needs ${REQUIRED_GENERATORS} generators (${READ_GENERATOR_COUNT} read + ${WRITE_GENERATOR_COUNT} write), but Terraform has ${#GENERATOR_HOSTS[@]}." >&2
  exit 1
fi

SSH_OPTS=(
  -i "$SSH_KEY_PATH"
  -o BatchMode=yes
  -o ConnectTimeout=10
  -o ConnectionAttempts=1
  -o StrictHostKeyChecking=accept-new
  -o "UserKnownHostsFile=${SSH_KNOWN_HOSTS_FILE}"
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=3
)
printf -v RSYNC_SSH '%q ' ssh "${SSH_OPTS[@]}"

wait_for_host() {
  local host="$1"
  local deadline=$((SECONDS + HOST_READY_TIMEOUT_SECONDS))
  until ssh "${SSH_OPTS[@]}" "${SSH_USER}@${host}" 'test -f /opt/lpl-load-runner-ready'; do
    if (( SECONDS >= deadline )); then
      echo "Timed out waiting for direct generator ${host}." >&2
      return 1
    fi
    sleep 15
  done
}

sync_host() {
  local host="$1"
  ssh "${SSH_OPTS[@]}" "${SSH_USER}@${host}" "mkdir -p '${REMOTE_DIR}'"
  rsync -az --delete \
    --exclude '.git/' \
    --exclude '.next/' \
    --exclude '.terraform/' \
    --exclude 'node_modules/' \
    --exclude 'docs/*.docx' \
    --exclude 'docs/*.pdf' \
    --exclude 'memtier-output/' \
    --exclude 'monitor-input/' \
    --exclude 'output/' \
    --exclude 'tmp/' \
    --exclude 'tsconfig.tsbuildinfo' \
    --exclude 'infra/**/terraform.tfstate*' \
    --exclude 'infra/**/tfplan*' \
    --exclude 'infra/aws-load-runner/api-bundle.tgz' \
    -e "$RSYNC_SSH" \
    "${ROOT_DIR}/" "${SSH_USER}@${host}:${REMOTE_DIR}/"
  scp "${SSH_OPTS[@]}" "${ROOT_DIR}/.env.local" "${SSH_USER}@${host}:${REMOTE_DIR}/.env.local"
  ssh "${SSH_OPTS[@]}" "${SSH_USER}@${host}" \
    "chmod 600 '${REMOTE_DIR}/.env.local' && cd '${REMOTE_DIR}' && npm ci --no-audit --no-fund"
}

RUN_ROOT="${ROOT_DIR}/memtier-output/aws-direct-redis/full-read-write-${RUN_ID}"
REMOTE_RUN_ROOT="memtier-output/aws-direct-redis/full-read-write-${RUN_ID}"
FIRST_HOST="${GENERATOR_HOSTS[0]}"
REMOTE_METRICS_ROOT="${REMOTE_RUN_ROOT}/redis-cloud"
REMOTE_METRICS_PID="/tmp/lpl-direct-full-redis-cloud-metrics-${RUN_ID}.pid"
mkdir -p "$RUN_ROOT"

start_redis_cloud_metrics() {
  if [[ -z "$REDIS_CLOUD_PROMETHEUS_ENDPOINT" || -z "$REDIS_CLOUD_DATABASE_ID" ]]; then
    echo "Redis Cloud Prometheus sampling is disabled; endpoint or database ID was not provided."
    return 0
  fi
  ssh "${SSH_OPTS[@]}" "${SSH_USER}@${FIRST_HOST}" \
    "cd '${REMOTE_DIR}' && mkdir -p '${REMOTE_METRICS_ROOT}' && \
     { REDISCLOUD_PROMETHEUS_INSECURE_TLS='${REDISCLOUD_PROMETHEUS_INSECURE_TLS:-0}' \
       nohup setsid node --import tsx scripts/capture-redis-cloud-prometheus.ts \
         '${REDIS_CLOUD_PROMETHEUS_ENDPOINT}' \
         '${REDIS_CLOUD_DATABASE_ID}' \
         '${REDIS_CLOUD_DATABASE_NAME}' \
         '${REMOTE_METRICS_ROOT}/redis-cloud-metrics.ndjson' \
         '${REDIS_CLOUD_METRIC_POLL_INTERVAL_MS}' \
         >'${REMOTE_METRICS_ROOT}/redis-cloud-metrics.log' 2>&1 & \
       echo \$! >'${REMOTE_METRICS_PID}'; \
     }"
  REDIS_CLOUD_METRICS_ACTIVE=1
}

stop_and_collect_redis_cloud_metrics() {
  if [[ "$REDIS_CLOUD_METRICS_ACTIVE" != "1" ]]; then
    return 0
  fi
  REDIS_CLOUD_METRICS_ACTIVE=0
  ssh "${SSH_OPTS[@]}" "${SSH_USER}@${FIRST_HOST}" \
    "if [[ -f '${REMOTE_METRICS_PID}' ]]; then \
       pid=\$(cat '${REMOTE_METRICS_PID}'); \
       kill -TERM -- \"-\$pid\" 2>/dev/null || true; \
       for _ in \$(seq 1 40); do \
         if ! kill -0 \"\$pid\" 2>/dev/null; then break; fi; \
         sleep 0.5; \
       done; \
       kill -KILL -- \"-\$pid\" 2>/dev/null || true; \
       rm -f '${REMOTE_METRICS_PID}'; \
     fi" || true
  mkdir -p "${RUN_ROOT}/redis-cloud"
  rsync -az -e "$RSYNC_SSH" \
    "${SSH_USER}@${FIRST_HOST}:${REMOTE_DIR}/${REMOTE_METRICS_ROOT}/" \
    "${RUN_ROOT}/redis-cloud/" || true
  if [[ -s "${RUN_ROOT}/redis-cloud/redis-cloud-metrics.ndjson" ]]; then
    node --import tsx scripts/summarize-redis-cloud-metrics.ts \
      "${RUN_ROOT}/redis-cloud/redis-cloud-metrics.ndjson" \
      "${RUN_ROOT}/redis-cloud" || true
  fi
}

trap stop_and_collect_redis_cloud_metrics EXIT

echo "Waiting for ${#GENERATOR_HOSTS[@]} direct Redis generators..."
pids=()
for host in "${GENERATOR_HOSTS[@]}"; do
  wait_for_host "$host" &
  pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid"; done

if [[ "$SKIP_SYNC" != "1" ]]; then
  echo "Synchronizing the direct benchmark to all generators..."
  pids=()
  for host in "${GENERATOR_HOSTS[@]}"; do
    sync_host "$host" &
    pids+=("$!")
  done
  for pid in "${pids[@]}"; do wait "$pid"; done
else
  echo "Reusing previously synchronized generator source and dependencies."
fi

jq -n \
  --arg run_id "$RUN_ID" \
  --argjson read_target "$READ_TARGET_RPS" \
  --argjson write_target "$WRITE_TARGET_RPS" \
  --argjson read_allocation "$READ_ALLOCATION_JSON" \
  --argjson writer_count "$WRITE_GENERATOR_COUNT" \
  --argjson instances "$GENERATOR_INSTANCE_IDS_JSON" \
  '{
    run_id: $run_id,
    architecture: "dedicated AWS generators -> Redis Cloud OSS Cluster API",
    read_target_per_second: $read_target,
    write_target_per_second: $write_target,
    read_host_allocation: $read_allocation,
    write_generator_count: $writer_count,
    generator_instance_ids: $instances
  }' >"${RUN_ROOT}/topology.json"

ssh "${SSH_OPTS[@]}" "${SSH_USER}@${FIRST_HOST}" \
  "cd '${REMOTE_DIR}' && mkdir -p '${REMOTE_RUN_ROOT}' && \
   REDIS_POOL_SIZE='1' LOAD_TEST_OUTPUT_DIR='${REMOTE_RUN_ROOT}' \
   npm run metrics:redis -- before-full" \
  >"${RUN_ROOT}/redis-metrics-before.log" 2>&1 || true

BENCHMARK_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
start_redis_cloud_metrics
START_AT_EPOCH_MS=$(( $(date +%s) * 1000 + START_DELAY_SECONDS * 1000 ))
pids=()

echo "Starting ${READ_GENERATOR_COUNT} dedicated read generators and ${WRITE_GENERATOR_COUNT} writers..."
for index in "${!QUERY_ASSIGNMENTS[@]}"; do
  host="${GENERATOR_HOSTS[$index]}"
  host_number=$((index + 1))
  host_name="$(printf 'host-%02d' "$host_number")"
  pattern="${QUERY_ASSIGNMENTS[$index]}"
  replica_count="$(jq -r --arg pattern "$pattern" '.[$pattern]' <<<"$READ_ALLOCATION_JSON")"
  weight=1
  if [[ "$pattern" == "accountPortfolioJoin" || "$pattern" == "accountActivityJoin" ]]; then
    weight=5
  fi
  pattern_target="$(awk "BEGIN { printf \"%.8f\", ${READ_TARGET_RPS} * ${weight} / 20 }")"
  host_target="$(awk "BEGIN { printf \"%.8f\", ${pattern_target} / ${replica_count} }")"
  host_seed=$((BASE_RANDOM_SEED + index * 10000019))
  remote_host_dir="${REMOTE_RUN_ROOT}/${host_name}"
  ssh "${SSH_OPTS[@]}" "${SSH_USER}@${host}" \
    "cd '${REMOTE_DIR}' && mkdir -p '${remote_host_dir}' && \
     REDIS_POOL_SIZE='${READ_REDIS_POOL_SIZE}' \
     DIRECT_QUERY_PATTERNS='${pattern}' \
     DIRECT_QUERY_TOTAL_TARGET_RPS='${host_target}' \
     DIRECT_QUERY_PROCESS_COUNT='${READ_PROCESS_COUNT}' \
     DIRECT_QUERY_TEST_TIME='${TEST_TIME}' \
     DIRECT_QUERY_WARMUP_TIME='0' \
     DIRECT_QUERY_DRAIN_TIMEOUT_MS='${READ_DRAIN_TIMEOUT_MS}' \
     DIRECT_QUERY_MAX_IN_FLIGHT='${READ_MAX_IN_FLIGHT_PER_HOST}' \
     DIRECT_QUERY_RANDOM_SEED='${host_seed}' \
     DIRECT_QUERY_GENERATOR_HOST='${host_name}' \
     DIRECT_QUERY_FAIL_ON_LIMITS='0' \
     LOAD_TEST_START_AT_EPOCH_MS='${START_AT_EPOCH_MS}' \
     LOAD_TEST_OUTPUT_DIR='${remote_host_dir}' \
     npm run bench:redis-direct:host >'${remote_host_dir}/host-runner.log' 2>&1" &
  pids+=("$!")
done

writer_target="$(awk "BEGIN { printf \"%.8f\", ${WRITE_TARGET_RPS} / ${WRITE_GENERATOR_COUNT} }")"
for ((writer_index=1; writer_index<=WRITE_GENERATOR_COUNT; writer_index+=1)); do
  host_index=$((READ_GENERATOR_COUNT + writer_index - 1))
  host="${GENERATOR_HOSTS[$host_index]}"
  host_name="$(printf 'host-%02d' "$((host_index + 1))")"
  writer_seed=$((BASE_RANDOM_SEED + 700000001 + writer_index * 10000019))
  remote_host_dir="${REMOTE_RUN_ROOT}/${host_name}"
  ssh "${SSH_OPTS[@]}" "${SSH_USER}@${host}" \
    "cd '${REMOTE_DIR}' && mkdir -p '${remote_host_dir}' && \
     REDIS_POOL_SIZE='${WRITE_REDIS_POOL_SIZE}' \
     TRADE_TARGET_RPS='${writer_target}' \
     TRADE_TEST_TIME='${TEST_TIME}' \
     TRADE_MAX_IN_FLIGHT='${WRITE_MAX_IN_FLIGHT_PER_HOST}' \
     TRADE_DRAIN_TIMEOUT_MS='${WRITE_DRAIN_TIMEOUT_MS}' \
     TRADE_SAMPLE_POOL_SIZE='1000' \
     TRADE_ACCOUNT_DISCOVERY_POOL_SIZE='5000' \
     TRADE_SHARD_COUNT='${WRITE_GENERATOR_COUNT}' \
     TRADE_SHARD_INDEX='${writer_index}' \
     TRADE_RANDOM_SEED='${writer_seed}' \
     TRADE_GENERATOR_HOST='${host_name}' \
     TRADE_EXPORT_LATENCY_HISTOGRAM='1' \
     TRADE_CORRECTNESS_SAMPLE_EVERY='${CORRECTNESS_SAMPLE_EVERY}' \
     MEMTIER_TRADE_RUN_ID='${RUN_ID}-${host_name}' \
     LOAD_TEST_START_AT_EPOCH_MS='${START_AT_EPOCH_MS}' \
     LOAD_TEST_OUTPUT_DIR='${remote_host_dir}' \
     node --env-file-if-exists=.env.local --import tsx scripts/load-trade-writes.ts \
       >'${remote_host_dir}/trade-writes.log' 2>&1" &
  pids+=("$!")
done

for pid in "${pids[@]}"; do
  if ! wait "$pid"; then STATUS=1; fi
done
BENCHMARK_ENDED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

ssh "${SSH_OPTS[@]}" "${SSH_USER}@${FIRST_HOST}" \
  "cd '${REMOTE_DIR}' && REDIS_POOL_SIZE='1' LOAD_TEST_OUTPUT_DIR='${REMOTE_RUN_ROOT}' \
   npm run metrics:redis -- after-full" \
  >"${RUN_ROOT}/redis-metrics-after.log" 2>&1 || true

echo "Downloading direct read/write artifacts..."
for index in "${!GENERATOR_HOSTS[@]}"; do
  host="${GENERATOR_HOSTS[$index]}"
  host_name="$(printf 'host-%02d' "$((index + 1))")"
  mkdir -p "${RUN_ROOT}/${host_name}"
  rsync -az -e "$RSYNC_SSH" \
    "${SSH_USER}@${host}:${REMOTE_DIR}/${REMOTE_RUN_ROOT}/${host_name}/" \
    "${RUN_ROOT}/${host_name}/" || STATUS=1
done
rsync -az -e "$RSYNC_SSH" \
  "${SSH_USER}@${FIRST_HOST}:${REMOTE_DIR}/${REMOTE_RUN_ROOT}/redis-metrics-*.json" \
  "${RUN_ROOT}/" || true

node --import tsx scripts/aggregate-direct-redis-results.ts "$RUN_ROOT" || STATUS=1
node --import tsx scripts/aggregate-trade-shards.ts "$RUN_ROOT" || STATUS=1
node --import tsx scripts/summarize-direct-read-write.ts "$RUN_ROOT" || STATUS=1
stop_and_collect_redis_cloud_metrics

if [[ "$CLOUDWATCH_METRIC_DELAY_SECONDS" -gt 0 ]]; then
  echo "Waiting ${CLOUDWATCH_METRIC_DELAY_SECONDS}s for CloudWatch metric publication..."
  sleep "$CLOUDWATCH_METRIC_DELAY_SECONDS"
fi
FLEETS_JSON="$(jq -cn --argjson generators "$GENERATOR_INSTANCE_IDS_JSON" '{generators: $generators}')"
AWS_REGION="$AWS_REGION" node --import tsx scripts/capture-ec2-network-allowance-metrics.ts \
  "$BENCHMARK_STARTED_AT" "$BENCHMARK_ENDED_AT" "$FLEETS_JSON" "$RUN_ROOT" || STATUS=1
AWS_REGION="$AWS_REGION" node --import tsx scripts/capture-ec2-network-traffic-metrics.ts \
  "$BENCHMARK_STARTED_AT" "$BENCHMARK_ENDED_AT" "$FLEETS_JSON" "$RUN_ROOT" || STATUS=1

trap - EXIT
echo "Direct Redis full read/write artifacts: ${RUN_ROOT}"
exit "$STATUS"
