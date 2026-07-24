#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF_DIR="${ROOT_DIR}/infra/aws-direct-redis-runner"
REMOTE_DIR="${AWS_DIRECT_REDIS_REMOTE_DIR:-/home/ec2-user/redis-financial-demo}"
SSH_USER="${AWS_DIRECT_REDIS_SSH_USER:-ec2-user}"
SSH_KEY_PATH="${AWS_DIRECT_REDIS_KEY_PATH:-}"
SSH_KNOWN_HOSTS_FILE="${AWS_DIRECT_REDIS_KNOWN_HOSTS_FILE:-${TMPDIR:-/tmp}/lpl-redis-direct-known-hosts-$$}"
HOST_READY_TIMEOUT_SECONDS="${AWS_DIRECT_REDIS_HOST_READY_TIMEOUT_SECONDS:-1200}"
PROCESS_COUNT="${DIRECT_QUERY_PROCESS_COUNT:-4}"
REDIS_POOL_SIZE_PER_PROCESS="${DIRECT_QUERY_REDIS_POOL_SIZE:-2}"
RATES="${DIRECT_QUERY_STAIRCASE_RATES:-30000,60000,90000,120000,150000,180000}"
TEST_TIME="${DIRECT_QUERY_TEST_TIME:-60}"
WARMUP_TIME="${DIRECT_QUERY_WARMUP_TIME:-10}"
DRAIN_TIMEOUT_MS="${DIRECT_QUERY_DRAIN_TIMEOUT_MS:-30000}"
DISCONNECT_TIMEOUT_MS="${DIRECT_QUERY_DISCONNECT_TIMEOUT_MS:-5000}"
MAX_IN_FLIGHT="${DIRECT_QUERY_MAX_IN_FLIGHT:-512}"
RUN_ID="${DIRECT_QUERY_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
BASE_RANDOM_SEED="${DIRECT_QUERY_RANDOM_SEED:-20260723}"
START_DELAY_SECONDS="${DIRECT_QUERY_START_DELAY_SECONDS:-20}"
REDIS_CLOUD_PROMETHEUS_ENDPOINT="${REDISCLOUD_PROMETHEUS_ENDPOINT:-}"
REDIS_CLOUD_DATABASE_ID="${REDISCLOUD_DATABASE_ID:-}"
REDIS_CLOUD_DATABASE_NAME="${REDISCLOUD_DATABASE_NAME:-}"
REDIS_CLOUD_METRIC_POLL_INTERVAL_MS="${REDISCLOUD_METRIC_POLL_INTERVAL_MS:-15000}"
REDIS_CLOUD_METRICS_ACTIVE=0

if [[ -z "$SSH_KEY_PATH" || ! -f "$SSH_KEY_PATH" ]]; then
  echo "AWS_DIRECT_REDIS_KEY_PATH must point to the EC2 private key." >&2
  exit 1
fi
if [[ ! -f "${ROOT_DIR}/.env.local" ]]; then
  echo ".env.local is required with the provisioned Redis Cloud endpoints." >&2
  exit 1
