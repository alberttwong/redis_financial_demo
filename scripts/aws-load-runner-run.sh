#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF_DIR="${ROOT_DIR}/infra/aws-load-runner"
REMOTE_DIR="${AWS_LOAD_RUNNER_REMOTE_DIR:-/home/ec2-user/redis-financial-demo}"
SSH_USER="${AWS_LOAD_RUNNER_SSH_USER:-ec2-user}"
SSH_KEY_PATH="${AWS_LOAD_RUNNER_KEY_PATH:-}"
WEB_PORT="${AWS_LOAD_RUNNER_WEB_PORT:-3000}"
BENCHMARK="${AWS_LOAD_RUNNER_BENCHMARK:-concurrent}"
API_REDIS_POOL_SIZE="${API_REDIS_POOL_SIZE:-16}"
QUERY_GENERATOR_PROCESSES="${QUERY_GENERATOR_PROCESSES:-1}"
AWS_REGION="${AWS_REGION:-us-west-2}"

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

API_HOSTS=()
if [[ -n "${AWS_LOAD_RUNNER_API_HOSTS:-}" ]]; then
  IFS=',' read -r -a API_HOSTS <<<"${AWS_LOAD_RUNNER_API_HOSTS}"
elif [[ -n "${AWS_LOAD_RUNNER_API_HOST:-${AWS_LOAD_RUNNER_HOST:-}}" ]]; then
  API_HOSTS+=("${AWS_LOAD_RUNNER_API_HOST:-${AWS_LOAD_RUNNER_HOST}}")
else
  while IFS= read -r host; do
    API_HOSTS+=("$host")
  done < <(terraform -chdir="$TF_DIR" output -json api_public_dns_names | jq -r '.[]')
fi

GENERATOR_HOST="${AWS_LOAD_RUNNER_GENERATOR_HOST:-}"
if [[ -z "$GENERATOR_HOST" ]]; then
  GENERATOR_HOST="$(terraform -chdir="$TF_DIR" output -raw generator_public_dns)"
fi

QUERY_BASE_URL="${QUERY_BASE_URL:-}"
if [[ -z "$QUERY_BASE_URL" ]]; then
  QUERY_BASE_URL="$(terraform -chdir="$TF_DIR" output -raw generator_query_url)"
fi

API_TARGET_GROUP_ARN="${AWS_LOAD_RUNNER_TARGET_GROUP_ARN:-}"
if [[ -z "$API_TARGET_GROUP_ARN" ]]; then
  API_TARGET_GROUP_ARN="$(terraform -chdir="$TF_DIR" output -raw api_target_group_arn)"
fi

for api_host in "${API_HOSTS[@]}"; do
  if [[ "$api_host" == "$GENERATOR_HOST" ]]; then
    echo "The query API and load generator must use different hosts." >&2
    exit 1
  fi
done

if [[ "${#API_HOSTS[@]}" -lt 2 ]]; then
  echo "The horizontal API experiment requires at least two API hosts." >&2
  exit 1
fi

SSH_OPTS=(
  -i "$SSH_KEY_PATH"
  -o StrictHostKeyChecking=accept-new
  -o ServerAliveInterval=30
)

wait_for_host() {
  local role="$1"
  local host="$2"
  echo "Waiting for ${role} bootstrap on ${host}..."
  until ssh "${SSH_OPTS[@]}" "${SSH_USER}@${host}" 'test -f /opt/lpl-load-runner-ready'; do
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
    -e "ssh ${SSH_OPTS[*]}" \
    "${ROOT_DIR}/" "${SSH_USER}@${host}:${REMOTE_DIR}/"

  scp "${SSH_OPTS[@]}" "${ROOT_DIR}/.env.local" "${SSH_USER}@${host}:${REMOTE_DIR}/.env.local"
  ssh "${SSH_OPTS[@]}" "${SSH_USER}@${host}" "chmod 600 '${REMOTE_DIR}/.env.local'"
}

