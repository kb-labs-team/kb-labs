#!/bin/bash
set -euo pipefail

mode=apply
if [[ "${1:-}" == "--check" ]]; then
  mode=check
elif [[ $# -gt 0 ]]; then
  echo "Usage: $0 [--check]" >&2
  exit 2
fi

pnpm_settings=(minimumReleaseAge:minimumReleaseAge strictDepBuilds:strictDepBuilds blockExoticSubdeps:block-exotic-subdeps)

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required to configure and verify global intake settings." >&2
  exit 127
fi

# Capture the selected pnpm before leaving the caller's workspace. Corepack
# otherwise selects its default version from /tmp instead of this project.
pnpm_version="$(pnpm --version)"
if command -v corepack >/dev/null 2>&1; then
  pnpm_cli=(corepack "pnpm@$pnpm_version")
else
  pnpm_cli=(pnpm)
fi
pnpm_run() {
  "${pnpm_cli[@]}" "$@"
}

pnpm_global_keys=()
pnpm_values=()
for setting in "${pnpm_settings[@]}"; do
  project_key="${setting%%:*}"
  global_key="${setting#*:}"
  expected="$(pnpm_run config get "$project_key" --location project)"
  if [[ -z "$expected" || "$expected" == undefined ]]; then
    printf 'Workspace setting %s is unavailable; run this script from the configured workspace.\n' "$project_key" >&2
    exit 1
  fi
  pnpm_global_keys+=("$global_key")
  pnpm_values+=("$expected")
done

# Run outside any project so config get reports the effective global value.
cd /tmp

show_pnpm_values() {
  local key
  for key in "${pnpm_global_keys[@]}"; do
    printf '%s=%s\n' "$key" "$(pnpm_run config get "$key" --location global)"
  done
}

show_npm_value() {
  local value='<missing>'
  if [[ -f "$HOME/.npmrc" ]]; then
    value="$(awk -F '[=:]' '$1 == "ignore-scripts" { gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $2; exit }' "$HOME/.npmrc")"
    [[ -n "$value" ]] || value='<missing>'
  fi
  printf 'ignore-scripts=%s\n' "$value"
}

echo 'before pnpm:'
show_pnpm_values
echo 'before npm:'
show_npm_value

if [[ "$mode" == apply ]]; then
  for index in "${!pnpm_global_keys[@]}"; do
    pnpm_run config set "${pnpm_global_keys[$index]}" "${pnpm_values[$index]}" --location global
  done
  mkdir -p "$HOME"
  tmp="$(mktemp "$HOME/.npmrc.XXXXXX")"
  if [[ -f "$HOME/.npmrc" ]]; then
    awk '
      BEGIN { written=0 }
      /^[[:space:]]*#/ { print; next }
      {
        line=$0
        sub(/^[[:space:]]*/, "", line)
        split(line, pair, /[=:]/)
        key=pair[1]
        sub(/[[:space:]]*$/, "", key)
        if (key == "ignore-scripts") {
          if (!written) print "ignore-scripts=true"
          written=1
          next
        }
        print
      }
      END { if (!written) print "ignore-scripts=true" }
    ' "$HOME/.npmrc" > "$tmp"
  else
    printf 'ignore-scripts=true\n' > "$tmp"
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$HOME/.npmrc"
fi

echo 'after pnpm:'
show_pnpm_values
echo 'after npm:'
show_npm_value

failed=0
for index in "${!pnpm_global_keys[@]}"; do
  actual="$(pnpm_run config get "${pnpm_global_keys[$index]}" --location global)"
  if [[ "$actual" != "${pnpm_values[$index]}" ]]; then
    printf 'Expected pnpm global %s=%s; got %s\n' "${pnpm_global_keys[$index]}" "${pnpm_values[$index]}" "$actual" >&2
    failed=1
  fi
done
if [[ "$(show_npm_value | cut -d= -f2-)" != true ]]; then
  echo 'Expected npm ignore-scripts=true.' >&2
  failed=1
fi
exit "$failed"