fi
if [[ ! "$RUN_ID" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "DIRECT_QUERY_RUN_ID may contain only letters, numbers, dots, underscores, and hyphens." >&2
  exit 1
fi
if [[ -n "$REDIS_CLOUD_PROMETHEUS_ENDPOINT" && ! "$REDIS_CLOUD_PROMETHEUS_ENDPOINT" =~ ^https?://[A-Za-z0-9._:/-]+$ && ! "$REDIS_CLOUD_PROMETHEUS_ENDPOINT" =~ ^[A-Za-z0-9._:-]+$ ]]; then
  echo "REDISCLOUD_PROMETHEUS_ENDPOINT has an unsupported format." >&2
  exit 1
fi
if [[ ! "$REDIS_CLOUD_DATABASE_ID" =~ ^[0-9]*$ ]]; then
  echo "REDISCLOUD_DATABASE_ID must be numeric." >&2
  exit 1
fi
if [[ ! "$REDIS_CLOUD_DATABASE_NAME" =~ ^[A-Za-z0-9._-]*$ ]]; then
  echo "REDISCLOUD_DATABASE_NAME has an unsupported format." >&2
  exit 1
fi

GENERATOR_HOSTS=()
while IFS= read -r host; do
  GENERATOR_HOSTS+=("$host")
done < <(terraform -chdir="$TF_DIR" output -json generator_public_dns_names | jq -r '.[]')
if [[ "${#GENERATOR_HOSTS[@]}" -lt 1 ]]; then
  echo "No direct Redis generator hosts are present in ${TF_DIR}." >&2
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
    -e "$RSYNC_SSH" \
    "${ROOT_DIR}/" "${SSH_USER}@${host}:${REMOTE_DIR}/"
  scp "${SSH_OPTS[@]}" "${ROOT_DIR}/.env.local" "${SSH_USER}@${host}:${REMOTE_DIR}/.env.local"
  ssh "${SSH_OPTS[@]}" "${SSH_USER}@${host}" \
    "chmod 600 '${REMOTE_DIR}/.env.local' && cd '${REMOTE_DIR}' && npm ci --no-audit --no-fund"
}

echo "Waiting for ${#GENERATOR_HOSTS[@]} direct Redis generators..."
pids=()
for host in "${GENERATOR_HOSTS[@]}"; do
  wait_for_host "$host" &
  pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid"; done

echo "Synchronizing the direct benchmark and installing dependencies..."
pids=()
for host in "${GENERATOR_HOSTS[@]}"; do
  sync_host "$host" &
  pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid"; done

IFS=',' read -r -a STAIRCASE_RATES <<<"$RATES"
STAIRCASE_ROOT="${ROOT_DIR}/memtier-output/aws-direct-redis/staircase-${RUN_ID}"
mkdir -p "$STAIRCASE_ROOT"
FIRST_HOST="${GENERATOR_HOSTS[0]}"
REMOTE_METRICS_ROOT="memtier-output/aws-direct-redis/${RUN_ID}/redis-cloud"
REMOTE_METRICS_PID="/tmp/lpl-direct-redis-cloud-metrics-${RUN_ID}.pid"

start_redis_cloud_metrics() {
  if [[ -z "$REDIS_CLOUD_PROMETHEUS_ENDPOINT" || -z "$REDIS_CLOUD_DATABASE_ID" ]]; then
    echo "Redis Cloud Prometheus sampling is disabled; endpoint or database ID was not provided."
    return 0
  fi
  echo "Starting Redis Cloud Prometheus sampling on the first direct generator..."
  ssh "${SSH_OPTS[@]}" "${SSH_USER}@${FIRST_HOST}" \
    "cd '${REMOTE_DIR}' && mkdir -p '${REMOTE_METRICS_ROOT}' && \
     if [[ -f '${REMOTE_METRICS_PID}' ]]; then \
       stale_pid=\$(cat '${REMOTE_METRICS_PID}'); \
       kill -TERM -- \"-\$stale_pid\" 2>/dev/null || true; \
       rm -f '${REMOTE_METRICS_PID}'; \
     fi && \
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
  echo "Stopping and collecting Redis Cloud Prometheus sampling..."
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
  mkdir -p "${STAIRCASE_ROOT}/redis-cloud"
  rsync -az -e "$RSYNC_SSH" \
    "${SSH_USER}@${FIRST_HOST}:${REMOTE_DIR}/${REMOTE_METRICS_ROOT}/" \
    "${STAIRCASE_ROOT}/redis-cloud/" || true
  if [[ -s "${STAIRCASE_ROOT}/redis-cloud/redis-cloud-metrics.ndjson" ]]; then
    node --import tsx scripts/summarize-redis-cloud-metrics.ts \
      "${STAIRCASE_ROOT}/redis-cloud/redis-cloud-metrics.ndjson" \
      "${STAIRCASE_ROOT}/redis-cloud" || true
  fi
}

trap stop_and_collect_redis_cloud_metrics EXIT
start_redis_cloud_metrics

for rate in "${STAIRCASE_RATES[@]}"; do
  rate="${rate//[[:space:]]/}"
  if [[ ! "$rate" =~ ^[1-9][0-9]*$ ]]; then
    echo "Invalid direct staircase rate: ${rate}" >&2
    exit 1
  fi
  step_name="step-${rate}-rps"
  remote_step_root="memtier-output/aws-direct-redis/${RUN_ID}/${step_name}"
  local_step_root="${STAIRCASE_ROOT}/${step_name}"
  host_target="$(awk "BEGIN { printf \"%.8f\", ${rate} / ${#GENERATOR_HOSTS[@]} }")"
  start_at_epoch_ms=$(( $(date +%s) * 1000 + START_DELAY_SECONDS * 1000 ))
  mkdir -p "$local_step_root"

  echo "Starting direct RESP step ${rate}/sec across ${#GENERATOR_HOSTS[@]} hosts (${host_target}/sec per host)."
  ssh "${SSH_OPTS[@]}" "${SSH_USER}@${FIRST_HOST}" \
    "cd '${REMOTE_DIR}' && mkdir -p '${remote_step_root}' && \
     REDIS_POOL_SIZE='${REDIS_POOL_SIZE_PER_PROCESS}' \
     LOAD_TEST_OUTPUT_DIR='${remote_step_root}' \
     npm run metrics:redis -- before-${rate}" \
    >"${local_step_root}/redis-metrics-before.log" 2>&1 || true

  pids=()
  step_status=0
  for index in "${!GENERATOR_HOSTS[@]}"; do
    host="${GENERATOR_HOSTS[$index]}"
    host_number=$((index + 1))
    host_name="$(printf 'host-%02d' "$host_number")"
    host_seed=$((BASE_RANDOM_SEED + index * 10000019))
    remote_host_dir="${remote_step_root}/${host_name}"
    ssh "${SSH_OPTS[@]}" "${SSH_USER}@${host}" \
      "cd '${REMOTE_DIR}' && mkdir -p '${remote_host_dir}' && \
       REDIS_POOL_SIZE='${REDIS_POOL_SIZE_PER_PROCESS}' \
       DIRECT_QUERY_TOTAL_TARGET_RPS='${host_target}' \
       DIRECT_QUERY_PROCESS_COUNT='${PROCESS_COUNT}' \
       DIRECT_QUERY_TEST_TIME='${TEST_TIME}' \
       DIRECT_QUERY_WARMUP_TIME='${WARMUP_TIME}' \
       DIRECT_QUERY_DRAIN_TIMEOUT_MS='${DRAIN_TIMEOUT_MS}' \
       DIRECT_QUERY_DISCONNECT_TIMEOUT_MS='${DISCONNECT_TIMEOUT_MS}' \
       DIRECT_QUERY_MAX_IN_FLIGHT='${MAX_IN_FLIGHT}' \
       DIRECT_QUERY_RANDOM_SEED='${host_seed}' \
       DIRECT_QUERY_GENERATOR_HOST='${host_name}' \
       LOAD_TEST_START_AT_EPOCH_MS='${start_at_epoch_ms}' \
       LOAD_TEST_OUTPUT_DIR='${remote_host_dir}' \
       npm run bench:redis-direct:host >'${remote_host_dir}/host-runner.log' 2>&1" &
    pids+=("$!")
  done
  for pid in "${pids[@]}"; do
    if ! wait "$pid"; then step_status=1; fi
  done

  ssh "${SSH_OPTS[@]}" "${SSH_USER}@${FIRST_HOST}" \
    "cd '${REMOTE_DIR}' && \
     REDIS_POOL_SIZE='${REDIS_POOL_SIZE_PER_PROCESS}' \
     LOAD_TEST_OUTPUT_DIR='${remote_step_root}' \
     npm run metrics:redis -- after-${rate}" \
    >"${local_step_root}/redis-metrics-after.log" 2>&1 || true

  for index in "${!GENERATOR_HOSTS[@]}"; do
    host="${GENERATOR_HOSTS[$index]}"
    host_name="$(printf 'host-%02d' "$((index + 1))")"
    mkdir -p "${local_step_root}/${host_name}"
    rsync -az -e "$RSYNC_SSH" \
      "${SSH_USER}@${host}:${REMOTE_DIR}/${remote_step_root}/${host_name}/" \
      "${local_step_root}/${host_name}/" || step_status=1
  done
  rsync -az -e "$RSYNC_SSH" \
    "${SSH_USER}@${FIRST_HOST}:${REMOTE_DIR}/${remote_step_root}/redis-metrics-*.json" \
    "${local_step_root}/" || true

  node --import tsx scripts/aggregate-direct-redis-results.ts "$local_step_root" || step_status=1
  sed -n '1,120p' "${local_step_root}/direct-query-aggregate.md" || true
  if [[ "$step_status" -ne 0 ]]; then
    echo "Direct RESP step ${rate}/sec produced one or more runner errors; artifacts were retained and the staircase will continue." >&2
  fi
done

stop_and_collect_redis_cloud_metrics
trap - EXIT
echo "Direct Redis staircase artifacts: ${STAIRCASE_ROOT}"
