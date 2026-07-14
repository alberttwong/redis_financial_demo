#!/usr/bin/env bash
set -euo pipefail

# A laptop-safe smoke profile. The full 230k request target belongs on the
# production-mode AWS runner near Redis Cloud.
export QUERY_DEFAULT_TARGET_RPS="${QUERY_DEFAULT_TARGET_RPS:-25}"
export QUERY_JOIN_TARGET_RPS="${QUERY_JOIN_TARGET_RPS:-2}"
export QUERY_MAX_IN_FLIGHT="${QUERY_MAX_IN_FLIGHT:-50}"
export QUERY_TEST_TIME="${QUERY_TEST_TIME:-30}"
export MEMTIER_TRADE_TARGET_RPS="${MEMTIER_TRADE_TARGET_RPS:-200}"
export MEMTIER_TRADE_THREADS="${MEMTIER_TRADE_THREADS:-1}"
export MEMTIER_TRADE_CLIENTS="${MEMTIER_TRADE_CLIENTS:-2}"
export MEMTIER_TRADE_PIPELINE="${MEMTIER_TRADE_PIPELINE:-16}"

exec bash scripts/bench-concurrent.sh
