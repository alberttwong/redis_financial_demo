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
  echo ".env.local is required so the runner can connect to Redis Cloud." >&2
  exit 1
fi

if [[ ! -d "$TF_DIR" ]]; then
  echo "Missing ${TF_DIR}. Provision infra/aws-load-runner first." >&2
  exit 1
fi

HOST="${AWS_LOAD_RUNNER_HOST:-}"
if [[ -z "$HOST" ]]; then
  HOST="$(terraform -chdir="$TF_DIR" output -raw public_dns)"
fi

SSH_OPTS=(
  -i "$SSH_KEY_PATH"
  -o StrictHostKeyChecking=accept-new
  -o ServerAliveInterval=30
)

echo "Waiting for load runner bootstrap on ${HOST}..."
until ssh "${SSH_OPTS[@]}" "${SSH_USER}@${HOST}" 'test -f /opt/lpl-load-runner-ready'; do
  sleep 15
done

echo "Syncing repository to ${HOST}:${REMOTE_DIR}..."
ssh "${SSH_OPTS[@]}" "${SSH_USER}@${HOST}" "mkdir -p '${REMOTE_DIR}'"
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
  "${ROOT_DIR}/" "${SSH_USER}@${HOST}:${REMOTE_DIR}/"

scp "${SSH_OPTS[@]}" "${ROOT_DIR}/.env.local" "${SSH_USER}@${HOST}:${REMOTE_DIR}/.env.local"

echo "Running benchmark on ${HOST}..."
ssh "${SSH_OPTS[@]}" "${SSH_USER}@${HOST}" \
  "cd '${REMOTE_DIR}' && \
   npm ci && \
   MEMTIER_THREADS='${MEMTIER_THREADS:-8}' \
   MEMTIER_CLIENTS='${MEMTIER_CLIENTS:-100}' \
   MEMTIER_PIPELINE='${MEMTIER_PIPELINE:-64}' \
   MEMTIER_TRANSACTION_RATE_PER_CONNECTION='${MEMTIER_TRANSACTION_RATE_PER_CONNECTION:-188}' \
   MEMTIER_TRADE_RATE_PER_CONNECTION='${MEMTIER_TRADE_RATE_PER_CONNECTION:-38}' \
   MEMTIER_TEST_TIME='${MEMTIER_TEST_TIME:-60}' \
   npm run bench:prepare && \
   AWS_LOAD_RUNNER_WEB_PORT='${WEB_PORT}' npm run bench:aws-web && \
   MEMTIER_THREADS='${MEMTIER_THREADS:-8}' \
   MEMTIER_CLIENTS='${MEMTIER_CLIENTS:-100}' \
   MEMTIER_PIPELINE='${MEMTIER_PIPELINE:-64}' \
   MEMTIER_TRANSACTION_RATE_PER_CONNECTION='${MEMTIER_TRANSACTION_RATE_PER_CONNECTION:-188}' \
   MEMTIER_TRADE_RATE_PER_CONNECTION='${MEMTIER_TRADE_RATE_PER_CONNECTION:-38}' \
   MEMTIER_TEST_TIME='${MEMTIER_TEST_TIME:-60}' \
   npm run bench:concurrent && \
   perl -0pi -e 's/\"authenticate\": \"[^\"]+\"/\"authenticate\": \"[redacted]\"/g' memtier-output/*.json"

mkdir -p "${ROOT_DIR}/memtier-output/aws-load-runner"
rsync -az -e "ssh ${SSH_OPTS[*]}" \
  "${SSH_USER}@${HOST}:${REMOTE_DIR}/memtier-output/" \
  "${ROOT_DIR}/memtier-output/aws-load-runner/"

echo "Downloaded results to memtier-output/aws-load-runner"
echo "Web query workbench: http://${HOST}:${WEB_PORT}"
