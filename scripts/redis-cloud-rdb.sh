#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REDIS_TF_DIR="${ROOT_DIR}/infra/redis-cloud"
BACKUP_TF_DIR="${ROOT_DIR}/infra/benchmark-backup"
AWS_REGION="${AWS_REGION:-us-west-2}"
API_BASE="${REDISCLOUD_API_BASE:-https://api.redislabs.com/v1}"
POLL_SECONDS="${REDIS_BACKUP_POLL_SECONDS:-30}"
TIMEOUT_SECONDS="${REDIS_BACKUP_TIMEOUT_SECONDS:-21600}"

REDISCLOUD_CREDS_LOADED=0

terraform_output() {
  local directory="$1" name="$2"
  terraform -chdir="$directory" output -raw "$name" 2>/dev/null || true
}

SUBSCRIPTION_ID="${REDISCLOUD_SUBSCRIPTION_ID:-$(terraform_output "$REDIS_TF_DIR" rediscloud_subscription_id)}"
DATABASE_ID="${REDISCLOUD_DATABASE_ID:-$(terraform_output "$REDIS_TF_DIR" rediscloud_database_id)}"
BACKUP_BUCKET="${REDIS_BACKUP_BUCKET:-$(terraform_output "$BACKUP_TF_DIR" bucket_name)}"
BACKUP_PREFIX="${REDIS_BACKUP_PREFIX:-$(terraform_output "$BACKUP_TF_DIR" backup_prefix)}"
BACKUP_PREFIX="${BACKUP_PREFIX:-redis-cloud}"
LATEST_KEY="${BACKUP_PREFIX%/}/latest.json"

require_bucket() {
  if [[ -z "$BACKUP_BUCKET" ]]; then
    echo "Apply infra/benchmark-backup or set REDIS_BACKUP_BUCKET." >&2
    exit 1
  fi
}

require_context() {
  require_bucket
  if [[ -z "$SUBSCRIPTION_ID" || -z "$DATABASE_ID" ]]; then
    cat >&2 <<EOF
Redis Cloud subscription/database IDs and the backup bucket are required.
Apply infra/redis-cloud and infra/benchmark-backup, or set:
  REDISCLOUD_SUBSCRIPTION_ID, REDISCLOUD_DATABASE_ID, REDIS_BACKUP_BUCKET
EOF
    exit 1
  fi
}

api() {
  local method="$1" path="$2" body="${3:-}"
  local -a args
  if [[ "$REDISCLOUD_CREDS_LOADED" == "0" ]]; then
    # shellcheck source=load-redis-cloud-credentials.sh
    . "${ROOT_DIR}/scripts/load-redis-cloud-credentials.sh"
    REDISCLOUD_CREDS_LOADED=1
  fi
  args=(
    --silent --show-error --fail-with-body
    --request "$method"
    --header "x-api-key: ${REDISCLOUD_ACCESS_KEY}"
    --header "x-api-secret-key: ${REDISCLOUD_SECRET_KEY}"
    --header "Content-Type: application/json"
  )
  if [[ -n "$body" ]]; then
    args+=(--data "$body")
  fi
  curl "${args[@]}" "${API_BASE}${path}"
}

task_id() {
  jq -r '.taskId // .response.taskId // empty' <<<"$1"
}

poll_task() {
  local id="$1" label="$2" deadline=$((SECONDS + TIMEOUT_SECONDS)) response status
  while true; do
    response="$(api GET "/tasks/${id}")"
    status="$(jq -r '(.status // .response.status // "unknown") | ascii_downcase' <<<"$response")"
    case "$status" in
      processing-completed|completed|complete|succeeded|success|done)
        echo "${label}: ${status}" >&2
        return 0
        ;;
      processing-error|failed|failure|error|cancelled|canceled)
        echo "${label} failed: ${response}" >&2
        return 1
        ;;
      *)
        echo "${label}: ${status}" >&2
        ;;
    esac
    if (( SECONDS >= deadline )); then
      echo "Timed out after ${TIMEOUT_SECONDS}s waiting for ${label}." >&2
      return 1
    fi
    sleep "$POLL_SECONDS"
  done
}

list_backup_objects() {
  aws s3api list-objects-v2 \
    --region "$AWS_REGION" \
    --bucket "$BACKUP_BUCKET" \
    --output json \
    --query 'Contents[?Size>`0`].[Key,Size]' |
    jq --arg bucket "$BACKUP_BUCKET" '[(. // [])[] | {uri: ("s3://" + $bucket + "/" + .[0]), size_bytes: .[1]} | select(.uri | test("\\.rdb(\\.gz)?$"))]'
}

wait_for_backup_objects() {
  local before="$1" deadline=$((SECONDS + TIMEOUT_SECONDS)) current objects
  while true; do
    current="$(list_backup_objects)"
    objects="$(jq --argjson before "$before" \
      '[.[] | select(.uri as $uri | (($before | map(.uri) | index($uri)) == null))]' \
      <<<"$current")"
    if [[ "$(jq length <<<"$objects")" -gt 0 ]]; then
      printf '%s\n' "$objects"
      return 0
    fi
    if (( SECONDS >= deadline )); then
      echo "Redis Cloud completed the backup, but no new RDB objects appeared in ${BACKUP_BUCKET}." >&2
      return 1
    fi
    sleep "$POLL_SECONDS"
  done
}

