#!/usr/bin/env bash
set -euo pipefail

mkdir -p memtier-output

echo "seed-load pipeline started at $(date -u +%Y-%m-%dT%H:%M:%SZ)"

npm ci
npm run seed:initial-load
npm run bench:prepare
AWS_LOAD_RUNNER_WEB_PORT="${AWS_LOAD_RUNNER_WEB_PORT:-3000}" npm run bench:aws-web

MEMTIER_THREADS="${MEMTIER_THREADS:-8}" \
MEMTIER_CLIENTS="${MEMTIER_CLIENTS:-100}" \
MEMTIER_PIPELINE="${MEMTIER_PIPELINE:-64}" \
MEMTIER_POSITIONS_RATE_PER_CONNECTION="${MEMTIER_POSITIONS_RATE_PER_CONNECTION:-188}" \
MEMTIER_TRANSACTION_RATE_PER_CONNECTION="${MEMTIER_TRANSACTION_RATE_PER_CONNECTION:-188}" \
MEMTIER_TRADE_RATE_PER_CONNECTION="${MEMTIER_TRADE_RATE_PER_CONNECTION:-38}" \
MEMTIER_TEST_TIME="${MEMTIER_TEST_TIME:-60}" \
npm run bench:concurrent

perl -0pi -e 's/\"authenticate\": \"[^\"]+\"/\"authenticate\": \"[redacted]\"/g' memtier-output/*.json

echo "seed-load pipeline finished at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
