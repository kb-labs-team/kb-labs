#!/bin/bash
set -euo pipefail

readonly state_dir="$HOME/Library/Application Support/kb-security-digest"
readonly previous="$state_dir/current.snapshot"
readonly next="$state_dir/next.snapshot"
readonly log_file="$state_dir/changes.log"
mkdir -p "$state_dir"
: > "$next"

hash_file() {
  local label="$1" file="$2" digest
  if [[ -f "$file" ]]; then
    if [[ -r "$file" ]]; then
      digest="$(shasum -a 256 "$file" 2>/dev/null | awk '{print $1}')"
      [[ -n "$digest" ]] || digest=unreadable
    else
      digest=unreadable
    fi
    printf 'file\t%s\t%s\n' "$label" "$digest" >> "$next"
  else
    printf 'file\t%s\tmissing\n' "$label" >> "$next"
  fi
}

hash_tree() {
  local label="$1" dir="$2" file relative digest link_target
  if [[ ! -d "$dir" ]]; then
    printf 'tree\t%s\tmissing\n' "$label" >> "$next"
    return
  fi
  while IFS= read -r -d '' file; do
    relative="${file#"$dir"/}"
    if [[ -L "$file" ]]; then
      link_target="$(readlink "$file")"
      digest="$(printf '%s' "$link_target" | shasum -a 256 | awk '{print $1}')"
    elif [[ -r "$file" ]]; then
      digest="$(shasum -a 256 "$file" 2>/dev/null | awk '{print $1}')"
      [[ -n "$digest" ]] || digest=unreadable
    else
      digest=unreadable
    fi
    printf 'tree\t%s/%s\t%s\n' "$label" "$relative" "$digest" >> "$next"
  done < <(find "$dir" \( -type f -o -type l \) -print0 | sort -z)
}

key_names() {
  local label="$1" file="$2"
  if [[ ! -f "$file" ]]; then
    printf 'keys\t%s\tmissing\n' "$label" >> "$next"
    return
  fi
  awk '
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    {
      line=$0
      sub(/^[[:space:]]*/, "", line)
      split(line, pair, /[=:]/)
      key=pair[1]
      sub(/[[:space:]]*$/, "", key)
      if (key != "") print key
    }
  ' "$file" | sort -u | while IFS= read -r key; do
    printf 'key\t%s\t%s\n' "$label" "$key" >> "$next"
  done
}

package_manifests() {
  local label="$1" root="$2" file package version
  if [[ ! -d "$root" ]]; then
    printf 'packages\t%s\tmissing\n' "$label" >> "$next"
    return
  fi
  while IFS= read -r -d '' file; do
    read -r package version < <(node -e 'const p=require(process.argv[1]); console.log(`${p.name || "<unnamed>"} ${p.version || "<no-version>"}`)' "$file" 2>/dev/null || printf '<unreadable> <unreadable>\n')
    digest="$(shasum -a 256 "$file" | awk '{print substr($1, 1, 12)}')"
    printf 'package\t%s\t%s@%s\t%s\n' "$label" "$package" "$version" "$digest" >> "$next"
  done < <(find "$root" -mindepth 2 -maxdepth 8 -name package.json -type f -print0 | sort -z)
}

path_executables() {
  local dir file name digest
  IFS=: read -r -a path_dirs <<< "${PATH:-}"
  for dir in "${path_dirs[@]}"; do
    [[ -d "$dir" ]] || continue
    printf 'path-dir\t%s\n' "$dir" >> "$next"
    while IFS= read -r -d '' file; do
      name="$(basename "$file")"
      if [[ -r "$file" ]]; then
        digest="$(shasum -a 256 "$file" 2>/dev/null | awk '{print $1}')"
        [[ -n "$digest" ]] || digest=unreadable
      else
        digest=unreadable
      fi
      printf 'executable\t%s/%s\t%s\n' "$dir" "$name" "$digest" >> "$next"
    done < <(find -L "$dir" -maxdepth 1 -type f -perm -111 -print0 2>/dev/null | sort -z)
  done
}

login_items() {
  local item
  if ! command -v osascript >/dev/null 2>&1; then
    printf 'login-items\tunavailable\n' >> "$next"
    return
  fi
  if ! osascript -e 'tell application "System Events" to get name of every login item' 2>/dev/null | tr ',' '\n' | sed 's/^ *//;s/ *$//' | sort -u | while IFS= read -r item; do
    [[ -n "$item" ]] && printf 'login-item\t%s\n' "$item" >> "$next"
  done; then
    printf 'login-items\tpermission-denied\n' >> "$next"
  fi
}

