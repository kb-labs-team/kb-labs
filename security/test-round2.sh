#!/bin/bash
set -euo pipefail

readonly security_dir="$(cd "$(dirname "$0")" && pwd)"
readonly test_root="$(mktemp -d "${TMPDIR:-/tmp}/x233-security-round3.XXXXXX")"
readonly original_home="$HOME"
readonly node_bin="$(command -v node)"
readonly pnpm_cli="$original_home/.cache/node/corepack/v1/pnpm/11.4.0/bin/pnpm.cjs"
readonly test_home="$test_root/home"
readonly nvm_node_dir="$test_home/.nvm/versions/node/v24.18.1/bin"
readonly shim_dir="$test_root/shims"
readonly mimic_dir="$original_home/.mimocode/bin"
readonly cargo_dir="$original_home/.cargo/bin"
readonly go_dir="$original_home/go/bin"
readonly pnpm_dir="$original_home/Library/pnpm"
readonly vscode_dir="/Applications/Visual Studio Code.app/Contents/Resources/app/bin"
readonly worktree_dir="$security_dir"
readonly modules_dir="$test_root/project/node_modules/.bin"
resolver_server_pid=""
trap 'if [[ -n "$resolver_server_pid" ]]; then kill "$resolver_server_pid" 2>/dev/null || true; wait "$resolver_server_pid" 2>/dev/null || true; fi; rm -rf "$test_root"' EXIT
mkdir -p "$test_home" "$shim_dir" "$test_home/.local/bin" "$nvm_node_dir" \
  "$modules_dir"
ln -s "$node_bin" "$nvm_node_dir/node"

cat > "$shim_dir/launchctl" <<'SH'
#!/bin/bash
if [[ "$1" == print ]]; then
  exit 1
fi
printf '%s\n' "$*" >> "$HOME/launchctl.calls"
SH
cat > "$shim_dir/pnpm" <<'SH'
#!/bin/bash
exec corepack pnpm@11.4.0 "$@"
SH
cat > "$shim_dir/osascript" <<'SH'
#!/bin/bash
printf '%s\n' "$*" >> "$HOME/notifications.log"
SH
chmod 700 "$shim_dir/launchctl" "$shim_dir/pnpm" "$shim_dir/osascript"

cat > "$shim_dir/corepack" <<SH
#!/bin/bash
shift
exec "$node_bin" "$pnpm_cli" "\$@"
SH
chmod 700 "$shim_dir/corepack"

login_path="$mimic_dir:$cargo_dir:$go_dir:$pnpm_dir:$vscode_dir:$original_home/.local/bin:$original_home/.bun/bin:$original_home/.nvm/versions/node/v24.18.1/bin:$worktree_dir:$modules_dir:/tmp:/private/tmp:relative/path:$test_home/missing:$mimic_dir"
printf 'export PATH=%q\n' "$login_path" > "$test_home/.zprofile"
printf 'export PATH=%q\n' "$login_path" > "$test_home/.zshrc"
test_path="$shim_dir:$test_home/.local/bin:$nvm_node_dir:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="$test_home" ZDOTDIR="$test_home" PATH="$test_path" COREPACK_HOME="$original_home/.cache/node/corepack"

"$node_bin" "$pnpm_cli" config set blockExoticSubdeps true --location global
"$security_dir/apply-intake.sh"
for setting in 'minimumReleaseAge=10080' 'strictDepBuilds=true' 'block-exotic-subdeps=true'; do
  key="${setting%%=*}"
  expected="${setting#*=}"
  actual="$(cd /tmp && pnpm config get "$key" --location global)"
  [[ "$actual" == "$expected" ]] || { printf 'Expected %s, got %s\n' "$setting" "$actual" >&2; exit 1; }
done
actual="$(cd /tmp && "$node_bin" "$pnpm_cli" config get blockExoticSubdeps --location global)"
[[ "$actual" == true ]]
"$security_dir/apply-intake.sh" --check

