#!/usr/bin/env bash
set -euo pipefail

OP_VAULT="${REDISCLOUD_OP_VAULT:-Redis}"
OP_ITEM="${REDISCLOUD_OP_ITEM:-LPL Redis Cloud Terraform}"
OP_TIMEOUT_SECONDS="${REDISCLOUD_OP_TIMEOUT_SECONDS:-15}"

read_1password_field() {
  local field_name="$1"
  local output_file
  local op_pid
  local elapsed=0

  output_file="$(mktemp "${TMPDIR:-/tmp}/rediscloud-op.XXXXXX")"
  op read "op://${OP_VAULT}/${OP_ITEM}/${field_name}" >"${output_file}" 2>/dev/null &
  op_pid="$!"

  while kill -0 "${op_pid}" 2>/dev/null; do
    if (( elapsed >= OP_TIMEOUT_SECONDS )); then
      kill "${op_pid}" 2>/dev/null || true
      wait "${op_pid}" 2>/dev/null || true
      rm -f "${output_file}"
      return 1
    fi

    sleep 1
    elapsed=$((elapsed + 1))
  done

  if wait "${op_pid}"; then
    cat "${output_file}"
    rm -f "${output_file}"
    return 0
  fi

  rm -f "${output_file}"
  return 1
}

if [[ "${REDISCLOUD_USE_1PASSWORD:-1}" != "0" ]] && command -v op >/dev/null 2>&1; then
  access_key="$(read_1password_field "REDISCLOUD_ACCESS_KEY" || true)"
  secret_key="$(read_1password_field "REDISCLOUD_SECRET_KEY" || true)"

  if [[ -n "${access_key}" && -n "${secret_key}" ]]; then
    export REDISCLOUD_ACCESS_KEY="${access_key}"
    export REDISCLOUD_SECRET_KEY="${secret_key}"
  fi
fi

if [[ -z "${REDISCLOUD_ACCESS_KEY:-}" || -z "${REDISCLOUD_SECRET_KEY:-}" ]]; then
  cat >&2 <<EOF
Redis Cloud credentials are not available.

Add them to 1Password:
  op://$OP_VAULT/$OP_ITEM/REDISCLOUD_ACCESS_KEY
  op://$OP_VAULT/$OP_ITEM/REDISCLOUD_SECRET_KEY

Or export them before running Terraform:
  export REDISCLOUD_ACCESS_KEY=...
  export REDISCLOUD_SECRET_KEY=...
EOF
  exit 1
fi

exec terraform "$@"
