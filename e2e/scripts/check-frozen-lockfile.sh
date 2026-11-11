#!/usr/bin/env bash
set -euo pipefail

corepack pnpm install --lockfile-only --frozen-lockfile --ignore-scripts
echo "Lockfile is current"