probe="$test_root/pnpm-probe"
probe_home="$test_root/probe-home"
mkdir -p "$probe" "$probe_home"
printf '{"name":"x233-config-probe","version":"1.0.0"}\n' > "$probe/package.json"
printf 'blockExoticSubdeps: true\n' > "$probe/pnpm-workspace.yaml"
actual="$(cd "$probe" && HOME="$probe_home" "$node_bin" "$pnpm_cli" config get blockExoticSubdeps --location project)"
[[ "$actual" == true ]]
printf 'block-exotic-subdeps: true\n' > "$probe/pnpm-workspace.yaml"
actual="$(cd "$probe" && HOME="$probe_home" "$node_bin" "$pnpm_cli" config get blockExoticSubdeps --location project)"
[[ "$actual" != true ]]

"$node_bin" "$pnpm_cli" config delete block-exotic-subdeps --location global
if "$security_dir/apply-intake.sh" --check >/dev/null 2>&1; then
  echo 'The intake check accepted a missing effective pnpm key.' >&2
  exit 1
fi
"$security_dir/apply-intake.sh" >/dev/null

# Exercise pnpm's fresh resolver against a transitive tarball URL served only
# from loopback. Each arm gets a fresh HOME, project and store.
resolver="$test_root/exotic-subdep"
mkdir -p "$resolver/direct/package" "$resolver/leaf/package" \
  "$resolver/home-true" "$resolver/home-false" \
  "$resolver/store-true" "$resolver/store-false" \
  "$resolver/project-true" "$resolver/project-false"
printf '{"name":"x233-exotic-leaf","version":"1.0.0"}\n' \
  > "$resolver/leaf/package/package.json"
tar -czf "$resolver/exotic-leaf.tgz" -C "$resolver/leaf" package
cat > "$resolver/server.py" <<'PY'
import http.server
import pathlib
import socketserver
import sys

tarball = pathlib.Path(sys.argv[1]).read_bytes()

class Handler(http.server.BaseHTTPRequestHandler):
    def do_HEAD(self):
        self.reply(send_body=False)

    def do_GET(self):
        self.reply(send_body=True)

    def reply(self, send_body):
        if self.path != "/x233-exotic-leaf.tgz":
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Length", str(len(tarball)))
        self.end_headers()
        if send_body:
            self.wfile.write(tarball)

    def log_message(self, *_args):
        pass

server = socketserver.TCPServer(("127.0.0.1", 0), Handler)
print(server.server_address[1], flush=True)
server.serve_forever()
PY
python3 "$resolver/server.py" "$resolver/exotic-leaf.tgz" \
  > "$resolver/port" 2> "$resolver/server.err" &
resolver_server_pid=$!
for _ in {1..100}; do
  [[ -s "$resolver/port" ]] && break
  sleep 0.05
done
if [[ ! -s "$resolver/port" ]]; then
  cat "$resolver/server.err" >&2
  echo 'The loopback tarball server did not start.' >&2
  exit 1
fi
resolver_port="$(cat "$resolver/port")"
cat > "$resolver/direct/package/package.json" <<EOF
{"name":"x233-direct-fixture","version":"1.0.0","dependencies":{"x233-exotic-leaf":"http://127.0.0.1:$resolver_port/x233-exotic-leaf.tgz"}}
EOF
tar -czf "$resolver/direct-fixture.tgz" -C "$resolver/direct" package
for setting in true false; do
  printf '{"name":"x233-resolver-fixture-%s","version":"1.0.0","dependencies":{"x233-direct-fixture":"file:%s"}}\n' \
    "$setting" "$resolver/direct-fixture.tgz" \
    > "$resolver/project-$setting/package.json"
  mkdir -p "$resolver/corepack-$setting"
  HOME="$resolver/home-$setting" COREPACK_HOME="$resolver/corepack-$setting" \
    PNPM_CONFIG_UPDATE_NOTIFIER=false \
    "$node_bin" "$pnpm_cli" config set block-exotic-subdeps "$setting" --location global
  HOME="$resolver/home-$setting" COREPACK_HOME="$resolver/corepack-$setting" \
    PNPM_CONFIG_UPDATE_NOTIFIER=false \
    "$node_bin" "$pnpm_cli" config set update-notifier false --location global
