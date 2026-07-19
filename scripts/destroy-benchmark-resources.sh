#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AWS_TF_DIR="${ROOT_DIR}/infra/aws-load-runner"
REDIS_TF_DIR="${ROOT_DIR}/infra/redis-cloud"
AWS_KEY_NAME="${AWS_LOAD_RUNNER_KEY_NAME:-}"
AWS_SSH_CIDR="${AWS_LOAD_RUNNER_SSH_CIDR:-}"
PLAN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lpl-benchmark-destroy.XXXXXX")"
AWS_PLAN="${PLAN_DIR}/aws.tfplan"
REDIS_PLAN="${PLAN_DIR}/redis.tfplan"

cleanup_plans() {
  rm -rf "$PLAN_DIR"
}
trap cleanup_plans EXIT

if [[ -z "$AWS_KEY_NAME" || -z "$AWS_SSH_CIDR" ]]; then
  echo "AWS_LOAD_RUNNER_KEY_NAME and AWS_LOAD_RUNNER_SSH_CIDR are required." >&2
  exit 1
fi

if [[ -n "$(terraform -chdir="$AWS_TF_DIR" state list)" ]]; then
  terraform -chdir="$AWS_TF_DIR" plan -destroy \
    -var="key_name=${AWS_KEY_NAME}" \
    -var="ssh_ingress_cidr_blocks=[\"${AWS_SSH_CIDR}\"]" \
    -out="$AWS_PLAN"
  terraform -chdir="$AWS_TF_DIR" apply "$AWS_PLAN"
fi

if [[ -n "$(terraform -chdir="$REDIS_TF_DIR" state list)" ]]; then
  if [[ -z "${REDISCLOUD_ACCESS_KEY:-}" || -z "${REDISCLOUD_SECRET_KEY:-}" ]]; then
    echo "Redis Cloud state exists, but REDISCLOUD_ACCESS_KEY and REDISCLOUD_SECRET_KEY are unavailable." >&2
    exit 1
  fi
  terraform -chdir="$REDIS_TF_DIR" plan -destroy -out="$REDIS_PLAN"
  terraform -chdir="$REDIS_TF_DIR" apply "$REDIS_PLAN"
fi

if [[ -n "$(terraform -chdir="$AWS_TF_DIR" state list)" ]]; then
  echo "AWS Terraform state is not empty after teardown." >&2
  exit 1
fi
if [[ -n "$(terraform -chdir="$REDIS_TF_DIR" state list)" ]]; then
  echo "Redis Cloud Terraform state is not empty after teardown." >&2
  exit 1
fi

echo "Benchmark Terraform teardown completed with both states empty."
