#!/usr/bin/env bash
set -euo pipefail

web_port="${AWS_LOAD_RUNNER_WEB_PORT:-3000}"
redis_pool_size="${API_REDIS_POOL_SIZE:-32}"
api_keep_alive_timeout="${API_KEEP_ALIVE_TIMEOUT:-65000}"
api_workload_class="${API_WORKLOAD_CLASS:-mixed}"
api_max_concurrent_light="${API_MAX_CONCURRENT_LIGHT:-128}"
api_max_concurrent_positions="${API_MAX_CONCURRENT_POSITIONS:-32}"
api_max_concurrent_transactions="${API_MAX_CONCURRENT_TRANSACTIONS:-32}"
api_max_concurrent_portfolio="${API_MAX_CONCURRENT_PORTFOLIO:-16}"
api_max_concurrent_activity="${API_MAX_CONCURRENT_ACTIVITY:-16}"
api_max_concurrent_snapshot="${API_MAX_CONCURRENT_SNAPSHOT:-32}"

case "$api_workload_class" in
  mixed|light|positions|transactions|portfolio|activity|snapshot) ;;
  *)
    echo "API_WORKLOAD_CLASS must be mixed, light, positions, transactions, portfolio, activity, or snapshot." >&2
    exit 1
    ;;
esac

for setting in \
  "API_REDIS_POOL_SIZE:${redis_pool_size}" \
  "API_KEEP_ALIVE_TIMEOUT:${api_keep_alive_timeout}" \
  "API_MAX_CONCURRENT_LIGHT:${api_max_concurrent_light}" \
  "API_MAX_CONCURRENT_POSITIONS:${api_max_concurrent_positions}" \
  "API_MAX_CONCURRENT_TRANSACTIONS:${api_max_concurrent_transactions}" \
  "API_MAX_CONCURRENT_PORTFOLIO:${api_max_concurrent_portfolio}" \
  "API_MAX_CONCURRENT_ACTIVITY:${api_max_concurrent_activity}" \
  "API_MAX_CONCURRENT_SNAPSHOT:${api_max_concurrent_snapshot}"; do
  setting_name="${setting%%:*}"
  setting_value="${setting#*:}"
  if [[ ! "$setting_value" =~ ^[0-9]+$ ]] || [[ "$setting_value" -lt 1 ]]; then
    echo "${setting_name} must be a positive integer." >&2
    exit 1
  fi
done

mkdir -p memtier-output

if [[ -f memtier-output/web.pid ]]; then
  old_pid="$(cat memtier-output/web.pid)"
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" >/dev/null 2>&1; then
    kill "$old_pid" >/dev/null 2>&1 || true
  fi
fi

npm run build

API_WORKLOAD_CLASS="$api_workload_class" \
API_MAX_CONCURRENT_LIGHT="$api_max_concurrent_light" \
API_MAX_CONCURRENT_POSITIONS="$api_max_concurrent_positions" \
API_MAX_CONCURRENT_TRANSACTIONS="$api_max_concurrent_transactions" \
API_MAX_CONCURRENT_PORTFOLIO="$api_max_concurrent_portfolio" \
API_MAX_CONCURRENT_ACTIVITY="$api_max_concurrent_activity" \
API_MAX_CONCURRENT_SNAPSHOT="$api_max_concurrent_snapshot" \
REDIS_POOL_SIZE="$redis_pool_size" \
nohup ./node_modules/.bin/next start \
  -H 0.0.0.0 \
  -p "$web_port" \
  --keepAliveTimeout "$api_keep_alive_timeout" \
  >memtier-output/web.log 2>&1 &
echo "$!" >memtier-output/web.pid

for _ in {1..60}; do
  if curl -fsS "http://127.0.0.1:${web_port}/api/health" >/dev/null; then
    echo "Started ${api_workload_class} query API on port ${web_port} with Redis pool size ${redis_pool_size}; pool limits light=${api_max_concurrent_light}, positions=${api_max_concurrent_positions}, transactions=${api_max_concurrent_transactions}, portfolio=${api_max_concurrent_portfolio}, activity=${api_max_concurrent_activity}, snapshot=${api_max_concurrent_snapshot}; keep-alive timeout ${api_keep_alive_timeout}ms"
    exit 0
  fi
  sleep 1
done

tail -n 100 memtier-output/web.log >&2 || true
echo "Web query workbench did not become healthy on port ${web_port}." >&2
exit 1
