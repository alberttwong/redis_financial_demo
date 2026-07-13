#!/usr/bin/env bash
set -euo pipefail

mkdir -p memtier-output

echo "seed-load pipeline started at $(date -u +%Y-%m-%dT%H:%M:%SZ)"

npm ci
npm run seed:initial-load
AWS_LOAD_RUNNER_WEB_PORT="${AWS_LOAD_RUNNER_WEB_PORT:-3000}" npm run bench:aws-web

QUERY_BASE_URL="${QUERY_BASE_URL:-http://127.0.0.1:${AWS_LOAD_RUNNER_WEB_PORT:-3000}}" \
QUERY_DEFAULT_TARGET_RPS="${QUERY_DEFAULT_TARGET_RPS:-10000}" \
QUERY_JOIN_TARGET_RPS="${QUERY_JOIN_TARGET_RPS:-50000}" \
QUERY_TEST_TIME="${QUERY_TEST_TIME:-60}" \
MEMTIER_TRADE_TARGET_RPS="${MEMTIER_TRADE_TARGET_RPS:-30000}" \
npm run bench:concurrent

perl -0pi -e 's/\"authenticate\": \"[^\"]+\"/\"authenticate\": \"[redacted]\"/g' memtier-output/*.json

echo "seed-load pipeline finished at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