for directory in "$HOME/Library/LaunchAgents" /Library/LaunchAgents /Library/LaunchDaemons; do
  hash_tree "launchd:$directory" "$directory"
done

login_items

for file in "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.bashrc" "$HOME/.profile"; do
  hash_file "shell:$file" "$file"
done

for file in "$HOME/.ssh/authorized_keys" "$HOME/.ssh/config"; do
  hash_file "ssh:$file" "$file"
done

path_executables

# Inspect conventional global package roots directly: no package-manager
# command is run, so this digest does not load npm/pnpm authentication config.
if command -v node >/dev/null 2>&1; then
  node_prefix="$(cd "$(dirname "$(command -v node)")/.." && pwd)"
  package_manifests npm-global "$node_prefix/lib/node_modules"
  package_manifests pnpm-global "$HOME/.local/share/pnpm/global"
  package_manifests pnpm-global-alt "$HOME/Library/pnpm/global"
  package_manifests bun-global "$HOME/.bun/install/global/node_modules"
else
  printf 'packages\tall-global\tnode-unavailable\n' >> "$next"
fi

key_names npmrc "$HOME/.npmrc"
key_names pnpm-global-rc "$HOME/Library/Preferences/pnpm/config.yaml"

if [[ ! -f "$previous" ]]; then
  mv "$next" "$previous"
  printf '%s baseline created\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  exit 0
fi

if ! cmp -s "$previous" "$next"; then
  changes="$(mktemp "$state_dir/changes.XXXXXX")"
  awk -F '\t' '
    function category(kind, label) {
      if (kind == "tree" || kind == "login-item" || kind == "login-items") return "launchd"
      if (kind == "executable" || kind == "path-dir") return "executable"
      if (kind == "package" || kind == "packages") return "package"
      if (kind == "key") return "key-name"
      if (kind == "file") {
        if (label ~ /^shell:/) return "shell"
        if (label ~ /^ssh:/) return "ssh"
        if (label ~ /^launchd:/) return "launchd"
      }
      return "launchd"
    }
    function name(kind, label, value) {
      if (kind == "package") return value
      if (kind == "key") return label ":" value
      if (kind == "login-item") return label
      if (kind == "login-items" || kind == "packages") return label
      return label
    }
    function hash_prefix(kind, label, value, hash) {
      if (kind == "file" || kind == "tree" || kind == "executable") return substr(value, 1, 12)
      if (kind == "package") return substr(hash, 1, 12)
      return ""
    }
    FNR == NR { before[$0] = 1; next }
    {
      after[$0] = 1
      if (!($0 in before)) {
        kind=$1; label=$2; value=$3
        printf "added\t%s\t%s\t%s\n", category(kind, label), name(kind, label, value), hash_prefix(kind, label, value, $4)
      }
    }
    END {
      for (line in before) if (!(line in after)) {
        count=split(line, parts, "\t")
        kind=parts[1]; label=parts[2]; value=parts[3]
        printf "removed\t%s\t%s\t%s\n", category(kind, label), name(kind, label, value), hash_prefix(kind, label, value, parts[4])
      }
    }
  ' "$previous" "$next" | sort -u > "$changes"
  categories="$(cut -f2 "$changes" | sort -u | paste -sd ', ' -)"
  [[ -n "$categories" ]] || categories=unknown
  timestamp="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  {
    printf '%s changed categories: %s\n' "$timestamp" "$categories"
    awk -F '\t' -v timestamp="$timestamp" '{ if ($4 != "") printf "%s %s %s %s sha256:%s\n", timestamp, $1, $2, $3, $4; else printf "%s %s %s %s\n", timestamp, $1, $2, $3 }' "$changes"
  } >> "$log_file"
  mv "$next" "$previous"
  if osascript -e "display notification \"Changed: $categories\" with title \"KB Labs Security Digest\"" >/dev/null 2>&1; then
    printf '%s changed categories: %s; notification sent\n' "$timestamp" "$categories"
  else
    printf '%s changed categories: %s; notification failed. Next: check osascript and macOS notification permissions.\n' "$timestamp" "$categories" >&2
    exit 1
  fi
  rm -f "$changes"
else
  rm -f "$next"
  printf '%s unchanged\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
fi
