#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF_DIR="${ROOT_DIR}/infra/aws-load-runner"
REMOTE_DIR="${AWS_LOAD_RUNNER_REMOTE_DIR:-/home/ec2-user/redis-financial-demo}"
SSH_USER="${AWS_LOAD_RUNNER_SSH_USER:-ec2-user}"
SSH_KEY_PATH="${AWS_LOAD_RUNNER_KEY_PATH:-}"
WEB_PORT="${AWS_LOAD_RUNNER_WEB_PORT:-3000}"

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

API_HOST="${AWS_LOAD_RUNNER_API_HOST:-${AWS_LOAD_RUNNER_HOST:-}}"
if [[ -z "$API_HOST" ]]; then
  API_HOST="$(terraform -chdir="$TF_DIR" output -raw api_public_dns)"
fi

GENERATOR_HOST="${AWS_LOAD_RUNNER_GENERATOR_HOST:-}"
if [[ -z "$GENERATOR_HOST" ]]; then
  GENERATOR_HOST="$(terraform -chdir="$TF_DIR" output -raw generator_public_dns)"
fi

API_PRIVATE_IP="${AWS_LOAD_RUNNER_API_PRIVATE_IP:-}"
if [[ -z "$API_PRIVATE_IP" ]]; then
  API_PRIVATE_IP="$(terraform -chdir="$TF_DIR" output -raw api_private_ip)"
fi

if [[ "$API_HOST" == "$GENERATOR_HOST" ]]; then
  echo "The query API and load generator must use different hosts." >&2
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

wait_for_host "query API" "$API_HOST"
wait_for_host "load generator" "$GENERATOR_HOST"
sync_host "query API" "$API_HOST"
sync_host "load generator" "$GENERATOR_HOST"

echo "Starting the query API on ${API_HOST}..."
ssh "${SSH_OPTS[@]}" "${SSH_USER}@${API_HOST}" \
  "cd '${REMOTE_DIR}' && npm ci && AWS_LOAD_RUNNER_WEB_PORT='${WEB_PORT}' npm run bench:aws-web"

echo "Running load generators on ${GENERATOR_HOST} against ${API_PRIVATE_IP}:${WEB_PORT}..."
set +e
ssh "${SSH_OPTS[@]}" "${SSH_USER}@${GENERATOR_HOST}" \
  "cd '${REMOTE_DIR}' && \
   npm ci && \
   QUERY_BASE_URL='http://${API_PRIVATE_IP}:${WEB_PORT}' \
   QUERY_DEFAULT_TARGET_RPS='${QUERY_DEFAULT_TARGET_RPS:-10000}' \
   QUERY_JOIN_TARGET_RPS='${QUERY_JOIN_TARGET_RPS:-50000}' \
   QUERY_TEST_TIME='${QUERY_TEST_TIME:-60}' \
   QUERY_MAX_IN_FLIGHT='${QUERY_MAX_IN_FLIGHT:-2000}' \
   QUERY_SAMPLE_POOL_SIZE='${QUERY_SAMPLE_POOL_SIZE:-1000}' \
   QUERY_RANDOM_SEED='${QUERY_RANDOM_SEED:-20260714}' \
   MEMTIER_TRADE_TARGET_RPS='${MEMTIER_TRADE_TARGET_RPS:-30000}' \
   TRADE_MAX_IN_FLIGHT='${TRADE_MAX_IN_FLIGHT:-10000}' \
   TRADE_SAMPLE_POOL_SIZE='${TRADE_SAMPLE_POOL_SIZE:-1000}' \
   TRADE_RANDOM_SEED='${TRADE_RANDOM_SEED:-20260714}' \
   npm run bench:concurrent"
benchmark_status=$?
set -e

ssh "${SSH_OPTS[@]}" "${SSH_USER}@${GENERATOR_HOST}" \
  "cd '${REMOTE_DIR}' && perl -0pi -e 's/\"authenticate\": \"[^\"]+\"/\"authenticate\": \"[redacted]\"/g' memtier-output/*.json 2>/dev/null || true"

mkdir -p "${ROOT_DIR}/memtier-output/aws-load-runner"
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" \
  "${SSH_USER}@${GENERATOR_HOST}:${REMOTE_DIR}/memtier-output/" \
  "${ROOT_DIR}/memtier-output/aws-load-runner/"
scp "${SSH_OPTS[@]}" \
  "${SSH_USER}@${API_HOST}:${REMOTE_DIR}/memtier-output/web.log" \
  "${ROOT_DIR}/memtier-output/aws-load-runner/web.log" >/dev/null 2>&1 || true

echo "Downloaded generator results to memtier-output/aws-load-runner"
echo "Query API host: ${API_HOST}"
echo "Load-generator host: ${GENERATOR_HOST}"
echo "Web query workbench: http://${API_HOST}:${WEB_PORT}"

exit "$benchmark_status"