done

[[ ! -e "$resolver/project-true/pnpm-lock.yaml" ]]
if (cd "$resolver/project-true" && HOME="$resolver/home-true" \
  COREPACK_HOME="$resolver/corepack-true" \
  PNPM_CONFIG_UPDATE_NOTIFIER=false \
  "$node_bin" "$pnpm_cli" install --store-dir "$resolver/store-true" \
    --registry="http://127.0.0.1:$resolver_port/registry/" --reporter append-only) \
    > "$resolver/enabled.out" 2>&1; then
  cat "$resolver/enabled.out" >&2
  echo 'Fresh resolution accepted an exotic transitive tarball with block-exotic-subdeps=true.' >&2
  exit 1
fi
if ! grep -Fq '[ERR_PNPM_EXOTIC_SUBDEP]' "$resolver/enabled.out"; then
  cat "$resolver/enabled.out" >&2
  echo 'Fresh resolution failed without pnpm error code ERR_PNPM_EXOTIC_SUBDEP.' >&2
  exit 1
fi
if [[ -e "$resolver/project-true/pnpm-lock.yaml" ]]; then
  echo 'The enabled resolver probe unexpectedly reused or wrote a lockfile.' >&2
  exit 1
fi

(cd "$resolver/project-false" && HOME="$resolver/home-false" \
  COREPACK_HOME="$resolver/corepack-false" \
  PNPM_CONFIG_UPDATE_NOTIFIER=false \
  "$node_bin" "$pnpm_cli" install --store-dir "$resolver/store-false" \
    --registry="http://127.0.0.1:$resolver_port/registry/" --reporter append-only) \
    > "$resolver/disabled.out" 2>&1
if grep -Fq '[ERR_PNPM_EXOTIC_SUBDEP]' "$resolver/disabled.out"; then
  cat "$resolver/disabled.out" >&2
  echo 'The false-setting control unexpectedly raised ERR_PNPM_EXOTIC_SUBDEP.' >&2
  exit 1
fi
[[ -d "$resolver/project-false/node_modules/x233-direct-fixture" ]]
find "$resolver/project-false/node_modules/.pnpm" -maxdepth 1 \
  -type d -name 'x233-exotic-leaf@*' -print -quit | grep -Fq x233-exotic-leaf@

"$security_dir/install-digest.sh"
installed="$test_home/Library/Application Support/kb-security-digest/bin/digest.sh"
plist="$test_home/Library/LaunchAgents/com.kblabs.security-digest.plist"
installed_path="$(plutil -extract EnvironmentVariables.PATH raw -o - "$plist")"
plist_script="$(plutil -extract ProgramArguments.1 raw -o - "$plist")"
run_at_load="$(plutil -extract RunAtLoad raw -o - "$plist")"
if [[ "$run_at_load" != true ]]; then
  printf 'Expected LaunchAgent RunAtLoad=true, got %s\n' "$run_at_load" >&2
  exit 1
fi
[[ "$(plutil -extract StartCalendarInterval.Hour raw -o - "$plist")" == 9 ]]
[[ "$(plutil -extract StartCalendarInterval.Minute raw -o - "$plist")" == 0 ]]
[[ "$(stat -f '%Lp' "$test_home/Library/Application Support/kb-security-digest/bin")" == 700 ]]
expected_path="$mimic_dir:$cargo_dir:$go_dir:$pnpm_dir:$vscode_dir:$original_home/.local/bin:$original_home/.bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
if [[ "$installed_path" != "$expected_path" ]]; then
  printf 'Expected generated PATH %s, got %s\n' "$expected_path" "$installed_path" >&2
  exit 1