has_backup() {
  require_bucket
  if aws s3api head-object \
    --region "$AWS_REGION" \
    --bucket "$BACKUP_BUCKET" \
    --key "$LATEST_KEY" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

backup() {
  require_context
  local run_id run_prefix destination body response id before objects manifest latest manifest_key temp_dir
  run_id="$(date -u +%Y%m%dT%H%M%SZ)"
  run_prefix="${BACKUP_PREFIX%/}/runs/${run_id}/"
  # Redis Cloud validates an AWS backup destination at the bucket boundary.
  # Keep run manifests under BACKUP_PREFIX, but let Redis Cloud name the shard
  # RDB objects at the bucket root and identify this run by an object diff.
  destination="s3://${BACKUP_BUCKET}"
  before="$(list_backup_objects)"
  body="$(jq -cn --arg path "$destination" '{adhocBackupPath: $path}')"
  echo "Starting Redis Cloud backup to ${destination}" >&2
  response="$(api POST "/subscriptions/${SUBSCRIPTION_ID}/databases/${DATABASE_ID}/backup" "$body")"
  id="$(task_id "$response")"
  if [[ -z "$id" ]]; then
    echo "Redis Cloud backup did not return a taskId: ${response}" >&2
    return 1
  fi
  echo "Redis Cloud backup task: ${id}" >&2
  poll_task "$id" "Redis Cloud backup"
  objects="$(wait_for_backup_objects "$before")"

  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/redis-rdb-manifest.XXXXXX")"
  trap 'rm -rf "$temp_dir"' RETURN
  manifest="${temp_dir}/manifest.json"
  latest="${temp_dir}/latest.json"
  manifest_key="${run_prefix}manifest.json"
  jq -n \
    --arg created_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg subscription_id "$SUBSCRIPTION_ID" \
    --arg database_id "$DATABASE_ID" \
    --arg manifest_uri "s3://${BACKUP_BUCKET}/${manifest_key}" \
    --argjson objects "$objects" \
    '{schema_version: 1, created_at: $created_at, subscription_id: $subscription_id, database_id: $database_id, manifest_uri: $manifest_uri, objects: $objects, source_uris: [$objects[].uri]}' \
    >"$manifest"
  aws s3 cp "$manifest" "s3://${BACKUP_BUCKET}/${manifest_key}" --region "$AWS_REGION" --sse AES256 >/dev/null
  jq -n \
    --arg updated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg manifest_uri "s3://${BACKUP_BUCKET}/${manifest_key}" \
    --slurpfile manifest "$manifest" \
    '{schema_version: 1, updated_at: $updated_at, manifest_uri: $manifest_uri, source_uris: $manifest[0].source_uris}' \
    >"$latest"
  aws s3 cp "$latest" "s3://${BACKUP_BUCKET}/${LATEST_KEY}" --region "$AWS_REGION" --sse AES256 >/dev/null
  echo "Backup manifest: s3://${BACKUP_BUCKET}/${manifest_key}"
}

restore() {
  require_context
  local manifest_uri temp_file source_uris body response id
  if [[ "${REDIS_BACKUP_ASSUME_YES:-0}" != "1" && "${CONFIRM_REDIS_CLOUD_RESTORE:-}" != "$DATABASE_ID" ]]; then
    echo "Restore overwrites database ${DATABASE_ID}. Set CONFIRM_REDIS_CLOUD_RESTORE=${DATABASE_ID}." >&2
    exit 1
  fi
  manifest_uri="${REDIS_BACKUP_MANIFEST_URI:-s3://${BACKUP_BUCKET}/${LATEST_KEY}}"
  temp_file="$(mktemp "${TMPDIR:-/tmp}/redis-rdb-restore.XXXXXX")"
  trap 'rm -f "$temp_file"' RETURN
  aws s3 cp "$manifest_uri" "$temp_file" --region "$AWS_REGION" >/dev/null
  source_uris="$(jq -c '.source_uris' "$temp_file")"
  if [[ "$source_uris" == "null" || "$(jq length <<<"$source_uris")" -eq 0 ]]; then
    echo "No source_uris were found in ${manifest_uri}." >&2
    exit 1
  fi
  body="$(jq -cn --argjson uris "$source_uris" '{sourceType: "aws-s3", importFromUri: $uris}')"
  echo "Restoring $(jq length <<<"$source_uris") Redis Cloud shard files from ${manifest_uri}." >&2
  response="$(api POST "/subscriptions/${SUBSCRIPTION_ID}/databases/${DATABASE_ID}/import" "$body")"
  id="$(task_id "$response")"
  if [[ -z "$id" ]]; then
    echo "Redis Cloud import did not return a taskId: ${response}" >&2
    return 1
  fi
  echo "Redis Cloud import task: ${id}" >&2
  poll_task "$id" "Redis Cloud import"
}

case "${1:-}" in
  has-backup) has_backup ;;
  backup) backup ;;
  restore) restore ;;
  backup-status)
    : "${REDIS_BACKUP_TASK_ID:?Set REDIS_BACKUP_TASK_ID to the taskId returned by backup.}"
    api GET "/tasks/${REDIS_BACKUP_TASK_ID}" | jq .
    ;;
  restore-status)
    : "${REDIS_RESTORE_TASK_ID:?Set REDIS_RESTORE_TASK_ID to the taskId returned by restore.}"
    api GET "/tasks/${REDIS_RESTORE_TASK_ID}" | jq .
    ;;
  *)
    echo "Usage: $0 {has-backup|backup|restore|backup-status|restore-status}" >&2
    exit 2
    ;;
esac
