#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_DIR="${AWS_LOAD_RUNNER_REMOTE_DIR:-/home/ec2-user/redis-financial-demo}"
SSH_USER="${AWS_LOAD_RUNNER_SSH_USER:-ec2-user}"
SSH_KEY_PATH="${AWS_LOAD_RUNNER_KEY_PATH:-}"
OUTPUT_DIR="${AWS_SEED_OUTPUT_DIR:-${ROOT_DIR}/memtier-output/distributed-seed-$(date -u +%Y%m%dT%H%M%SZ)}"
RESET_CHECKPOINTS="${AWS_SEED_RESET_CHECKPOINTS:-0}"

if [[ -z "$SSH_KEY_PATH" || ! -f "$SSH_KEY_PATH" ]]; then
  echo "AWS_LOAD_RUNNER_KEY_PATH must name an existing SSH key." >&2
  exit 1
fi

hosts=("$@")
if [[ "${#hosts[@]}" -eq 0 && -n "${AWS_SEED_WORKER_HOSTS:-}" ]]; then
  IFS=',' read -r -a hosts <<<"${AWS_SEED_WORKER_HOSTS}"
fi
if [[ "${#hosts[@]}" -eq 0 ]]; then
  echo "Pass one or more seed worker host names, or set AWS_SEED_WORKER_HOSTS." >&2
  exit 1
fi

partition_count="${AWS_SEED_PARTITIONS:-${#hosts[@]}}"
if [[ ! "$partition_count" =~ ^[0-9]+$ ]] || (( partition_count < 1 || partition_count > ${#hosts[@]} )); then
  echo "AWS_SEED_PARTITIONS must be between 1 and the ${#hosts[@]} supplied hosts." >&2
  exit 1
fi
if [[ "$RESET_CHECKPOINTS" != "0" && "$RESET_CHECKPOINTS" != "1" ]]; then
  echo "AWS_SEED_RESET_CHECKPOINTS must be 0 or 1." >&2
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
if [[ "${AWS_LOAD_RUNNER_USE_SSM_SSH:-0}" == "1" ]]; then
  SSH_OPTS+=(
    -o ConnectTimeout=60
    -o "ProxyCommand=bash '${ROOT_DIR}/scripts/aws-ssm-ssh-proxy.sh' %h %p"
  )
fi

mkdir -p "$OUTPUT_DIR"
coordinator="${hosts[0]}"

run_phase() {
  local phase="$1"
  local log_file="${OUTPUT_DIR}/${phase}.log"
  echo "Running distributed seed ${phase} on ${coordinator}; log: ${log_file}"
  ssh "${SSH_OPTS[@]}" "${SSH_USER}@${coordinator}" \
    "cd '${REMOTE_DIR}' && SEED_PARTITION_COUNT='${partition_count}' SEED_PARTITION_INDEX=0 npm run 'seed:${phase}'" \
    >"$log_file" 2>&1
}

if [[ "$RESET_CHECKPOINTS" == "1" ]]; then
  run_phase clear-checkpoints
fi
run_phase prepare

echo "Seeding ${partition_count} deterministic account partitions in parallel..."
pids=()
for (( index=0; index<partition_count; index+=1 )); do
  host="${hosts[$index]}"
  log_file="${OUTPUT_DIR}/partition-$(printf '%02d' "$index").log"
  ssh "${SSH_OPTS[@]}" "${SSH_USER}@${host}" \
    "cd '${REMOTE_DIR}' && SEED_PARTITION_COUNT='${partition_count}' SEED_PARTITION_INDEX='${index}' npm run seed:partition" \
    >"$log_file" 2>&1 &
  pids+=("$!")
  echo "  partition ${index}: ${host} -> ${log_file}"
done

status=0
for index in "${!pids[@]}"; do
  if ! wait "${pids[$index]}"; then
    echo "Partition ${index} failed; its Redis checkpoint was retained for resume." >&2
    tail -n 50 "${OUTPUT_DIR}/partition-$(printf '%02d' "$index").log" >&2 || true
    status=1
  fi
done
if [[ "$status" -ne 0 ]]; then
  exit "$status"
fi

run_phase finalize
echo "Distributed seed complete. Logs: ${OUTPUT_DIR}"
