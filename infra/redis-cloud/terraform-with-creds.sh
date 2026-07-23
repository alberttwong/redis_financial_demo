#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../scripts/load-redis-cloud-credentials.sh
. "${SCRIPT_DIR}/../../scripts/load-redis-cloud-credentials.sh"

exec terraform "$@"
