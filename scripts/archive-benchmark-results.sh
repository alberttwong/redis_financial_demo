#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_ROOT="${BENCHMARK_OUTPUT_DIR:-${REPO_ROOT}/memtier-output}"
ARCHIVE_DATE="${BENCHMARK_ARCHIVE_DATE:-$(date -u +%Y-%m-%d)}"
ARCHIVE_LABEL="${BENCHMARK_ARCHIVE_LABEL:-${ARCHIVE_DATE}}"
BUCKET="${BENCHMARK_ARCHIVE_BUCKET:-lpl-redis-benchmark-rdb-20260722222753244900000001}"
PREFIX="${BENCHMARK_ARCHIVE_PREFIX:-benchmark-results/raw/${ARCHIVE_LABEL}}"
STAGING_ROOT="${BENCHMARK_ARCHIVE_STAGING:-${TMPDIR:-/tmp}/lpl-benchmark-archive-${ARCHIVE_LABEL}}"
ARCHIVE_ROOT="${STAGING_ROOT}/archives"
SOURCE_MAP_PATH="${STAGING_ROOT}/archive-source-map.tsv"
MANIFEST_PATH="${BENCHMARK_ARCHIVE_MANIFEST:-${REPO_ROOT}/docs/benchmark-results/archive-manifest-${ARCHIVE_LABEL}.tsv}"
MODE="${1:-all}"

usage() {
  echo "Usage: $0 [package|upload|verify|all]"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 1
  fi
}

file_size_bytes() {
  if stat -f%z "$1" >/dev/null 2>&1; then
    stat -f%z "$1"
  else
    stat -c%s "$1"
  fi
}

file_sha256_base64() {
  openssl dgst -sha256 -binary "$1" | openssl base64 -A
}

archive_size_bytes() {
  local total=0
  while IFS= read -r -d '' archive; do
    total=$((total + $(file_size_bytes "${archive}")))
  done < <(find "${ARCHIVE_ROOT}" -type f -name '*.tar.gz' -print0)
  printf '%s\n' "${total}"
}

scan_for_secrets() {
  local matches
  matches="$(
    rg -l -i --hidden \
      --glob '!*.rdb' \
      --glob '!*.docx' \
      'AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|authorization[[:space:]]*[:=][[:space:]]*(bearer|basic)|-----BEGIN [A-Z ]*PRIVATE KEY-----|rediss?://[^[:space:]@]+@|REDISCLOUD_(ACCESS|SECRET)_KEY[[:space:]]*=' \
      "${SOURCE_ROOT}" || true
  )"

  if [[ -n "${matches}" ]]; then
    echo "Refusing to archive files that may contain credentials:" >&2
    echo "${matches}" >&2
    exit 1
  fi
}

record_archive() {
  local archive="$1"
  local source_path="$2"
  local relative="${archive#${ARCHIVE_ROOT}/}"
  printf '%s\t%s\n' "${relative}" "${source_path}" >>"${SOURCE_MAP_PATH}"
}

create_archive() {
  local archive="$1"
  shift
  tar -cf - -C "${SOURCE_ROOT}" "$@" | gzip -n >"${archive}"
}

write_manifest() {
  mkdir -p "$(dirname "${MANIFEST_PATH}")"
  {
    printf 'sha256\tbytes\tsource_path\ts3_uri\n'
    while IFS=$'\t' read -r relative source_path; do
      archive="${ARCHIVE_ROOT}/${relative}"
      sha256="$(shasum -a 256 "${archive}" | awk '{print $1}')"
      bytes="$(file_size_bytes "${archive}")"
      printf '%s\t%s\t%s\t%s\n' \
        "${sha256}" \
        "${bytes}" \
        "${source_path}" \
        "s3://${BUCKET}/${PREFIX}/${relative}"
    done < <(sort "${SOURCE_MAP_PATH}")
  } >"${MANIFEST_PATH}"
}

verify_package_coverage() {
  local archived_files="${STAGING_ROOT}/archived-files.txt"
  local local_files="${STAGING_ROOT}/local-files.txt"
  local duplicate_files="${STAGING_ROOT}/duplicate-archive-files.txt"
  local coverage_differences="${STAGING_ROOT}/archive-coverage-differences.txt"

  find "${ARCHIVE_ROOT}" -type f -name '*.tar.gz' -print0 |
    while IFS= read -r -d '' archive; do
      tar -tzf "${archive}"
    done |
    sed '/\/$/d' |
    sort >"${archived_files}"

  find "${SOURCE_ROOT}" -type f -print0 |
    while IFS= read -r -d '' source_file; do
      printf '%s\n' "${source_file#${SOURCE_ROOT}/}"
    done |
    sort >"${local_files}"

  uniq -d "${archived_files}" >"${duplicate_files}"
  comm -3 "${archived_files}" "${local_files}" >"${coverage_differences}"

  if [[ -s "${duplicate_files}" || -s "${coverage_differences}" ]]; then
    echo "Archive source coverage verification failed." >&2
    if [[ -s "${duplicate_files}" ]]; then
      echo "Paths packaged more than once:" >&2
      sed -n '1,20p' "${duplicate_files}" >&2
    fi
    if [[ -s "${coverage_differences}" ]]; then
      echo "Paths missing from either the archive or source:" >&2
      sed -n '1,20p' "${coverage_differences}" >&2
    fi
    exit 1
  fi

  covered_files="$(wc -l <"${local_files}" | tr -d ' ')"
  echo "Verified package coverage: ${covered_files} of ${covered_files} source files, with no duplicates."
}

