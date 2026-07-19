#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF_DIR="${ROOT_DIR}/infra/aws-load-runner"
REMOTE_DIR="${AWS_LOAD_RUNNER_REMOTE_DIR:-/home/ec2-user/redis-financial-demo}"
SSH_USER="${AWS_LOAD_RUNNER_SSH_USER:-ec2-user}"
SSH_KEY_PATH="${AWS_LOAD_RUNNER_KEY_PATH:-}"
WEB_PORT="${AWS_LOAD_RUNNER_WEB_PORT:-3000}"
BENCHMARK="${AWS_LOAD_RUNNER_BENCHMARK:-concurrent}"
API_KEEP_ALIVE_TIMEOUT="${API_KEEP_ALIVE_TIMEOUT:-65000}"
QUERY_GENERATOR_PROCESSES="${QUERY_GENERATOR_PROCESSES:-1}"
QUERY_GENERATOR_MODE="${QUERY_GENERATOR_MODE:-single-host}"
REUSE_HOSTS="${AWS_LOAD_RUNNER_REUSE_HOSTS:-1}"
AWS_REGION="${AWS_REGION:-us-west-2}"
HOST_READY_TIMEOUT_SECONDS="${AWS_LOAD_RUNNER_HOST_READY_TIMEOUT_SECONDS:-1200}"
API_READY_TIMEOUT_SECONDS="${AWS_LOAD_RUNNER_API_READY_TIMEOUT_SECONDS:-900}"
DEFAULT_ACCOUNT_BY_ID_TARGET_RPS=10000
DEFAULT_STANDARD_QUERY_TARGET_RPS=9000
DEFAULT_JOIN_QUERY_TARGET_RPS=45000

if [[ -z "$SSH_KEY_PATH" ]]; then
  echo "AWS_LOAD_RUNNER_KEY_PATH is required." >&2
  exit 1
fi

if [[ ! -f "${ROOT_DIR}/.env.local" ]]; then
  echo ".env.local is required so both benchmark hosts can connect to Redis Cloud." >&2
  exit 1
fi

if [[ ! -d "$TF_DIR" ]]; then
  echo "Missing ${TF_DIR}. Provision infra/aws-load-runner first." >&2
  exit 1
fi

API_POOL_CAPACITY_JSON="$(terraform -chdir="$TF_DIR" output -json api_pool_capacity)"
API_ASG_NAMES_JSON="$(terraform -chdir="$TF_DIR" output -json api_autoscaling_group_names)"
API_TARGET_GROUP_ARNS_JSON="$(terraform -chdir="$TF_DIR" output -json api_target_group_arns)"
HEAVY_STAIRCASE_TARGET_COUNTS_JSON="$(jq -c '{
  positionsByAccount: .positions.desired_capacity,
  transactionsByAccount: .transactions.desired_capacity,
  transactionsBySecurity: .transactions.desired_capacity,
  accountPortfolioJoin: .portfolio.desired_capacity,
  accountActivityJoin: .activity.desired_capacity,
  accountSnapshot: .snapshot.desired_capacity
}' <<<"$API_POOL_CAPACITY_JSON")"
STAIRCASE_TARGET_COUNTS_JSON="$(jq -c '{
  accountById: .light.desired_capacity,
  securityById: .light.desired_capacity,
  securityByNo: .light.desired_capacity,
  positionByComposite: .light.desired_capacity,
  transactionById: .light.desired_capacity,
  transactionsByComposite: .light.desired_capacity,
  transactionsByAccountSecurity: .light.desired_capacity,
  positionsByAccount: .positions.desired_capacity,
  transactionsByAccount: .transactions.desired_capacity,
  transactionsBySecurity: .transactions.desired_capacity,
  accountPortfolioJoin: .portfolio.desired_capacity,
  accountActivityJoin: .activity.desired_capacity,
  accountSnapshot: .snapshot.desired_capacity
}' <<<"$API_POOL_CAPACITY_JSON")"
DEFAULT_STAIRCASE_TARGET_COUNT="$(jq -r --arg pattern "${QUERY_STAIRCASE_PATTERN:-accountById}" '.[$pattern] // 1' <<<"$STAIRCASE_TARGET_COUNTS_JSON")"

LIGHT_API_REDIS_POOL_SIZE="${LIGHT_API_REDIS_POOL_SIZE:-$(jq -r '.light.redis_pool_size' <<<"$API_POOL_CAPACITY_JSON")}"
POSITIONS_API_REDIS_POOL_SIZE="${POSITIONS_API_REDIS_POOL_SIZE:-$(jq -r '.positions.redis_pool_size' <<<"$API_POOL_CAPACITY_JSON")}"
TRANSACTIONS_API_REDIS_POOL_SIZE="${TRANSACTIONS_API_REDIS_POOL_SIZE:-$(jq -r '.transactions.redis_pool_size' <<<"$API_POOL_CAPACITY_JSON")}"
PORTFOLIO_API_REDIS_POOL_SIZE="${PORTFOLIO_API_REDIS_POOL_SIZE:-$(jq -r '.portfolio.redis_pool_size' <<<"$API_POOL_CAPACITY_JSON")}"
ACTIVITY_API_REDIS_POOL_SIZE="${ACTIVITY_API_REDIS_POOL_SIZE:-$(jq -r '.activity.redis_pool_size' <<<"$API_POOL_CAPACITY_JSON")}"
SNAPSHOT_API_REDIS_POOL_SIZE="${SNAPSHOT_API_REDIS_POOL_SIZE:-$(jq -r '.snapshot.redis_pool_size' <<<"$API_POOL_CAPACITY_JSON")}"

LIGHT_API_MAX_CONCURRENCY="${LIGHT_API_MAX_CONCURRENCY:-$(jq -r '.light.max_concurrency' <<<"$API_POOL_CAPACITY_JSON")}"
POSITIONS_API_MAX_CONCURRENCY="${POSITIONS_API_MAX_CONCURRENCY:-$(jq -r '.positions.max_concurrency' <<<"$API_POOL_CAPACITY_JSON")}"
TRANSACTIONS_API_MAX_CONCURRENCY="${TRANSACTIONS_API_MAX_CONCURRENCY:-$(jq -r '.transactions.max_concurrency' <<<"$API_POOL_CAPACITY_JSON")}"
PORTFOLIO_API_MAX_CONCURRENCY="${PORTFOLIO_API_MAX_CONCURRENCY:-$(jq -r '.portfolio.max_concurrency' <<<"$API_POOL_CAPACITY_JSON")}"
ACTIVITY_API_MAX_CONCURRENCY="${ACTIVITY_API_MAX_CONCURRENCY:-$(jq -r '.activity.max_concurrency' <<<"$API_POOL_CAPACITY_JSON")}"
SNAPSHOT_API_MAX_CONCURRENCY="${SNAPSHOT_API_MAX_CONCURRENCY:-$(jq -r '.snapshot.max_concurrency' <<<"$API_POOL_CAPACITY_JSON")}"

