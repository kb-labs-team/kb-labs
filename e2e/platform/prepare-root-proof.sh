#!/usr/bin/env sh
set -eu

platform_root=/workspace/kb-e2e
project_root=/workspace/kb-e2e-root-proof
plugin_id=@kb-labs/e2e-analytics-emitter
version=1.0.0
store_root="$platform_root/state/home/store"
entry_key='@kb-labs+e2e-analytics-emitter@1.0.0'
entry_root="$store_root/entries/$entry_key"
plugin_source="$entry_root/node_modules/$plugin_id"
plugin_target="$project_root/plugins/e2e-analytics-emitter"

pin=$(jq -ce --arg plugin "$plugin_id" --arg version "$version" \
  '.plugins[$plugin] | select(.source == "marketplace" and .package == $plugin and .version == $version and (.integrity | type == "string" and length > 0))' \
  "$platform_root/current/.kb/marketplace.lock")
integrity=$(printf '%s' "$pin" | jq -r '.integrity')
if ! jq -e --arg plugin "$plugin_id" --arg version "$version" --arg integrity "$integrity" \
  '.name == $plugin and .version == $version and .integrity == $integrity' "$entry_root/entry.json" >/dev/null; then
  echo "ERROR: platform Marketplace pin does not match its shared-store entry" >&2
  exit 1
fi
if [ ! -d "$plugin_source" ]; then
  echo "ERROR: platform-scoped analytics fixture is missing from the shared store" >&2
  exit 1
fi

rm -rf "$project_root"
mkdir -p "$plugin_target" "$project_root/.kb"
cp -R "$plugin_source/." "$plugin_target/"
cat > "$project_root/.kb/marketplace.lock" <<'EOF'
{"schema":"kb.marketplace/3","plugins":{"@kb-labs/e2e-analytics-emitter":{"source":"local","link":"plugins/e2e-analytics-emitter","enabled":true}}}
EOF
