#!/usr/bin/env bash

# Journey runner toolchain image lifecycle. The tag is derived by
# e2e/journey/journey_resources.py from the `AS toolchain` stage of
# e2e/journey/Dockerfile.runner and the staged Playwright version; this script
# builds that tag once, reclaims older tags it created (identified by the
# journey toolchain image label, never by name matching), and exports the
# reference for the compose runner build. Source this file from the owning
# journey entry (e2e/journey/run.sh).

journey_toolchain_ensure() {
  local root="$1" policy_file contract toolchain_image toolchain_label image_argument node_base_image_argument node_base_image
  policy_file="$root/tools/clikit/toolchain/node_policy_gen.json"
  if ! contract="$(python3 "$root/e2e/journey/journey_resources.py" --toolchain-contract)"; then
    return 1
  fi
  toolchain_image="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["imageReference"])' <<< "$contract")"
  toolchain_label="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["imageLabel"])' <<< "$contract")"
  image_argument="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["imageArgument"])' <<< "$contract")"
  node_base_image_argument="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["nodeBaseImageArgument"])' "$policy_file")"
  if ! node_base_image="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["nodeBaseImage"])' "$policy_file")"; then
    printf 'Journey runner toolchain needs generated Node policy %q. Next: (cd %q/tools/clikit && go generate ./toolchain)\n' \
      "$policy_file" "$root" >&2
    return 1
  fi
  if [[ -z "$toolchain_image" || -z "$toolchain_label" || -z "$image_argument" || -z "$node_base_image_argument" || -z "$node_base_image" ]]; then
    echo "Journey runner toolchain derivation returned an incomplete contract. Next: python3 e2e/journey/journey_resources.py --toolchain-contract" >&2
    return 1
  fi
  local -a build_command=(docker build --target toolchain -t "$toolchain_image"
    --label "${toolchain_label}=${toolchain_image#*:}"
    --build-arg "$image_argument=$node_base_image"
    --build-arg "$node_base_image_argument=$node_base_image"
    -f e2e/journey/Dockerfile.runner .)
  if [[ -z "$(docker images -q "$toolchain_image")" ]]; then
    if ! (cd "$root" && "${build_command[@]}"); then
      printf 'Journey runner toolchain image %s could not be built with %s=%s. Next: (cd %q &&' \
        "$toolchain_image" "$image_argument" "$node_base_image" "$root" >&2
      printf ' %q' "${build_command[@]}" >&2
      printf ')\n' >&2
      return 1
    fi
    echo "==> journey runner toolchain $toolchain_image built"
  else
    echo "==> journey runner toolchain $toolchain_image reused"
  fi
  journey_toolchain_reclaim "$toolchain_label" "$toolchain_image"
  export "$image_argument=$toolchain_image"
  export "$node_base_image_argument=$node_base_image"
}

journey_toolchain_reclaim() {
  local label="$1" keep_image="$2" keep_id image_id reference
  keep_id="$(docker images -q "$keep_image" || true)"
  while read -r image_id reference; do
    [[ -n "$image_id" && "$image_id" != "$keep_id" ]] || continue
    if ! docker image rm -f "$image_id"; then
      echo "WARNING: could not remove previous journey runner toolchain image $reference. Next: docker image rm -f $image_id" >&2
    fi
  done < <(docker images --filter "label=$label" --format '{{.ID}} {{.Repository}}:{{.Tag}}')
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "Source e2e/journey/runner-toolchain.sh from a journey entry." >&2
  exit 2
fi
