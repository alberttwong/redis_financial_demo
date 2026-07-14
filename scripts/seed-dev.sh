#!/usr/bin/env bash
set -euo pipefail

# Faster laptop defaults for the 100-account development profile. Explicit
# environment variables still take precedence.
export SEED_BATCH_SIZE="${SEED_BATCH_SIZE:-1000}"
export SEED_WRITE_CONCURRENCY="${SEED_WRITE_CONCURRENCY:-8}"

node --env-file-if-exists=.env.local --import tsx scripts/seed.ts all
npm run redis:functions
