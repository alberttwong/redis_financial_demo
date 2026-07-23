#!/usr/bin/env bash
set -euo pipefail

host="${1:?host is required}"
port="${2:-22}"
region="${AWS_REGION:-us-west-2}"

instance_id="$(aws ec2 describe-instances \
  --region "$region" \
  --filters "Name=dns-name,Values=${host}" "Name=instance-state-name,Values=running" \
  --query 'Reservations[0].Instances[0].InstanceId' \
  --output text)"

if [[ -z "$instance_id" || "$instance_id" == "None" ]]; then
  echo "No running EC2 instance found for ${host}." >&2
  exit 1
fi

exec aws ssm start-session \
  --region "$region" \
  --target "$instance_id" \
  --document-name AWS-StartSSHSession \
  --parameters "portNumber=${port}"
