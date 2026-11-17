#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: e2e/journey/smoke.sh <local|secured> [run.sh arguments...]" >&2
  exit 2
fi

mode="$1"
shift
case "$mode" in
  local)
    export KB_JOURNEY_ONLY="agent:commit,service-local:explore"
    ;;
  secured)
    export KB_JOURNEY_ONLY="agent-secured:commit,service-secured:explore"
    ;;
  *)
    echo "Unsupported smoke mode '$mode'. Use 'local' or 'secured'." >&2
    exit 2
    ;;
esac

export KB_JOURNEY_CASES="PC-001.2,PC-002.3,PC-002.8"
exec "$(dirname "${BASH_SOURCE[0]}")/run.sh" "$@"
