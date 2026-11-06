#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
INSTALLER="$ROOT/tools/kb-create/install.sh"
CASES="$ROOT/tools/clikit/ui/color_policy_cases.sh"
TMP=$(mktemp -d /tmp/kb-color-policy.XXXXXX)
BLOCK="$TMP/color-policy.sh"
PROBE="$TMP/probe.sh"
RESULT="$TMP/result"
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

awk '
  $0 == "# BEGIN GENERATED COLOR POLICY" { inside = 1; next }
  $0 == "# END GENERATED COLOR POLICY" { inside = 0; next }
  inside { print }
' "$INSTALLER" > "$BLOCK"
if [ ! -s "$BLOCK" ]; then
  printf 'installer generated color block is missing\n' >&2
  exit 1
fi

cat > "$PROBE" <<'SH'
#!/bin/sh
. "$COLOR_POLICY_BLOCK"
if kb_color_enabled; then
  printf true > "$COLOR_POLICY_RESULT_FILE"
else
  printf false > "$COLOR_POLICY_RESULT_FILE"
fi
SH
chmod +x "$PROBE"
COLOR_POLICY_BLOCK="$BLOCK"
COLOR_POLICY_RESULT_FILE="$RESULT"
export COLOR_POLICY_BLOCK COLOR_POLICY_RESULT_FILE

color_policy_case() {
  case_name=$1
  tty=$2
  no_color=$3
  force_color_set=$4
  force_color=$5
  term=$6
  want=$7
  NO_COLOR=$no_color
  TERM=$term
  export NO_COLOR TERM
  if [ "$force_color_set" = true ]; then
    FORCE_COLOR=$force_color
    export FORCE_COLOR
  else
    unset FORCE_COLOR
  fi
  rm -f "$RESULT"
  if [ "$tty" = true ]; then
    case $(uname -s) in
      Darwin) script -q /dev/null "$PROBE" >/dev/null ;;
      *) script -q -c "'$PROBE'" /dev/null >/dev/null ;;
    esac
  else
    "$PROBE" >/dev/null
  fi
  if [ ! -f "$RESULT" ]; then
    printf '%s: shell policy probe wrote no result\n' "$case_name" >&2
    return 1
  fi
  got=$(cat "$RESULT")
  if [ "$got" != "$want" ]; then
    printf '%s: shell color = %s, want %s\n' "$case_name" "$got" "$want" >&2
    return 1
  fi
}

if [ ! -f "$CASES" ]; then
  printf 'generated shell color-policy cases are missing; run node tools/clikit/ui/generate-color-policy.mjs\n' >&2
  exit 1
fi
. "$CASES"
printf 'installer shell color policy passed all generated cases\n'