for setting in \
  "LIGHT_API_REDIS_POOL_SIZE:${LIGHT_API_REDIS_POOL_SIZE}" \
  "POSITIONS_API_REDIS_POOL_SIZE:${POSITIONS_API_REDIS_POOL_SIZE}" \
  "TRANSACTIONS_API_REDIS_POOL_SIZE:${TRANSACTIONS_API_REDIS_POOL_SIZE}" \
  "PORTFOLIO_API_REDIS_POOL_SIZE:${PORTFOLIO_API_REDIS_POOL_SIZE}" \
  "ACTIVITY_API_REDIS_POOL_SIZE:${ACTIVITY_API_REDIS_POOL_SIZE}" \
  "SNAPSHOT_API_REDIS_POOL_SIZE:${SNAPSHOT_API_REDIS_POOL_SIZE}" \
  "LIGHT_API_MAX_CONCURRENCY:${LIGHT_API_MAX_CONCURRENCY}" \
  "POSITIONS_API_MAX_CONCURRENCY:${POSITIONS_API_MAX_CONCURRENCY}" \
  "TRANSACTIONS_API_MAX_CONCURRENCY:${TRANSACTIONS_API_MAX_CONCURRENCY}" \
  "PORTFOLIO_API_MAX_CONCURRENCY:${PORTFOLIO_API_MAX_CONCURRENCY}" \
  "ACTIVITY_API_MAX_CONCURRENCY:${ACTIVITY_API_MAX_CONCURRENCY}" \
  "SNAPSHOT_API_MAX_CONCURRENCY:${SNAPSHOT_API_MAX_CONCURRENCY}" \
  "API_KEEP_ALIVE_TIMEOUT:${API_KEEP_ALIVE_TIMEOUT}" \
  "AWS_LOAD_RUNNER_HOST_READY_TIMEOUT_SECONDS:${HOST_READY_TIMEOUT_SECONDS}" \
  "AWS_LOAD_RUNNER_API_READY_TIMEOUT_SECONDS:${API_READY_TIMEOUT_SECONDS}"; do
  setting_name="${setting%%:*}"
  setting_value="${setting#*:}"
  if [[ ! "$setting_value" =~ ^[0-9]+$ ]] || [[ "$setting_value" -lt 1 ]]; then
    echo "${setting_name} must be a positive integer." >&2
    exit 1
  fi
done

if [[ "$REUSE_HOSTS" != "0" && "$REUSE_HOSTS" != "1" ]]; then
  echo "AWS_LOAD_RUNNER_REUSE_HOSTS must be 0 or 1." >&2
  exit 1
fi

publish_deployment_bundle() {
  local bucket key bundle_path
  bucket="$(terraform -chdir="$TF_DIR" output -raw deployment_bundle_bucket)"
  key="$(terraform -chdir="$TF_DIR" output -raw deployment_bundle_key)"
  bundle_path="${TMPDIR:-/tmp}/lpl-api-bundle-$$.tgz"
  echo "Publishing the current workspace and .env.local to the private API bootstrap bundle..."
  tar -czf "$bundle_path" \
    --exclude './.git' \
    --exclude './.next' \
    --exclude './node_modules' \
    --exclude './memtier-output' \
    --exclude './monitor-input' \
    --exclude './infra/redis-cloud/.terraform' \
    --exclude './infra/redis-cloud/terraform.tfstate*' \
    --exclude './infra/aws-load-runner/.terraform' \
    --exclude './infra/aws-load-runner/terraform.tfstate*' \
    --exclude './infra/aws-load-runner/api-bundle.tgz' \
    -C "$ROOT_DIR" .
  aws s3 cp "$bundle_path" "s3://${bucket}/${key}" --region "$AWS_REGION" --sse AES256
  rm -f "$bundle_path"
}

discover_api_hosts() {
  local pool="$1"
  local asg_name expected ids count
  asg_name="$(jq -r --arg pool "$pool" '.[$pool]' <<<"$API_ASG_NAMES_JSON")"
  expected="$(jq -r --arg pool "$pool" '.[$pool].desired_capacity' <<<"$API_POOL_CAPACITY_JSON")"
  echo "Discovering ${expected} ${pool} API instances in ${asg_name}..." >&2
  for _ in {1..120}; do
    ids="$(aws autoscaling describe-auto-scaling-groups \
      --region "$AWS_REGION" \
      --auto-scaling-group-names "$asg_name" \
      --query 'AutoScalingGroups[0].Instances[?LifecycleState==`InService`].InstanceId' \
      --output text)"
    count="$(awk '{ print NF }' <<<"$ids")"
    if [[ "$count" -ge "$expected" && -n "$ids" ]]; then
      aws ec2 describe-instances \
        --region "$AWS_REGION" \
        --instance-ids $ids \
        --query 'Reservations[].Instances[?State.Name==`running`].PublicDnsName' \
        --output text | tr '\t' '\n' | awk 'NF'
      return 0
    fi
    sleep 5
  done
  echo "${pool} API Auto Scaling Group did not reach ${expected} InService instances." >&2
  return 1
}

publish_deployment_bundle

LIGHT_API_HOSTS=()
POSITIONS_API_HOSTS=()
TRANSACTIONS_API_HOSTS=()
PORTFOLIO_API_HOSTS=()
ACTIVITY_API_HOSTS=()
SNAPSHOT_API_HOSTS=()
while IFS= read -r host; do LIGHT_API_HOSTS+=("$host"); done < <(discover_api_hosts light)
while IFS= read -r host; do POSITIONS_API_HOSTS+=("$host"); done < <(discover_api_hosts positions)
while IFS= read -r host; do TRANSACTIONS_API_HOSTS+=("$host"); done < <(discover_api_hosts transactions)
while IFS= read -r host; do PORTFOLIO_API_HOSTS+=("$host"); done < <(discover_api_hosts portfolio)
while IFS= read -r host; do ACTIVITY_API_HOSTS+=("$host"); done < <(discover_api_hosts activity)
while IFS= read -r host; do SNAPSHOT_API_HOSTS+=("$host"); done < <(discover_api_hosts snapshot)

API_HOSTS=(
  "${LIGHT_API_HOSTS[@]}"
  "${POSITIONS_API_HOSTS[@]}"
  "${TRANSACTIONS_API_HOSTS[@]}"
  "${PORTFOLIO_API_HOSTS[@]}"
  "${ACTIVITY_API_HOSTS[@]}"
  "${SNAPSHOT_API_HOSTS[@]}"
)

GENERATOR_HOSTS=()
if [[ -n "${AWS_LOAD_RUNNER_GENERATOR_HOSTS:-}" ]]; then
  IFS=',' read -r -a GENERATOR_HOSTS <<<"${AWS_LOAD_RUNNER_GENERATOR_HOSTS}"
elif [[ -n "${AWS_LOAD_RUNNER_GENERATOR_HOST:-}" ]]; then
  GENERATOR_HOSTS+=("${AWS_LOAD_RUNNER_GENERATOR_HOST}")
else
  while IFS= read -r host; do
    GENERATOR_HOSTS+=("$host")
  done < <(terraform -chdir="$TF_DIR" output -json generator_public_dns_names | jq -r '.[]')
fi

