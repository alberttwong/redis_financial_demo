#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACTION="${1:-}"
TTL_SECONDS="${BENCHMARK_TTL_SECONDS:-14400}"
PID_FILE="${BENCHMARK_WATCHDOG_PID_FILE:-${TMPDIR:-/tmp}/lpl-benchmark-watchdog.pid}"
LOG_FILE="${BENCHMARK_WATCHDOG_LOG_FILE:-${TMPDIR:-/tmp}/lpl-benchmark-watchdog.log}"

case "$ACTION" in
  arm)
    if [[ ! "$TTL_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
      echo "BENCHMARK_TTL_SECONDS must be a positive integer." >&2
      exit 1
    fi
    if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "A benchmark teardown watchdog is already armed at PID $(cat "$PID_FILE")." >&2
      exit 1
    fi
    umask 077
    : >"$LOG_FILE"
    nohup "$0" run >>"$LOG_FILE" 2>&1 </dev/null &
    watchdog_pid=$!
    echo "$watchdog_pid" >"$PID_FILE"
    echo "Armed benchmark teardown watchdog PID ${watchdog_pid} for ${TTL_SECONDS} seconds."
    ;;
  disarm)
    if [[ -f "$PID_FILE" ]]; then
      watchdog_pid="$(cat "$PID_FILE")"
      if kill -0 "$watchdog_pid" 2>/dev/null; then
        kill "$watchdog_pid"
      fi
      rm -f "$PID_FILE"
    fi
    echo "Benchmark teardown watchdog disarmed."
    ;;
  run)
    remaining="$TTL_SECONDS"
    while (( remaining > 0 )); do
      interval=60
      if (( remaining < interval )); then interval="$remaining"; fi
      sleep "$interval"
      remaining=$((remaining - interval))
    done
    echo "Benchmark TTL expired; starting provider teardown."
    "${ROOT_DIR}/scripts/destroy-benchmark-resources.sh"
    rm -f "$PID_FILE"
    ;;
  *)
    echo "Usage: $0 arm|disarm|run" >&2
    exit 1
    ;;
esac
