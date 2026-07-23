#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE_PATH="${AWS_LOAD_RUNNER_BUNDLE_PATH:-${ROOT_DIR}/infra/aws-load-runner/api-bundle.tgz}"
BUNDLE_DIR="$(dirname "$BUNDLE_PATH")"

if [[ ! -f "${ROOT_DIR}/.env.local" ]]; then
  echo ".env.local is required before building the API bootstrap bundle." >&2
  exit 1
fi

umask 077
mkdir -p "$BUNDLE_DIR"
temporary_bundle="$(mktemp "${TMPDIR:-/tmp}/lpl-api-bundle.XXXXXX.tgz")"
trap 'rm -f "$temporary_bundle"' EXIT

tar -czf "$temporary_bundle" \
  --exclude './.git' \
  --exclude './.DS_Store' \
  --exclude './.next' \
  --exclude './node_modules' \
  --exclude './docs' \
  --exclude './memtier-output' \
  --exclude './monitor-input' \
  --exclude './output' \
  --exclude './tmp' \
  --exclude './infra/redis-cloud/.terraform' \
  --exclude './infra/redis-cloud/terraform.tfstate*' \
  --exclude './infra/benchmark-backup/.terraform' \
  --exclude './infra/benchmark-backup/terraform.tfstate*' \
  --exclude './infra/benchmark-backup/tfplan*' \
  --exclude './infra/aws-load-runner/.terraform' \
  --exclude './infra/aws-load-runner/terraform.tfstate*' \
  --exclude './infra/aws-load-runner/*.tfplan' \
  --exclude './infra/aws-load-runner/api-bundle.tgz' \
  -C "$ROOT_DIR" .

mv "$temporary_bundle" "$BUNDLE_PATH"
trap - EXIT
chmod 600 "$BUNDLE_PATH"
echo "Built Terraform bootstrap bundle: ${BUNDLE_PATH}"