if [[ "${#GENERATOR_HOSTS[@]}" -lt 1 ]]; then
  echo "At least one load-generator host is required." >&2
  exit 1
fi

case "$QUERY_GENERATOR_MODE" in
  single-host)
    ACTIVE_GENERATOR_HOSTS=("${GENERATOR_HOSTS[0]}")
    ;;
  distributed)
    if [[ "$BENCHMARK" != "accountById" && "$BENCHMARK" != "concurrent" ]]; then
      echo "QUERY_GENERATOR_MODE=distributed supports accountById or concurrent." >&2
      exit 1
    fi
    if [[ "${#GENERATOR_HOSTS[@]}" -lt 2 ]]; then
      echo "QUERY_GENERATOR_MODE=distributed requires at least two generator hosts." >&2
      exit 1
    fi
    ACTIVE_GENERATOR_HOSTS=("${GENERATOR_HOSTS[@]}")
    QUERY_GENERATOR_PROCESSES="${#ACTIVE_GENERATOR_HOSTS[@]}"
    ;;
  *)
    echo "QUERY_GENERATOR_MODE must be single-host or distributed." >&2
    exit 1
    ;;
esac

GENERATOR_HOST="${ACTIVE_GENERATOR_HOSTS[0]}"

QUERY_BASE_URL="${QUERY_BASE_URL:-}"
if [[ -z "$QUERY_BASE_URL" ]]; then
  QUERY_BASE_URL="$(terraform -chdir="$TF_DIR" output -raw generator_query_url)"
fi

for api_host in "${API_HOSTS[@]}"; do
  for generator_host in "${ACTIVE_GENERATOR_HOSTS[@]}"; do
    if [[ "$api_host" == "$generator_host" ]]; then
      echo "The query API and load generators must use different hosts." >&2
      exit 1
    fi
  done
done

if [[ "${#API_HOSTS[@]}" -lt 6 ]]; then
  echo "The workload-isolation experiment requires at least one target in each of the six API pools." >&2
  exit 1
fi

SSH_OPTS=(
  -i "$SSH_KEY_PATH"
  -o BatchMode=yes
  -o ConnectTimeout=10
  -o ConnectionAttempts=1
  -o StrictHostKeyChecking=accept-new
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=3
)

wait_for_host() {
  local role="$1"
  local host="$2"
  local deadline=$((SECONDS + HOST_READY_TIMEOUT_SECONDS))
  echo "Waiting for ${role} bootstrap on ${host}..."
  until ssh "${SSH_OPTS[@]}" "${SSH_USER}@${host}" 'test -f /opt/lpl-load-runner-ready'; do
    if (( SECONDS >= deadline )); then
      echo "Timed out after ${HOST_READY_TIMEOUT_SECONDS}s waiting for ${role} bootstrap on ${host}." >&2
      return 1
    fi
    sleep 15
  done
}

sync_host() {
  local role="$1"
  local host="$2"
  echo "Syncing repository to ${role} ${host}:${REMOTE_DIR}..."
  ssh "${SSH_OPTS[@]}" "${SSH_USER}@${host}" "mkdir -p '${REMOTE_DIR}'"
  rsync -az --delete \
    --exclude '.git/' \
    --exclude '.next/' \
    --exclude 'node_modules/' \
    --exclude 'memtier-output/' \
    --exclude 'monitor-input/' \
    --exclude 'infra/redis-cloud/.terraform/' \
    --exclude 'infra/redis-cloud/terraform.tfstate*' \
    --exclude 'infra/redis-cloud/tfplan*' \
    --exclude 'infra/aws-load-runner/.terraform/' \
    --exclude 'infra/aws-load-runner/terraform.tfstate*' \
    --exclude 'infra/aws-load-runner/tfplan*' \
    --exclude 'infra/aws-load-runner/api-bundle.tgz' \
    -e "ssh ${SSH_OPTS[*]}" \
    "${ROOT_DIR}/" "${SSH_USER}@${host}:${REMOTE_DIR}/"

  scp "${SSH_OPTS[@]}" "${ROOT_DIR}/.env.local" "${SSH_USER}@${host}:${REMOTE_DIR}/.env.local"
  ssh "${SSH_OPTS[@]}" "${SSH_USER}@${host}" "chmod 600 '${REMOTE_DIR}/.env.local'"
}

wait_for_target_group() {
  local fleet="$1"
  local expected_targets="$2"
  local target_group_arn="$3"
  local healthy_targets=0
  local total_targets=0
  local states

  echo "Waiting for all ${expected_targets} ${fleet} API workers to become healthy behind the load balancer..."
  for _ in {1..60}; do
    states="$(aws elbv2 describe-target-health \
      --region "$AWS_REGION" \
      --target-group-arn "$target_group_arn" \
      --query 'TargetHealthDescriptions[].TargetHealth.State' \
      --output text)"
    healthy_targets="$(printf '%s\n' "$states" | tr '\t' '\n' | awk '$1 == "healthy" { count++ } END { print count + 0 }')"
    total_targets="$(printf '%s\n' "$states" | tr '\t' '\n' | awk 'NF && $1 != "None" { count++ } END { print count + 0 }')"
    if [[ "$healthy_targets" -eq "$expected_targets" && "$total_targets" -eq "$expected_targets" ]]; then
      echo "All ${healthy_targets}/${total_targets} ${fleet} API workers are healthy."
      return 0
    fi
    sleep 5
  done

  echo "Only ${healthy_targets}/${total_targets} ${fleet} API workers became healthy." >&2
  return 1
}

start_api_fleet() {
  local fleet="$1"
  local redis_pool_size="$2"
  shift 2
  local hosts=("$@")
  local index
  local api_host
  local worker_number
  local api_ready

  for index in "${!hosts[@]}"; do
    api_host="${hosts[$index]}"
    worker_number=$((index + 1))
    wait_for_host "${fleet} query API worker ${worker_number}/${#hosts[@]}" "$api_host"
    sync_host "${fleet} query API worker ${worker_number}/${#hosts[@]}" "$api_host"
    echo "Building and restarting ${fleet} query API worker ${worker_number}/${#hosts[@]} on ${api_host}..."
    ssh "${SSH_OPTS[@]}" "${SSH_USER}@${api_host}" \
      "sudo sed -i \
         -e 's/^API_REDIS_POOL_SIZE=.*/API_REDIS_POOL_SIZE=${redis_pool_size}/' \
         -e 's/^REDIS_POOL_SIZE=.*/REDIS_POOL_SIZE=${redis_pool_size}/' \
         -e 's/^API_MAX_CONCURRENT_LIGHT=.*/API_MAX_CONCURRENT_LIGHT=${LIGHT_API_MAX_CONCURRENCY}/' \
         -e 's/^API_MAX_CONCURRENT_POSITIONS=.*/API_MAX_CONCURRENT_POSITIONS=${POSITIONS_API_MAX_CONCURRENCY}/' \
         -e 's/^API_MAX_CONCURRENT_TRANSACTIONS=.*/API_MAX_CONCURRENT_TRANSACTIONS=${TRANSACTIONS_API_MAX_CONCURRENCY}/' \
         -e 's/^API_MAX_CONCURRENT_PORTFOLIO=.*/API_MAX_CONCURRENT_PORTFOLIO=${PORTFOLIO_API_MAX_CONCURRENCY}/' \
         -e 's/^API_MAX_CONCURRENT_ACTIVITY=.*/API_MAX_CONCURRENT_ACTIVITY=${ACTIVITY_API_MAX_CONCURRENCY}/' \
         -e 's/^API_MAX_CONCURRENT_SNAPSHOT=.*/API_MAX_CONCURRENT_SNAPSHOT=${SNAPSHOT_API_MAX_CONCURRENCY}/' \
         /etc/lpl-query-api.env && \
       cd '${REMOTE_DIR}' && npm ci && npm run build && sudo systemctl restart lpl-query-api.service"
    api_ready=0
    for _ in {1..60}; do
      if ssh "${SSH_OPTS[@]}" "${SSH_USER}@${api_host}" \
        "curl -fsS 'http://127.0.0.1:${WEB_PORT}/api/health' >/dev/null"; then
        api_ready=1
        break
      fi
      sleep 2
    done
    if [[ "$api_ready" -ne 1 ]]; then
      echo "${fleet} worker ${api_host} did not become ready after restart." >&2
      ssh "${SSH_OPTS[@]}" "${SSH_USER}@${api_host}" \
        "sudo journalctl -u lpl-query-api.service --no-pager -n 200" >&2 || true
      return 1
    fi
  done
}

