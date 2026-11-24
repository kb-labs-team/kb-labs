#!/bin/sh
set -eu

data_root="${KB_STATE_DAEMON_DATA_ROOT:-}"
data_root=$(printf '%s' "$data_root" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')

if [ -n "$data_root" ]; then
  umask 077
  case "$data_root" in
    /*) ;;
    *) data_root="/app/$data_root" ;;
  esac

  state_directory="$data_root/state-broker"
  lock_file="$state_directory/journal.jsonl.flock"
  mkdir -p "$state_directory"

  if [ -L "$lock_file" ] || [ -d "$lock_file" ]; then
    echo "StateBroker kernel lock path must be a regular file: $lock_file" >&2
    exit 1
  fi

  # The no-fork form execs Node in this process, so the kernel releases this
  # lock on process death and /proc/locks reports the daemon's PID as owner.
  exec flock --no-fork --exclusive "$lock_file" node /app/dist/bin.cjs "$@"
fi

exec node /app/dist/bin.cjs "$@"