wait_for_load_balancer() {
  local expected_targets="${#API_HOSTS[@]}"
  local healthy_targets=0
  local total_targets=0
  local states

  echo "Waiting for all ${expected_targets} API workers to become healthy behind the load balancer..."
  for _ in {1..60}; do
    states="$(aws elbv2 describe-target-health \
      --region "$AWS_REGION" \
      --target-group-arn "$API_TARGET_GROUP_ARN" \
      --query 'TargetHealthDescriptions[].TargetHealth.State' \
      --output text)"
    healthy_targets="$(printf '%s\n' "$states" | tr '\t' '\n' | awk '$1 == "healthy" { count++ } END { print count + 0 }')"
    total_targets="$(printf '%s\n' "$states" | tr '\t' '\n' | awk 'NF && $1 != "None" { count++ } END { print count + 0 }')"
    if [[ "$healthy_targets" -eq "$expected_targets" && "$total_targets" -eq "$expected_targets" ]]; then
      echo "All ${healthy_targets}/${total_targets} API workers are healthy."
      return 0
    fi
    sleep 5
  done

  echo "Only ${healthy_targets}/${total_targets} API workers became healthy." >&2
  return 1
}

wait_for_host "load generator" "$GENERATOR_HOST"
sync_host "load generator" "$GENERATOR_HOST"

for index in "${!API_HOSTS[@]}"; do
  api_host="${API_HOSTS[$index]}"
  worker_number=$((index + 1))
  wait_for_host "query API worker ${worker_number}/${#API_HOSTS[@]}" "$api_host"
  sync_host "query API worker ${worker_number}/${#API_HOSTS[@]}" "$api_host"
  echo "Starting query API worker ${worker_number}/${#API_HOSTS[@]} on ${api_host}..."
  ssh "${SSH_OPTS[@]}" "${SSH_USER}@${api_host}" \
    "cd '${REMOTE_DIR}' && npm ci && API_REDIS_POOL_SIZE='${API_REDIS_POOL_SIZE}' AWS_LOAD_RUNNER_WEB_PORT='${WEB_PORT}' npm run bench:aws-web"
done

wait_for_load_balancer

echo "Waiting for the load-balanced API at ${QUERY_BASE_URL}..."
until ssh "${SSH_OPTS[@]}" "${SSH_USER}@${GENERATOR_HOST}" "curl -fsS '${QUERY_BASE_URL}/api/health' >/dev/null"; do
  sleep 5
done

ssh "${SSH_OPTS[@]}" "${SSH_USER}@${GENERATOR_HOST}" \
  "cd '${REMOTE_DIR}' && npm ci && npm run metrics:redis -- before-${BENCHMARK}"

case "$BENCHMARK" in
  accountById)
    if [[ ! "$QUERY_GENERATOR_PROCESSES" =~ ^[0-9]+$ ]] || [[ "$QUERY_GENERATOR_PROCESSES" -lt 1 ]]; then
      echo "QUERY_GENERATOR_PROCESSES must be a positive integer." >&2
      exit 1
    fi
    if [[ "$QUERY_GENERATOR_PROCESSES" -gt 1 ]]; then
      benchmark_command="npm run bench:query:account-by-id:sharded"
    else
      benchmark_command="npm run bench:query:account-by-id"
    fi
    default_max_in_flight=10000
    ;;
  concurrent)
    benchmark_command="npm run bench:concurrent"
    default_max_in_flight=2000
    ;;
  *)
    echo "AWS_LOAD_RUNNER_BENCHMARK must be accountById or concurrent." >&2
    exit 1
    ;;
esac