collect_api_artifacts() {
  local fleet="$1"
  shift
  local hosts=("$@")
  local index
  local api_host
  local worker_number

  for index in "${!hosts[@]}"; do
    api_host="${hosts[$index]}"
    worker_number="$(printf '%02d' "$((index + 1))")"
    ssh "${SSH_OPTS[@]}" "${SSH_USER}@${api_host}" \
      "curl -fsS 'http://127.0.0.1:${WEB_PORT}/api/health'" \
      >"${ROOT_DIR}/memtier-output/aws-load-runner/api-health-${fleet}-${worker_number}.json" || true
    ssh "${SSH_OPTS[@]}" "${SSH_USER}@${api_host}" \
      "sudo journalctl -u lpl-query-api.service --no-pager -n 500" \
      >"${ROOT_DIR}/memtier-output/aws-load-runner/web-${fleet}-${worker_number}.log" 2>&1 || true
  done
}

allocate_share() {
  local total="$1"
  local index="$2"
  local count="$3"
  local base=$(( total / count ))
  local remainder=$(( total % count ))
  if [[ "$index" -lt "$remainder" ]]; then
    echo $(( base + 1 ))
  else
    echo "$base"
  fi
}

DISTRIBUTED_OUTPUT_DIR=""
DISTRIBUTED_QUERY_GENERATOR_COUNT=""
DISTRIBUTED_TRADE_GENERATOR_COUNT=""
run_distributed_account_by_id() {
  local host_count="${#ACTIVE_GENERATOR_HOSTS[@]}"
  local total_target_rps="${QUERY_DEFAULT_TARGET_RPS:-$DEFAULT_ACCOUNT_BY_ID_TARGET_RPS}"
  local total_max_in_flight="${QUERY_MAX_IN_FLIGHT:-10000}"
  local total_max_sockets="${QUERY_MAX_SOCKETS:-10000}"
  local total_max_free_sockets="${QUERY_MAX_FREE_SOCKETS:-512}"
  local base_random_seed="${QUERY_RANDOM_SEED:-20260714}"
  local test_time="${QUERY_TEST_TIME:-60}"
  local warmup_time="${QUERY_WARMUP_TIME:-0}"
  local start_delay_seconds="${QUERY_SHARD_START_DELAY_SECONDS:-15}"
  local run_id="${QUERY_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
  local value_name value index generator_host shard_number shard_name
  local remote_shard_directory shard_target_rps shard_max_in_flight
  local shard_max_sockets shard_max_free_sockets shard_random_seed pid

  for value_name in total_target_rps total_max_in_flight total_max_sockets total_max_free_sockets base_random_seed test_time warmup_time start_delay_seconds; do
    value="${!value_name}"
    if [[ ! "$value" =~ ^[0-9]+$ ]]; then
      echo "${value_name} must be a non-negative integer." >&2
      return 1
    fi
  done
  for value_name in total_target_rps total_max_in_flight total_max_sockets total_max_free_sockets; do
    if [[ "${!value_name}" -lt "$host_count" ]]; then
      echo "${value_name} must be at least the generator host count (${host_count})." >&2
      return 1
    fi
  done
  if [[ ! "$run_id" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "QUERY_RUN_ID may contain only letters, numbers, dots, underscores, and hyphens." >&2
    return 1
  fi

  local remote_output_root="memtier-output/query-account-by-id-${host_count}-hosts-${run_id}"
  DISTRIBUTED_OUTPUT_DIR="${ROOT_DIR}/memtier-output/aws-load-runner/query-account-by-id-${host_count}-hosts-${run_id}"
  local start_at_epoch_ms=$(( $(date +%s) * 1000 + start_delay_seconds * 1000 ))
  local -a generator_pids=()
  local benchmark_status=0

  mkdir -p "$DISTRIBUTED_OUTPUT_DIR"
  echo "Starting ${host_count} generator hosts at ${start_at_epoch_ms} with aggregate target ${total_target_rps} req/sec..."
  for index in "${!ACTIVE_GENERATOR_HOSTS[@]}"; do
    generator_host="${ACTIVE_GENERATOR_HOSTS[$index]}"
    shard_number=$(( index + 1 ))
    shard_name="$(printf 'shard-%02d' "$shard_number")"
    remote_shard_directory="${remote_output_root}/${shard_name}"
    shard_target_rps="$(allocate_share "$total_target_rps" "$index" "$host_count")"
    shard_max_in_flight="$(allocate_share "$total_max_in_flight" "$index" "$host_count")"
    shard_max_sockets="$(allocate_share "$total_max_sockets" "$index" "$host_count")"
    shard_max_free_sockets="$(allocate_share "$total_max_free_sockets" "$index" "$host_count")"
    shard_random_seed=$(( base_random_seed + index * 1000003 ))

    ssh "${SSH_OPTS[@]}" "${SSH_USER}@${generator_host}" \
      "cd '${REMOTE_DIR}' && \
       mkdir -p '${remote_shard_directory}' && \
       QUERY_BASE_URL='${QUERY_BASE_URL}' \
       QUERY_DEFAULT_TARGET_RPS='${shard_target_rps}' \
       QUERY_TEST_TIME='${test_time}' \
       QUERY_WARMUP_TIME='${warmup_time}' \
       QUERY_REQUEST_TIMEOUT_MS='${QUERY_REQUEST_TIMEOUT_MS:-30000}' \
       QUERY_SOCKET_TIMEOUT_MS='${QUERY_SOCKET_TIMEOUT_MS:-30000}' \
       QUERY_DRAIN_TIMEOUT_MS='${QUERY_DRAIN_TIMEOUT_MS:-30000}' \
       QUERY_ACCEPT_ENCODING='${QUERY_ACCEPT_ENCODING:-}' \
       QUERY_MAX_IN_FLIGHT='${shard_max_in_flight}' \
       QUERY_MAX_SOCKETS='${shard_max_sockets}' \
       QUERY_MAX_FREE_SOCKETS='${shard_max_free_sockets}' \
       QUERY_SAMPLE_POOL_SIZE='${QUERY_SAMPLE_POOL_SIZE:-1000}' \
       QUERY_RANDOM_SEED='${shard_random_seed}' \
       QUERY_GENERATOR_SHARD_INDEX='${shard_number}' \
       QUERY_GENERATOR_SHARD_COUNT='${host_count}' \
       QUERY_GENERATOR_HOST='${generator_host}' \
       QUERY_EXPORT_LATENCY_HISTOGRAM=1 \
       LOAD_TEST_START_AT_EPOCH_MS='${start_at_epoch_ms}' \
       LOAD_TEST_OUTPUT_DIR='${remote_shard_directory}' \
       npm run bench:query:account-by-id >'${remote_shard_directory}/generator.log' 2>&1" &
    generator_pids+=("$!")
  done

  for pid in "${generator_pids[@]}"; do
    if ! wait "$pid"; then
      benchmark_status=1
    fi
  done

  for index in "${!ACTIVE_GENERATOR_HOSTS[@]}"; do
    generator_host="${ACTIVE_GENERATOR_HOSTS[$index]}"
    shard_number=$(( index + 1 ))
    shard_name="$(printf 'shard-%02d' "$shard_number")"
    mkdir -p "${DISTRIBUTED_OUTPUT_DIR}/${shard_name}"
    if ! rsync -az -e "ssh ${SSH_OPTS[*]}" \
      "${SSH_USER}@${generator_host}:${REMOTE_DIR}/${remote_output_root}/${shard_name}/" \
      "${DISTRIBUTED_OUTPUT_DIR}/${shard_name}/"; then
      benchmark_status=1
    fi
    echo "Generator log: ${DISTRIBUTED_OUTPUT_DIR}/${shard_name}/generator.log"
    sed -n '1,200p' "${DISTRIBUTED_OUTPUT_DIR}/${shard_name}/generator.log" || true
  done

  if ! node --import tsx scripts/aggregate-query-shards.ts "$DISTRIBUTED_OUTPUT_DIR"; then
    benchmark_status=1
  fi
  echo "Distributed generator artifacts: ${DISTRIBUTED_OUTPUT_DIR}"
  return "$benchmark_status"
}

run_distributed_concurrent() {
  local host_count="${#ACTIVE_GENERATOR_HOSTS[@]}"
  local trade_host_count="${TRADE_GENERATOR_COUNT:-2}"
  if [[ ! "$trade_host_count" =~ ^[1-9][0-9]*$ ]] || (( trade_host_count >= host_count )); then
    echo "TRADE_GENERATOR_COUNT must be a positive integer smaller than the generator host count (${host_count})." >&2
    return 1
  fi
  local query_host_count=$(( host_count - trade_host_count ))
  if (( query_host_count != 6 && query_host_count != 7 )); then
    echo "Distributed concurrent mode requires six or seven query generators plus the dedicated trade generators; received ${query_host_count} query generators." >&2
    return 1
  fi
  local total_trade_target_rps="${MEMTIER_TRADE_TARGET_RPS:-30000}"
  local total_trade_max_in_flight="${TRADE_MAX_IN_FLIGHT:-10000}"
  local base_trade_random_seed="${TRADE_RANDOM_SEED:-20260714}"
  local value_name
  for value_name in total_trade_target_rps total_trade_max_in_flight base_trade_random_seed; do
    if [[ ! "${!value_name}" =~ ^[1-9][0-9]*$ ]]; then
      echo "${value_name} must be a positive integer." >&2
      return 1
    fi
  done
  DISTRIBUTED_QUERY_GENERATOR_COUNT="$query_host_count"
  DISTRIBUTED_TRADE_GENERATOR_COUNT="$trade_host_count"
  local run_id="${QUERY_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
  local start_delay_seconds="${QUERY_SHARD_START_DELAY_SECONDS:-20}"
  local start_at_epoch_ms=$(( $(date +%s) * 1000 + start_delay_seconds * 1000 ))
  local remote_output_root="memtier-output/concurrent-${host_count}-hosts-${run_id}"
  local -a query_groups
  if (( query_host_count == 7 )); then
    query_groups=(
      "account-by-id,security-by-id,security-by-no"
      "position-by-composite,transaction-by-id,transactions-by-account-security"
      "positions-by-account"
      "transactions-by-account,transactions-by-security"
      "account-portfolio-join"
      "account-activity-join"
      "account-snapshot"
    )
  else
    query_groups=(
      "account-by-id,security-by-id,security-by-no,position-by-composite,transaction-by-id,transactions-by-account-security"
      "positions-by-account"
      "transactions-by-account,transactions-by-security"
      "account-portfolio-join"
      "account-activity-join"
      "account-snapshot"
    )
  fi
  local -a generator_pids=()
  local benchmark_status=0
  local index generator_host host_number host_name remote_host_directory
  local query_csv run_queries run_trade trade_shard_index trade_target_rps
  local trade_max_in_flight trade_random_seed pid

  if [[ ! "$run_id" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "QUERY_RUN_ID may contain only letters, numbers, dots, underscores, and hyphens." >&2
    return 1
  fi

  DISTRIBUTED_OUTPUT_DIR="${ROOT_DIR}/memtier-output/aws-load-runner/concurrent-${host_count}-hosts-${run_id}"
  mkdir -p "$DISTRIBUTED_OUTPUT_DIR"
  echo "Starting the distributed concurrent workload across ${host_count} generator hosts at ${start_at_epoch_ms}..."
  echo "  query generators: ${query_host_count}"
  echo "  dedicated trade generators: ${trade_host_count}"

  for index in "${!ACTIVE_GENERATOR_HOSTS[@]}"; do
    generator_host="${ACTIVE_GENERATOR_HOSTS[$index]}"
    host_number=$(( index + 1 ))
    host_name="$(printf 'host-%02d' "$host_number")"
    remote_host_directory="${remote_output_root}/${host_name}"
    query_csv=""
    run_queries=0
    run_trade=0
    trade_shard_index=1
    trade_target_rps=1
    trade_max_in_flight=1
    trade_random_seed="$base_trade_random_seed"
    if (( index < query_host_count )); then
      run_queries=1
      query_csv="${query_groups[$index]}"
    else
      run_trade=1
      trade_shard_index=$(( index - query_host_count + 1 ))
      trade_target_rps="$(allocate_share "$total_trade_target_rps" "$((trade_shard_index - 1))" "$trade_host_count")"
      trade_max_in_flight="$(allocate_share "$total_trade_max_in_flight" "$((trade_shard_index - 1))" "$trade_host_count")"
      trade_random_seed=$(( base_trade_random_seed + (trade_shard_index - 1) * 1000003 ))
    fi

    ssh "${SSH_OPTS[@]}" "${SSH_USER}@${generator_host}" \
      "cd '${REMOTE_DIR}' && \
       mkdir -p '${remote_host_directory}' && \
       QUERY_BASE_URL='${QUERY_BASE_URL}' \
       QUERY_BENCHMARKS='${query_csv}' \
       RUN_QUERY_BENCHMARKS='${run_queries}' \
       RUN_TRADE_WRITES='${run_trade}' \
       QUERY_DEFAULT_TARGET_RPS='${QUERY_DEFAULT_TARGET_RPS:-$DEFAULT_STANDARD_QUERY_TARGET_RPS}' \
       QUERY_JOIN_TARGET_RPS='${QUERY_JOIN_TARGET_RPS:-$DEFAULT_JOIN_QUERY_TARGET_RPS}' \
       QUERY_TEST_TIME='${QUERY_TEST_TIME:-60}' \
       QUERY_WARMUP_TIME='${QUERY_WARMUP_TIME:-0}' \
       QUERY_REQUEST_TIMEOUT_MS='${QUERY_REQUEST_TIMEOUT_MS:-30000}' \
       QUERY_SOCKET_TIMEOUT_MS='${QUERY_SOCKET_TIMEOUT_MS:-30000}' \
       QUERY_DRAIN_TIMEOUT_MS='${QUERY_DRAIN_TIMEOUT_MS:-30000}' \
       QUERY_ACCEPT_ENCODING='${QUERY_ACCEPT_ENCODING:-}' \
       QUERY_MAX_IN_FLIGHT='${QUERY_MAX_IN_FLIGHT:-10000}' \
       QUERY_MAX_SOCKETS='${QUERY_MAX_SOCKETS:-10000}' \
       QUERY_MAX_FREE_SOCKETS='${QUERY_MAX_FREE_SOCKETS:-512}' \
       QUERY_SAMPLE_POOL_SIZE='${QUERY_SAMPLE_POOL_SIZE:-1000}' \
       QUERY_RANDOM_SEED='${QUERY_RANDOM_SEED:-20260714}' \
       MEMTIER_TRADE_TARGET_RPS='${trade_target_rps}' \
       TRADE_MAX_IN_FLIGHT='${trade_max_in_flight}' \
       TRADE_SAMPLE_POOL_SIZE='${TRADE_SAMPLE_POOL_SIZE:-1000}' \
       TRADE_ACCOUNT_DISCOVERY_POOL_SIZE='${TRADE_ACCOUNT_DISCOVERY_POOL_SIZE:-5000}' \
       TRADE_RANDOM_SEED='${trade_random_seed}' \
       TRADE_SHARD_INDEX='${trade_shard_index}' \
       TRADE_SHARD_COUNT='${trade_host_count}' \
       TRADE_GENERATOR_HOST='${generator_host}' \
       TRADE_EXPORT_LATENCY_HISTOGRAM=1 \
       LOAD_TEST_START_AT_EPOCH_MS='${start_at_epoch_ms}' \
       LOAD_TEST_OUTPUT_DIR='${remote_host_directory}' \
       npm run bench:concurrent >'${remote_host_directory}/concurrent-runner.log' 2>&1" &
    generator_pids+=("$!")
  done

  for pid in "${generator_pids[@]}"; do
    if ! wait "$pid"; then benchmark_status=1; fi
  done

  for index in "${!ACTIVE_GENERATOR_HOSTS[@]}"; do
    generator_host="${ACTIVE_GENERATOR_HOSTS[$index]}"
    host_number=$(( index + 1 ))
    host_name="$(printf 'host-%02d' "$host_number")"
    mkdir -p "${DISTRIBUTED_OUTPUT_DIR}/${host_name}"
    if ! rsync -az -e "ssh ${SSH_OPTS[*]}" \
      "${SSH_USER}@${generator_host}:${REMOTE_DIR}/${remote_output_root}/${host_name}/" \
      "${DISTRIBUTED_OUTPUT_DIR}/${host_name}/"; then
      benchmark_status=1
    fi
    echo "Concurrent generator log: ${DISTRIBUTED_OUTPUT_DIR}/${host_name}/concurrent-runner.log"
    tail -n 120 "${DISTRIBUTED_OUTPUT_DIR}/${host_name}/concurrent-runner.log" || true
  done

  if (( trade_host_count > 1 )); then
    if ! node --import tsx scripts/aggregate-trade-shards.ts "$DISTRIBUTED_OUTPUT_DIR"; then
      benchmark_status=1
    fi
  fi
  if ! node --import tsx scripts/summarize-concurrent-results.ts "$DISTRIBUTED_OUTPUT_DIR"; then
    benchmark_status=1
  fi

  echo "Distributed concurrent artifacts: ${DISTRIBUTED_OUTPUT_DIR}"
  return "$benchmark_status"
}

for index in "${!ACTIVE_GENERATOR_HOSTS[@]}"; do
  generator_host="${ACTIVE_GENERATOR_HOSTS[$index]}"
  generator_number=$((index + 1))
  wait_for_host "load generator ${generator_number}/${#ACTIVE_GENERATOR_HOSTS[@]}" "$generator_host"
  sync_host "load generator ${generator_number}/${#ACTIVE_GENERATOR_HOSTS[@]}" "$generator_host"
done

if [[ "$REUSE_HOSTS" == "1" ]]; then
  echo "Using the Terraform bootstrap bundle already installed on API workers."
else
  start_api_fleet "light" "$LIGHT_API_REDIS_POOL_SIZE" "${LIGHT_API_HOSTS[@]}"
  start_api_fleet "positions" "$POSITIONS_API_REDIS_POOL_SIZE" "${POSITIONS_API_HOSTS[@]}"
  start_api_fleet "transactions" "$TRANSACTIONS_API_REDIS_POOL_SIZE" "${TRANSACTIONS_API_HOSTS[@]}"
  start_api_fleet "portfolio" "$PORTFOLIO_API_REDIS_POOL_SIZE" "${PORTFOLIO_API_HOSTS[@]}"
  start_api_fleet "activity" "$ACTIVITY_API_REDIS_POOL_SIZE" "${ACTIVITY_API_HOSTS[@]}"
  start_api_fleet "snapshot" "$SNAPSHOT_API_REDIS_POOL_SIZE" "${SNAPSHOT_API_HOSTS[@]}"
fi

wait_for_target_group "light" "${#LIGHT_API_HOSTS[@]}" "$(jq -r '.light' <<<"$API_TARGET_GROUP_ARNS_JSON")"
wait_for_target_group "positions" "${#POSITIONS_API_HOSTS[@]}" "$(jq -r '.positions' <<<"$API_TARGET_GROUP_ARNS_JSON")"
wait_for_target_group "transactions" "${#TRANSACTIONS_API_HOSTS[@]}" "$(jq -r '.transactions' <<<"$API_TARGET_GROUP_ARNS_JSON")"
wait_for_target_group "portfolio" "${#PORTFOLIO_API_HOSTS[@]}" "$(jq -r '.portfolio' <<<"$API_TARGET_GROUP_ARNS_JSON")"
wait_for_target_group "activity" "${#ACTIVITY_API_HOSTS[@]}" "$(jq -r '.activity' <<<"$API_TARGET_GROUP_ARNS_JSON")"
wait_for_target_group "snapshot" "${#SNAPSHOT_API_HOSTS[@]}" "$(jq -r '.snapshot' <<<"$API_TARGET_GROUP_ARNS_JSON")"

generator_install_pids=()
for index in "${!ACTIVE_GENERATOR_HOSTS[@]}"; do
  generator_host="${ACTIVE_GENERATOR_HOSTS[$index]}"
  generator_number=$((index + 1))
  api_deadline=$((SECONDS + API_READY_TIMEOUT_SECONDS))
  echo "Waiting for the load-balanced API from generator ${generator_number}/${#ACTIVE_GENERATOR_HOSTS[@]} at ${QUERY_BASE_URL}..."
  until ssh "${SSH_OPTS[@]}" "${SSH_USER}@${generator_host}" "curl -fsS '${QUERY_BASE_URL}/api/health' >/dev/null"; do
    if (( SECONDS >= api_deadline )); then
      echo "Timed out after ${API_READY_TIMEOUT_SECONDS}s waiting for the load-balanced API from ${generator_host}." >&2
      exit 1
    fi
    sleep 5
  done
  echo "Installing load generator ${generator_number}/${#ACTIVE_GENERATOR_HOSTS[@]} dependencies on ${generator_host}..."
  ssh "${SSH_OPTS[@]}" "${SSH_USER}@${generator_host}" \
    "cd '${REMOTE_DIR}' && npm ci --no-audit --no-fund" &
  generator_install_pids+=("$!")
done

generator_install_status=0
for pid in "${generator_install_pids[@]}"; do
  wait "$pid" || generator_install_status=1
done
if [[ "$generator_install_status" -ne 0 ]]; then
  echo "One or more load generators failed dependency installation." >&2
  exit 1
fi

ssh "${SSH_OPTS[@]}" "${SSH_USER}@${GENERATOR_HOST}" \
  "cd '${REMOTE_DIR}' && npm run metrics:redis -- before-${BENCHMARK}"

case "$BENCHMARK" in
  accountById)
    if [[ ! "$QUERY_GENERATOR_PROCESSES" =~ ^[0-9]+$ ]] || [[ "$QUERY_GENERATOR_PROCESSES" -lt 1 ]]; then
      echo "QUERY_GENERATOR_PROCESSES must be a positive integer." >&2
      exit 1
    fi
    if [[ "$QUERY_GENERATOR_MODE" == "distributed" ]]; then
      benchmark_command=""
    elif [[ "$QUERY_GENERATOR_PROCESSES" -gt 1 ]]; then
      benchmark_command="npm run bench:query:account-by-id:sharded"
    else
      benchmark_command="npm run bench:query:account-by-id"
    fi
    default_max_in_flight=10000
    default_query_target_rps="$DEFAULT_ACCOUNT_BY_ID_TARGET_RPS"
    default_join_target_rps="$DEFAULT_JOIN_QUERY_TARGET_RPS"
    ;;
  concurrent)
    benchmark_command="npm run bench:concurrent"
    default_max_in_flight=10000
    default_query_target_rps="$DEFAULT_STANDARD_QUERY_TARGET_RPS"
    default_join_target_rps="$DEFAULT_JOIN_QUERY_TARGET_RPS"
    ;;
  staircase)
    benchmark_command="npm run bench:query:staircase"
    default_max_in_flight=10000
    default_query_target_rps="$DEFAULT_STANDARD_QUERY_TARGET_RPS"
    default_join_target_rps="$DEFAULT_JOIN_QUERY_TARGET_RPS"
    ;;
  staircaseSuite)
    benchmark_command="npm run bench:query:staircase:heavy"
    default_max_in_flight=10000
    default_query_target_rps="$DEFAULT_STANDARD_QUERY_TARGET_RPS"
    default_join_target_rps="$DEFAULT_JOIN_QUERY_TARGET_RPS"
    ;;
  *)
    echo "AWS_LOAD_RUNNER_BENCHMARK must be accountById, staircase, staircaseSuite, or concurrent." >&2
    exit 1
    ;;