package_results() {
  require_command rg
  require_command gzip
  require_command shasum
  require_command tar

  if [[ ! -d "${SOURCE_ROOT}" ]]; then
    echo "Benchmark output directory not found: ${SOURCE_ROOT}" >&2
    exit 1
  fi

  scan_for_secrets
  rm -rf "${ARCHIVE_ROOT}"
  mkdir -p "${ARCHIVE_ROOT}"
  : >"${SOURCE_MAP_PATH}"

  for family in aws-load-runner aws-direct-redis; do
    family_root="${SOURCE_ROOT}/${family}"
    [[ -d "${family_root}" ]] || continue
    mkdir -p "${ARCHIVE_ROOT}/${family}"

    while IFS= read -r -d '' run_dir; do
      run_name="$(basename "${run_dir}")"
      archive="${ARCHIVE_ROOT}/${family}/${run_name}.tar.gz"
      create_archive "${archive}" "${family}/${run_name}"
      record_archive "${archive}" "memtier-output/${family}/${run_name}"
    done < <(find "${family_root}" -mindepth 1 -maxdepth 1 -type d -print0 | sort -z)

    family_files=()
    while IFS= read -r -d '' family_file; do
      family_files+=("${family}/$(basename "${family_file}")")
    done < <(find "${family_root}" -mindepth 1 -maxdepth 1 -type f -print0 | sort -z)

    if (( ${#family_files[@]} > 0 )); then
      archive="${ARCHIVE_ROOT}/${family}/_root-files.tar.gz"
      create_archive "${archive}" "${family_files[@]}"
      record_archive "${archive}" "memtier-output/${family}/* (files only)"
    fi
  done

  mkdir -p "${ARCHIVE_ROOT}/misc"
  while IFS= read -r -d '' top_level_dir; do
    top_level_name="$(basename "${top_level_dir}")"
    case "${top_level_name}" in
      aws-load-runner | aws-direct-redis)
        continue
        ;;
    esac

    archive="${ARCHIVE_ROOT}/misc/${top_level_name}.tar.gz"
    create_archive "${archive}" "${top_level_name}"
    record_archive "${archive}" "memtier-output/${top_level_name}"
  done < <(find "${SOURCE_ROOT}" -mindepth 1 -maxdepth 1 -type d -print0 | sort -z)

  root_files=()
  while IFS= read -r -d '' root_file; do
    root_files+=("$(basename "${root_file}")")
  done < <(find "${SOURCE_ROOT}" -mindepth 1 -maxdepth 1 -type f -print0 | sort -z)

  if (( ${#root_files[@]} > 0 )); then
    archive="${ARCHIVE_ROOT}/misc/root-files.tar.gz"
    create_archive "${archive}" "${root_files[@]}"
    record_archive "${archive}" "memtier-output/* (files only)"
  fi

  write_manifest
  verify_package_coverage
  archive_count="$(find "${ARCHIVE_ROOT}" -type f -name '*.tar.gz' | wc -l | tr -d ' ')"
  archive_bytes="$(archive_size_bytes)"
  echo "Packaged ${archive_count} archives (${archive_bytes} bytes)."
  echo "Manifest: ${MANIFEST_PATH}"
}

upload_results() {
  require_command aws
  require_command openssl

  if [[ ! -d "${ARCHIVE_ROOT}" || ! -f "${MANIFEST_PATH}" ]]; then
    echo "Packaged archives or manifest are missing. Run '$0 package' first." >&2
    exit 1
  fi

  uploaded=0
  skipped=0
  while IFS= read -r -d '' archive; do
    relative="${archive#${ARCHIVE_ROOT}/}"
    local_checksum="$(file_sha256_base64 "${archive}")"
    if remote_checksum="$(
      aws s3api head-object \
        --bucket "${BUCKET}" \
        --key "${PREFIX}/${relative}" \
        --checksum-mode ENABLED \
        --query ChecksumSHA256 \
        --output text 2>/dev/null
    )"; then
      if [[ "${local_checksum}" != "${remote_checksum}" ]]; then
        echo "Refusing to overwrite an archive with different content: ${relative}" >&2
        echo "Use a new BENCHMARK_ARCHIVE_DATE or BENCHMARK_ARCHIVE_PREFIX." >&2
        exit 1
      fi
      skipped=$((skipped + 1))
      continue
    fi

    aws s3api put-object \
      --bucket "${BUCKET}" \
      --key "${PREFIX}/${relative}" \
      --body "${archive}" \
      --server-side-encryption AES256 \
      --checksum-algorithm SHA256 \
      --output json >/dev/null
    uploaded=$((uploaded + 1))
  done < <(find "${ARCHIVE_ROOT}" -type f -name '*.tar.gz' -print0 | sort -z)

  manifest_checksum="$(file_sha256_base64 "${MANIFEST_PATH}")"
  if remote_manifest_checksum="$(
    aws s3api head-object \
      --bucket "${BUCKET}" \
      --key "${PREFIX}/archive-manifest.tsv" \
      --checksum-mode ENABLED \
      --query ChecksumSHA256 \
      --output text 2>/dev/null
  )"; then
    if [[ "${manifest_checksum}" != "${remote_manifest_checksum}" ]]; then
      echo "Refusing to overwrite a different archive manifest." >&2
      echo "Use a new BENCHMARK_ARCHIVE_DATE or BENCHMARK_ARCHIVE_PREFIX." >&2
      exit 1
    fi
  else
    aws s3api put-object \
      --bucket "${BUCKET}" \
      --key "${PREFIX}/archive-manifest.tsv" \
      --body "${MANIFEST_PATH}" \
      --server-side-encryption AES256 \
      --checksum-algorithm SHA256 \
      --output json >/dev/null
  fi

  echo "Archive destination: s3://${BUCKET}/${PREFIX}/"
  echo "Uploaded ${uploaded}; skipped ${skipped} byte-identical existing archives."
}

verify_results() {
  require_command aws
  require_command openssl

  if [[ ! -d "${ARCHIVE_ROOT}" || ! -f "${MANIFEST_PATH}" ]]; then
    echo "Packaged archives or manifest are missing. Run '$0 package' first." >&2
    exit 1
  fi

  local_count="$(find "${ARCHIVE_ROOT}" -type f -name '*.tar.gz' | wc -l | tr -d ' ')"
  local_bytes="$(archive_size_bytes)"
  remote_count="$(
    aws s3api list-objects-v2 \
      --bucket "${BUCKET}" \
      --prefix "${PREFIX}/" \
      --query "length(Contents[?ends_with(Key, '.tar.gz')])" \
      --output text
  )"
  remote_bytes="$(
    aws s3api list-objects-v2 \
      --bucket "${BUCKET}" \
      --prefix "${PREFIX}/" \
      --query "sum(Contents[?ends_with(Key, '.tar.gz')].Size)" \
      --output text
  )"

  if [[ "${local_count}" != "${remote_count}" || "${local_bytes}" != "${remote_bytes}" ]]; then
    echo "Archive verification failed." >&2
    echo "Local:  ${local_count} archives, ${local_bytes} bytes" >&2
    echo "Remote: ${remote_count} archives, ${remote_bytes} bytes" >&2
    exit 1
  fi

  while IFS= read -r -d '' archive; do
    relative="${archive#${ARCHIVE_ROOT}/}"
    local_checksum="$(file_sha256_base64 "${archive}")"
    read -r remote_checksum remote_encryption < <(
      aws s3api head-object \
        --bucket "${BUCKET}" \
        --key "${PREFIX}/${relative}" \
        --checksum-mode ENABLED \
        --query '[ChecksumSHA256, ServerSideEncryption]' \
        --output text
    )
    if [[ "${local_checksum}" != "${remote_checksum}" ]]; then
      echo "SHA-256 verification failed for ${relative}." >&2
      exit 1
    fi
    if [[ "${remote_encryption}" != "AES256" ]]; then
      echo "Server-side encryption verification failed for ${relative}." >&2
      exit 1
    fi
  done < <(find "${ARCHIVE_ROOT}" -type f -name '*.tar.gz' -print0 | sort -z)

  remote_manifest="${STAGING_ROOT}/remote-archive-manifest.tsv"
  aws s3api get-object \
    --bucket "${BUCKET}" \
    --key "${PREFIX}/archive-manifest.tsv" \
    --checksum-mode ENABLED \
    "${remote_manifest}" \
    --output json >/dev/null
  cmp "${MANIFEST_PATH}" "${remote_manifest}"

  echo "Verified ${remote_count} archives (${remote_bytes} bytes), every SHA-256 checksum, and the manifest."
}

case "${MODE}" in
  package)
    package_results
    ;;
  upload)
    upload_results
    ;;
  verify)
    verify_results
    ;;
  all)
    package_results
    upload_results
    verify_results
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac
