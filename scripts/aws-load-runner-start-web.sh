#!/usr/bin/env bash
set -euo pipefail

web_port="${AWS_LOAD_RUNNER_WEB_PORT:-3000}"

mkdir -p memtier-output

if [[ -f memtier-output/web.pid ]]; then
  old_pid="$(cat memtier-output/web.pid)"
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" >/dev/null 2>&1; then
    kill "$old_pid" >/dev/null 2>&1 || true
  fi
fi

npm run build

nohup npm run start -- -H 0.0.0.0 -p "$web_port" >memtier-output/web.log 2>&1 &
echo "$!" >memtier-output/web.pid

echo "Started web query workbench on port ${web_port}"