esac

echo "Running ${BENCHMARK} load in ${QUERY_GENERATOR_MODE} mode against ${QUERY_BASE_URL}..."
set +e
if [[ "$QUERY_GENERATOR_MODE" == "distributed" ]]; then
  if [[ "$BENCHMARK" == "accountById" ]]; then
    run_distributed_account_by_id
  elif [[ "$BENCHMARK" == "concurrent" ]]; then
    run_distributed_concurrent
  else
    echo "${BENCHMARK} requires QUERY_GENERATOR_MODE=single-host." >&2
    false
  fi
else
  ssh "${SSH_OPTS[@]}" "${SSH_USER}@${GENERATOR_HOST}" \
    "cd '${REMOTE_DIR}' && \
     QUERY_BASE_URL='${QUERY_BASE_URL}' \
     QUERY_DEFAULT_TARGET_RPS='${QUERY_DEFAULT_TARGET_RPS:-$default_query_target_rps}' \
     QUERY_JOIN_TARGET_RPS='${QUERY_JOIN_TARGET_RPS:-$default_join_target_rps}' \
     QUERY_TEST_TIME='${QUERY_TEST_TIME:-60}' \
     QUERY_WARMUP_TIME='${QUERY_WARMUP_TIME:-0}' \
     QUERY_REQUEST_TIMEOUT_MS='${QUERY_REQUEST_TIMEOUT_MS:-30000}' \
     QUERY_SOCKET_TIMEOUT_MS='${QUERY_SOCKET_TIMEOUT_MS:-30000}' \
     QUERY_DRAIN_TIMEOUT_MS='${QUERY_DRAIN_TIMEOUT_MS:-30000}' \
     QUERY_ACCEPT_ENCODING='${QUERY_ACCEPT_ENCODING:-}' \
     QUERY_MAX_IN_FLIGHT='${QUERY_MAX_IN_FLIGHT:-$default_max_in_flight}' \
     QUERY_MAX_SOCKETS='${QUERY_MAX_SOCKETS:-10000}' \
     QUERY_MAX_FREE_SOCKETS='${QUERY_MAX_FREE_SOCKETS:-512}' \
     QUERY_SAMPLE_POOL_SIZE='${QUERY_SAMPLE_POOL_SIZE:-1000}' \
     QUERY_RANDOM_SEED='${QUERY_RANDOM_SEED:-20260714}' \
     QUERY_STAIRCASE_PATTERN='${QUERY_STAIRCASE_PATTERN:-accountById}' \
     QUERY_STAIRCASE_TARGET_COUNT='${QUERY_STAIRCASE_TARGET_COUNT:-$DEFAULT_STAIRCASE_TARGET_COUNT}' \
     QUERY_STAIRCASE_SUITE_PATTERNS='${QUERY_STAIRCASE_SUITE_PATTERNS:-}' \
     QUERY_STAIRCASE_TARGET_COUNTS_JSON='${QUERY_STAIRCASE_TARGET_COUNTS_JSON:-$HEAVY_STAIRCASE_TARGET_COUNTS_JSON}' \
     QUERY_STAIRCASE_RATES='${QUERY_STAIRCASE_RATES:-1000,2000,4000,8000}' \
     QUERY_STAIRCASE_P95_SLO_MS='${QUERY_STAIRCASE_P95_SLO_MS:-250}' \
     QUERY_STAIRCASE_MAX_ERROR_RATE='${QUERY_STAIRCASE_MAX_ERROR_RATE:-0.001}' \
     QUERY_STAIRCASE_MIN_ACHIEVEMENT_RATIO='${QUERY_STAIRCASE_MIN_ACHIEVEMENT_RATIO:-0.98}' \
     QUERY_STAIRCASE_HEADROOM_FACTOR='${QUERY_STAIRCASE_HEADROOM_FACTOR:-1.3}' \
     QUERY_STAIRCASE_STOP_ON_FAILURE='${QUERY_STAIRCASE_STOP_ON_FAILURE:-1}' \
     QUERY_GENERATOR_PROCESSES='${QUERY_GENERATOR_PROCESSES}' \
     QUERY_SHARD_START_DELAY_SECONDS='${QUERY_SHARD_START_DELAY_SECONDS:-10}' \
     QUERY_RUN_ID='${QUERY_RUN_ID:-}' \
     LOAD_TEST_OUTPUT_DIR='${LOAD_TEST_OUTPUT_DIR:-memtier-output}' \
     MEMTIER_TRADE_TARGET_RPS='${MEMTIER_TRADE_TARGET_RPS:-30000}' \
     TRADE_MAX_IN_FLIGHT='${TRADE_MAX_IN_FLIGHT:-10000}' \
     TRADE_SAMPLE_POOL_SIZE='${TRADE_SAMPLE_POOL_SIZE:-1000}' \
     TRADE_RANDOM_SEED='${TRADE_RANDOM_SEED:-20260714}' \
     ${benchmark_command}"
