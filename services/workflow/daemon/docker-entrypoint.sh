#!/bin/sh
# A release image has no composition. kb-create materializes a user's config
# and lock in a derived image; booting a base image is an operator error.
set -e

if [ ! -f /app/.kb/kb.config.json ] && [ ! -f /app/.kb/kb.config.jsonc ]; then
  echo "fatal: /app/.kb/kb.config.json or kb.config.jsonc is required; build a composition with kb-create deployment export" >&2
  exit 64
fi

if [ ! -f /app/.kb/marketplace.lock ]; then
  echo "fatal: /app/.kb/marketplace.lock is required; build a composition with kb-create deployment export" >&2
  exit 64
fi

exec "$@"
