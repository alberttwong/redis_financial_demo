#!/usr/bin/env bash
set -euo pipefail

# A laptop-safe smoke profile. The full 230k request target belongs on the
# production-mode AWS runner near Redis Cloud.
export QUERY_DEFAULT_TARGET_RPS="${QUERY_DEFAULT_TARGET_RPS:-25}"
export QUERY_JOIN_TARGET_RPS="${QUERY_JOIN_TARGET_RPS:-2}"
export QUERY_MAX_IN_FLIGHT="${QUERY_MAX_IN_FLIGHT:-50}"
export QUERY_TEST_TIME="${QUERY_TEST_TIME:-30}"
export QUERY_SAMPLE_POOL_SIZE="${QUERY_SAMPLE_POOL_SIZE:-50}"
export MEMTIER_TRADE_TARGET_RPS="${MEMTIER_TRADE_TARGET_RPS:-200}"
export TRADE_MAX_IN_FLIGHT="${TRADE_MAX_IN_FLIGHT:-100}"
export TRADE_SAMPLE_POOL_SIZE="${TRADE_SAMPLE_POOL_SIZE:-50}"

exec bash scripts/bench-concurrent.sh