fi
benchmark_status=$?
set -e

ssh "${SSH_OPTS[@]}" "${SSH_USER}@${GENERATOR_HOST}" \
  "cd '${REMOTE_DIR}' && npm run metrics:redis -- after-${BENCHMARK}" || true

ssh "${SSH_OPTS[@]}" "${SSH_USER}@${GENERATOR_HOST}" \
  "cd '${REMOTE_DIR}' && perl -0pi -e 's/\"authenticate\": \"[^\"]+\"/\"authenticate\": \"[redacted]\"/g' memtier-output/*.json 2>/dev/null || true"

mkdir -p "${ROOT_DIR}/memtier-output/aws-load-runner"
if [[ "$QUERY_GENERATOR_MODE" == "distributed" ]]; then
  for metric_phase in before after; do
    rsync -az -e "ssh ${SSH_OPTS[*]}" \
      "${SSH_USER}@${GENERATOR_HOST}:${REMOTE_DIR}/memtier-output/redis-metrics-${metric_phase}-${BENCHMARK}.json" \
      "${ROOT_DIR}/memtier-output/aws-load-runner/" || true
    if [[ -n "$DISTRIBUTED_OUTPUT_DIR" ]]; then
      cp "${ROOT_DIR}/memtier-output/aws-load-runner/redis-metrics-${metric_phase}-${BENCHMARK}.json" \
        "${DISTRIBUTED_OUTPUT_DIR}/" 2>/dev/null || true
    fi
  done
