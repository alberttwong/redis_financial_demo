#!/usr/bin/env bash

if [[ -f .env.local ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.local
  set +a
fi

if [[ -f .env.initial-load ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.initial-load
  set +a
fi

if [[ -n "${REDIS_URL:-}" ]]; then
  {
    IFS= read -r REDIS_HOST
    IFS= read -r REDIS_PORT
    IFS= read -r REDIS_PASSWORD
    IFS= read -r REDIS_TLS
  } < <(node -e 'const url = new URL(process.env.REDIS_URL); console.log(url.hostname); console.log(url.port); console.log(decodeURIComponent(url.password)); console.log(url.protocol === "rediss:" ? "true" : "false");')
  export REDIS_HOST
  export REDIS_PORT
  export REDIS_PASSWORD
  export REDIS_TLS
fi

if ! command -v memtier_benchmark >/dev/null 2>&1; then
  cat >&2 <<EOF
memtier_benchmark is required for bench:trade-writes.

Install it on macOS with:
  brew install memtier_benchmark
EOF
  exit 1
fi
