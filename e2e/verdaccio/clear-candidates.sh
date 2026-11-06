#!/bin/sh
set -eu

storage="$1"
find "$storage" -mindepth 1 -maxdepth 1 -type d -name '@kb-labs%2f*' -exec rm -rf {} +