echo "Running ${BENCHMARK} load on ${GENERATOR_HOST} against ${QUERY_BASE_URL}..."
set +e
ssh "${SSH_OPTS[@]}" "${SSH_USER}@${GENERATOR_HOST}" \
  "cd '${REMOTE_DIR}' && \
   QUERY_BASE_URL='${QUERY_BASE_URL}' \
   QUERY_DEFAULT_TARGET_RPS='${QUERY_DEFAULT_TARGET_RPS:-10000}' \
   QUERY_JOIN_TARGET_RPS='${QUERY_JOIN_TARGET_RPS:-50000}' \
   QUERY_TEST_TIME='${QUERY_TEST_TIME:-60}' \
   QUERY_MAX_IN_FLIGHT='${QUERY_MAX_IN_FLIGHT:-$default_max_in_flight}' \
   QUERY_MAX_SOCKETS='${QUERY_MAX_SOCKETS:-10000}' \
   QUERY_MAX_FREE_SOCKETS='${QUERY_MAX_FREE_SOCKETS:-512}' \
   QUERY_SAMPLE_POOL_SIZE='${QUERY_SAMPLE_POOL_SIZE:-1000}' \
   QUERY_RANDOM_SEED='${QUERY_RANDOM_SEED:-20260714}' \
   QUERY_GENERATOR_PROCESSES='${QUERY_GENERATOR_PROCESSES}' \
   QUERY_SHARD_START_DELAY_SECONDS='${QUERY_SHARD_START_DELAY_SECONDS:-10}' \
   QUERY_RUN_ID='${QUERY_RUN_ID:-}' \
   MEMTIER_TRADE_TARGET_RPS='${MEMTIER_TRADE_TARGET_RPS:-30000}' \
   TRADE_MAX_IN_FLIGHT='${TRADE_MAX_IN_FLIGHT:-10000}' \
   TRADE_SAMPLE_POOL_SIZE='${TRADE_SAMPLE_POOL_SIZE:-1000}' \
   TRADE_RANDOM_SEED='${TRADE_RANDOM_SEED:-20260714}' \
   ${benchmark_command}"
benchmark_status=$?
set -e

ssh "${SSH_OPTS[@]}" "${SSH_USER}@${GENERATOR_HOST}" \
  "cd '${REMOTE_DIR}' && npm run metrics:redis -- after-${BENCHMARK}" || true

ssh "${SSH_OPTS[@]}" "${SSH_USER}@${GENERATOR_HOST}" \
  "cd '${REMOTE_DIR}' && perl -0pi -e 's/\"authenticate\": \"[^\"]+\"/\"authenticate\": \"[redacted]\"/g' memtier-output/*.json 2>/dev/null || true"

mkdir -p "${ROOT_DIR}/memtier-output/aws-load-runner"
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" \
  "${SSH_USER}@${GENERATOR_HOST}:${REMOTE_DIR}/memtier-output/" \
  "${ROOT_DIR}/memtier-output/aws-load-runner/"

for index in "${!API_HOSTS[@]}"; do
  api_host="${API_HOSTS[$index]}"
  worker_number="$(printf '%02d' "$((index + 1))")"
  ssh "${SSH_OPTS[@]}" "${SSH_USER}@${api_host}" \
    "curl -fsS 'http://127.0.0.1:${WEB_PORT}/api/health'" \
    >"${ROOT_DIR}/memtier-output/aws-load-runner/api-health-${worker_number}.json" || true
  scp "${SSH_OPTS[@]}" \
    "${SSH_USER}@${api_host}:${REMOTE_DIR}/memtier-output/web.log" \
    "${ROOT_DIR}/memtier-output/aws-load-runner/web-${worker_number}.log" >/dev/null 2>&1 || true
done

echo "Downloaded generator results to memtier-output/aws-load-runner"
echo "Query API workers: ${#API_HOSTS[@]}"
echo "Redis connections per API worker: ${API_REDIS_POOL_SIZE}"
echo "Load-generator host: ${GENERATOR_HOST}"
echo "Load-generator processes: ${QUERY_GENERATOR_PROCESSES}"
echo "Load-balanced query API: ${QUERY_BASE_URL}"

exit "$benchmark_status"
