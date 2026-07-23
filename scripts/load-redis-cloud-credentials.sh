#!/usr/bin/env bash

OP_VAULT="${REDISCLOUD_OP_VAULT:-Redis}"
OP_ITEM="${REDISCLOUD_OP_ITEM:-LPL Redis Cloud Terraform}"
OP_TIMEOUT_SECONDS="${REDISCLOUD_OP_TIMEOUT_SECONDS:-15}"

read_rediscloud_1password_field() {
  local field_name="$1"
  local output_file op_pid elapsed=0

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
    command cat "${output_file}"
    rm -f "${output_file}"
    return 0
  fi
  rm -f "${output_file}"
  return 1
}

if [[ "${REDISCLOUD_USE_1PASSWORD:-1}" != "0" ]] && command -v op >/dev/null 2>&1; then
  rediscloud_access_key="$(read_rediscloud_1password_field REDISCLOUD_ACCESS_KEY || true)"
  rediscloud_secret_key="$(read_rediscloud_1password_field REDISCLOUD_SECRET_KEY || true)"
  if [[ -n "$rediscloud_access_key" && -n "$rediscloud_secret_key" ]]; then
    export REDISCLOUD_ACCESS_KEY="$rediscloud_access_key"
    export REDISCLOUD_SECRET_KEY="$rediscloud_secret_key"
  fi
  unset rediscloud_access_key rediscloud_secret_key
fi

if [[ -z "${REDISCLOUD_ACCESS_KEY:-}" || -z "${REDISCLOUD_SECRET_KEY:-}" ]]; then
  cat >&2 <<EOF
Redis Cloud credentials are not available.

Add REDISCLOUD_ACCESS_KEY and REDISCLOUD_SECRET_KEY to:
  op://$OP_VAULT/$OP_ITEM

Or export both variables before running this command.
EOF
  return 1 2>/dev/null || exit 1
fi
