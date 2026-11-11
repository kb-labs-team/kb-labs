#!/bin/sh
# Release images contain a cloud default config. Delivery layers may add an
# overlay without replacing that default.
set -e

exec "$@"
