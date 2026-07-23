#!/usr/bin/env bash
set -euo pipefail

: "${AWS_LOAD_RUNNER_KEY_PATH:?AWS_LOAD_RUNNER_KEY_PATH is required}"
: "${LPL_REDIS_ROOT_DIR:?LPL_REDIS_ROOT_DIR is required}"

exec ssh \
  -i "$AWS_LOAD_RUNNER_KEY_PATH" \
  -o BatchMode=yes \
  -o ConnectTimeout=60 \
  -o ConnectionAttempts=1 \
  -o StrictHostKeyChecking=accept-new \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o "ProxyCommand=bash '${LPL_REDIS_ROOT_DIR}/scripts/aws-ssm-ssh-proxy.sh' %h %p" \
  "$@"
