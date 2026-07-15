#!/usr/bin/env bash
set -euo pipefail

web_port="${AWS_LOAD_RUNNER_WEB_PORT:-3000}"
redis_pool_size="${API_REDIS_POOL_SIZE:-16}"

mkdir -p memtier-output

if [[ -f memtier-output/web.pid ]]; then
  old_pid="$(cat memtier-output/web.pid)"
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" >/dev/null 2>&1; then
    kill "$old_pid" >/dev/null 2>&1 || true
  fi
fi

npm run build

REDIS_POOL_SIZE="$redis_pool_size" nohup ./node_modules/.bin/next start -H 0.0.0.0 -p "$web_port" >memtier-output/web.log 2>&1 &
echo "$!" >memtier-output/web.pid

for _ in {1..60}; do
  if curl -fsS "http://127.0.0.1:${web_port}/api/health" >/dev/null; then
    echo "Started web query workbench on port ${web_port} with Redis pool size ${redis_pool_size}"
    exit 0
  fi
  sleep 1
done

tail -n 100 memtier-output/web.log >&2 || true
echo "Web query workbench did not become healthy on port ${web_port}." >&2
exit 1