else
  rsync -az -e "ssh ${SSH_OPTS[*]}" \
    "${SSH_USER}@${GENERATOR_HOST}:${REMOTE_DIR}/memtier-output/" \
    "${ROOT_DIR}/memtier-output/aws-load-runner/"
fi

collect_api_artifacts "light" "${LIGHT_API_HOSTS[@]}"
collect_api_artifacts "positions" "${POSITIONS_API_HOSTS[@]}"
collect_api_artifacts "transactions" "${TRANSACTIONS_API_HOSTS[@]}"
collect_api_artifacts "portfolio" "${PORTFOLIO_API_HOSTS[@]}"
collect_api_artifacts "activity" "${ACTIVITY_API_HOSTS[@]}"
collect_api_artifacts "snapshot" "${SNAPSHOT_API_HOSTS[@]}"

echo "Downloaded generator results to memtier-output/aws-load-runner"
echo "API pool workers and Redis connections:"
echo "  light: ${#LIGHT_API_HOSTS[@]} workers, ${LIGHT_API_REDIS_POOL_SIZE} connections/worker, concurrency ${LIGHT_API_MAX_CONCURRENCY}"
echo "  positions: ${#POSITIONS_API_HOSTS[@]} workers, ${POSITIONS_API_REDIS_POOL_SIZE} connections/worker, concurrency ${POSITIONS_API_MAX_CONCURRENCY}"
echo "  transactions: ${#TRANSACTIONS_API_HOSTS[@]} workers, ${TRANSACTIONS_API_REDIS_POOL_SIZE} connections/worker, concurrency ${TRANSACTIONS_API_MAX_CONCURRENCY}"
echo "  portfolio: ${#PORTFOLIO_API_HOSTS[@]} workers, ${PORTFOLIO_API_REDIS_POOL_SIZE} connections/worker, concurrency ${PORTFOLIO_API_MAX_CONCURRENCY}"
echo "  activity: ${#ACTIVITY_API_HOSTS[@]} workers, ${ACTIVITY_API_REDIS_POOL_SIZE} connections/worker, concurrency ${ACTIVITY_API_MAX_CONCURRENCY}"
echo "  snapshot: ${#SNAPSHOT_API_HOSTS[@]} workers, ${SNAPSHOT_API_REDIS_POOL_SIZE} connections/worker, concurrency ${SNAPSHOT_API_MAX_CONCURRENCY}"
echo "API keep-alive timeout: ${API_KEEP_ALIVE_TIMEOUT}ms"
echo "Load-generator hosts: ${#ACTIVE_GENERATOR_HOSTS[@]}"
printf '  %s\n' "${ACTIVE_GENERATOR_HOSTS[@]}"
echo "Load-generator mode: ${QUERY_GENERATOR_MODE}"
echo "Load-generator processes: ${QUERY_GENERATOR_PROCESSES}"
if [[ -n "$DISTRIBUTED_QUERY_GENERATOR_COUNT" ]]; then
  echo "Dedicated query generators: ${DISTRIBUTED_QUERY_GENERATOR_COUNT}"
  echo "Dedicated trade generators: ${DISTRIBUTED_TRADE_GENERATOR_COUNT}"
fi
echo "Load-balanced query API: ${QUERY_BASE_URL}"
if [[ -n "$DISTRIBUTED_OUTPUT_DIR" ]]; then
  if [[ "$BENCHMARK" == "accountById" ]]; then
    echo "Distributed aggregate: ${DISTRIBUTED_OUTPUT_DIR}/query-account-by-id-aggregate.json"
  else
    echo "Distributed artifacts: ${DISTRIBUTED_OUTPUT_DIR}"
  fi
fi

exit "$benchmark_status"