fi
[[ "$plist_script" == "$installed" ]]
[[ "$plist_script" == "$test_home/Library/Application Support/kb-security-digest/bin/digest.sh" ]]
cmp -s "$security_dir/digest.sh" "$installed"
mutated_plist="$test_root/mutated.plist"
cp "$plist" "$mutated_plist"
plutil -replace EnvironmentVariables.PATH -string '/usr/bin:/bin:/usr/sbin:/sbin' "$mutated_plist"
mutated_path="$(plutil -extract EnvironmentVariables.PATH raw -o - "$mutated_plist")"
if [[ "$mutated_path" == "$installed_path" ]]; then
  echo 'The PATH assertion accepted a plist with generated directories removed.' >&2
  exit 1
fi
plutil -replace ProgramArguments.1 -string "$security_dir/digest.sh" "$mutated_plist"
mutated_script="$(plutil -extract ProgramArguments.1 raw -o - "$mutated_plist")"
if [[ "$mutated_script" == "$installed" ]]; then
  echo 'The plist target assertion accepted the worktree script path.' >&2
  exit 1
fi
grep -F "gui/$(id -u)" "$test_home/launchctl.calls" >/dev/null
[[ -s "$test_home/Library/Application Support/kb-security-digest/current.snapshot" ]]
snapshot_before="$(shasum -a 256 "$test_home/Library/Application Support/kb-security-digest/current.snapshot" | awk '{print $1}')"
"$security_dir/install-digest.sh" >/dev/null
snapshot_after="$(shasum -a 256 "$test_home/Library/Application Support/kb-security-digest/current.snapshot" | awk '{print $1}')"
[[ "$snapshot_before" == "$snapshot_after" ]]

printf 'planted\n' > "$test_home/.zshrc"
env -i HOME="$test_home" PATH="$installed_path" "$installed"
IFS=: read -r -a generated_dirs <<< "$installed_path"
for directory in "${generated_dirs[@]}"; do
  if ! awk -F '\t' -v path="$directory" '$1 == "path-dir" && $2 == path { found=1 } END { exit !found }' \
    "$test_home/Library/Application Support/kb-security-digest/current.snapshot"; then
    printf 'Digest snapshot did not record PATH directory %s\n' "$directory" >&2
    exit 1
  fi
  scanned_file="$(find -L "$directory" -maxdepth 1 -type f -perm -111 -print -quit 2>/dev/null)"
  if [[ -n "$scanned_file" ]]; then
    if ! awk -F '\t' -v path="$scanned_file" '$1 == "executable" && $2 == path { found=1 } END { exit !found }' \
      "$test_home/Library/Application Support/kb-security-digest/current.snapshot"; then
      printf 'Digest snapshot did not record executable %s from PATH directory %s\n' "$scanned_file" "$directory" >&2
      exit 1
    fi
  fi
done
grep -E 'added shell .*\.zshrc sha256:[[:xdigit:]]{12}$' "$test_home/Library/Application Support/kb-security-digest/changes.log" >/dev/null
printf 'notification probe\n' >> "$test_home/.profile"
env -i HOME="$test_home" PATH="$shim_dir:$installed_path" "$installed"
grep -E 'Changed: .*shell' "$test_home/notifications.log" >/dev/null
grep -E 'added shell .*\.profile sha256:[[:xdigit:]]{12}$' "$test_home/Library/Application Support/kb-security-digest/changes.log" >/dev/null
grep -E 'changed categories: .*shell$' "$test_home/Library/Application Support/kb-security-digest/changes.log" >/dev/null
sed '/changed categories:/d' "$test_home/Library/Application Support/kb-security-digest/changes.log" > "$test_root/mutated-changes.log"
if grep -E 'changed categories: .*shell$' "$test_root/mutated-changes.log" >/dev/null; then
  echo 'The digest category assertion accepted a log without the changed category.' >&2
  exit 1
fi

printf 'Round 4 security checks passed.\n'
