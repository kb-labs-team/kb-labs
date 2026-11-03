#!/bin/bash
set -euo pipefail

if [[ $# -ne 0 ]]; then
  echo "Usage: $0" >&2
  exit 2
fi

readonly label='com.kblabs.security-digest'
readonly source_script="$(cd "$(dirname "$0")" && pwd)/digest.sh"
readonly install_root="$HOME/Library/Application Support/kb-security-digest"
readonly install_bin="$install_root/bin"
readonly installed_script="$install_bin/digest.sh"
readonly plist="$HOME/Library/LaunchAgents/$label.plist"
readonly uid="$(id -u)"

if [[ ! -f "$source_script" ]]; then
  echo "Digest source not found: $source_script" >&2
  exit 1
fi

if ! login_path="$(/bin/zsh -lic 'print -r -- $PATH' 2>/dev/null)"; then
  printf "Could not read PATH from the owner login shell.\nNext: /bin/zsh -lic 'print -r -- \$PATH'\n" >&2
  exit 1
fi

launch_path=''
append_path_dir() {
  local candidate="$1" resolved repo_root worktrees worktree_entry worktree_root
  [[ "$candidate" == /* && -d "$candidate" ]] || return 0
  resolved="$(cd "$candidate" && pwd -P)" || {
    printf "Could not resolve PATH directory: %s\nNext: /usr/bin/stat -f '%%N %%Sp' %q\n" "$candidate" "$candidate" >&2
    return 1
  }
  case "$resolved/" in
    /tmp/*|/private/tmp/*) return 0 ;;
  esac
  case "/$resolved/" in
    */node_modules/*) return 0 ;;
  esac
  if repo_root="$(git -C "$resolved" rev-parse --show-toplevel 2>/dev/null)"; then
    worktrees="$(git -C "$repo_root" worktree list --porcelain)" || {
      printf 'Could not list Git worktrees for PATH directory: %s\n' "$resolved" >&2
      return 1
    }
    while IFS= read -r worktree_entry; do
      case "$worktree_entry" in
        'worktree '*)
          worktree_root="${worktree_entry#worktree }"
          case "$resolved/" in
            "$worktree_root/"*) return 0 ;;
          esac
          ;;
      esac
    done <<< "$worktrees"
  fi
  case ":$launch_path:" in
    *":$resolved:"*) return 0 ;;
  esac
  if [[ -n "$launch_path" ]]; then
    launch_path="$launch_path:$resolved"
  else
    launch_path="$resolved"
  fi
}

IFS=: read -r -a login_path_dirs <<< "$login_path"
for path_dir in "${login_path_dirs[@]}"; do
  append_path_dir "$path_dir"
done
for path_dir in /usr/local/bin /usr/bin /bin /usr/sbin /sbin; do
  append_path_dir "$path_dir"
done

xml_escape() {
  printf '%s' "$1" | sed 's/\&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'
}

escaped_home="$(xml_escape "$HOME")"
escaped_path="$(xml_escape "$launch_path")"
escaped_script="$(xml_escape "$installed_script")"
mkdir -p "$install_bin" "$(dirname "$plist")"
chmod 700 "$install_root" "$install_bin"
install -m 700 "$source_script" "$installed_script"

plist_tmp="$(mktemp "$(dirname "$plist")/.$label.XXXXXX")"
cat > "$plist_tmp" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$escaped_script</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>HOME</key><string>$escaped_home</string><key>PATH</key><string>$escaped_path</string></dict>
  <key>RunAtLoad</key><true/>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>$escaped_home/Library/Application Support/kb-security-digest/launchd.out</string>
  <key>StandardErrorPath</key><string>$escaped_home/Library/Application Support/kb-security-digest/launchd.err</string>
</dict>
</plist>
PLIST
chmod 600 "$plist_tmp"
mv "$plist_tmp" "$plist"
if command -v plutil >/dev/null 2>&1; then
  plutil -lint "$plist"
fi

if launchctl print "gui/$uid/$label" >/dev/null 2>&1; then
  launchctl bootout "gui/$uid/$label"
fi
launchctl bootstrap "gui/$uid" "$plist"
if [[ ! -f "$install_root/current.snapshot" ]]; then
  PATH="$launch_path" "$installed_script"
  printf 'Created the initial digest baseline.\n'
else
  printf 'Existing digest baseline retained.\n'
fi

printf 'Installed digest: %s\n' "$installed_script"
printf 'LaunchAgent: %s\n' "$plist"
printf 'Launchd PATH: %s\n' "$launch_path"
printf 'Bootstrapped gui/%s.\n' "$uid"
