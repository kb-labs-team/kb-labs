# Local candidate registry

Run a persistent Verdaccio on loopback for installing KB Labs candidates on
this Mac. The `@kb-labs/*` scope is stored locally and has no npmjs uplink;
other packages use npmjs as their uplink. Published versions cannot be
unpublished through this registry.

Set storage outside any checkout and choose a free loopback port:

```sh
export KB_LOCAL_REGISTRY_STORAGE="$HOME/Library/Application Support/KB Labs/Verdaccio"
export KB_LOCAL_REGISTRY_PORT=4873
docker compose --project-name kb-labs-local-registry \
  --file ops/local-registry/compose.yaml up --detach --wait
```

Register a Verdaccio user once; npm stores its token in the user's protected
npm configuration. Do not pass the token as a command argument or print it:

```sh
npm adduser --registry "http://127.0.0.1:$KB_LOCAL_REGISTRY_PORT" --auth-type=legacy
```

Download the immutable artifact from its hosted `release-build-candidate.yml`
run into `.kb/release/bundle`. Deliver it with the same command used by the
npm delivery workflow. Set `CANDIDATE_ID`, `COMMIT`, `VERSION`, and
`EXPECTED_DIGEST` from the hosted run summary. The summary also shows the
Actions artifact archive digest; GitHub verifies that archive when the delivery
workflow downloads it:

```sh
REGISTRY="http://127.0.0.1:$KB_LOCAL_REGISTRY_PORT"
FLOW=platform
kb release artifact publish \
  --flow "$FLOW" \
  --bundle-dir .kb/release/bundle \
  --expected-digest "$EXPECTED_DIGEST" \
  --candidate-id "$CANDIDATE_ID" \
  --commit "$COMMIT" \
  --version "$VERSION" \
  --registry "$REGISTRY" \
  --json
```

The digest and identity values come from the hosted run summary, outside the
downloaded bundle. The command validates those trusted values against
provenance, checks bundle indexes and canonical modes, validates the exact file
set and tarball filenames, and checks each tarball digest before publishing.
Credentials come from npm's protected user configuration (set up by `npm
adduser`) or `NPM_TOKEN` / `NODE_AUTH_TOKEN`; the token is never written into
the bundle or command line.

For an isolated install, choose an install root under the temporary HOME and
select a free Gateway port between 4500 and 9900 in steps of 100. The version
comes from the candidate's `provenance.json`:

```sh
BUNDLE=.kb/release/bundle
VERSION="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version)' "$BUNDLE/provenance.json")"
PLATFORM_ROOT="$HOME/kb-canary"
REGISTRY="http://127.0.0.1:$KB_LOCAL_REGISTRY_PORT"
GATEWAY_URL=http://127.0.0.1:4800

kb-create plan --index "$BUNDLE/release-index.json" \
  --platform-version "$VERSION" --service-profile default \
  --registry "$REGISTRY" --platform-root "$PLATFORM_ROOT" \
  --gateway-url "$GATEWAY_URL" --json
```

Confirm every planned service port is free, then install with those same
request fields:

```sh
kb-create install --index "$BUNDLE/release-index.json" \
  --platform-version "$VERSION" --service-profile default \
  --registry "$REGISTRY" --platform-root "$PLATFORM_ROOT" \
  --gateway-url "$GATEWAY_URL" --json
kb --version
```

To update, download and deliver the newer candidate to Verdaccio, set
`BUNDLE_2` to its bundle path, and read `VERSION_2` from its
`provenance.json` as above. Run the update with the same registry, root, and
Gateway URL. Capture the snapshot ID from its JSON result, restart, and verify
the new `kb --version`:

```sh
kb-create update --index "$BUNDLE_2/release-index.json" \
  --platform-version "$VERSION_2" --service-profile default \
  --registry "$REGISTRY" --platform-root "$PLATFORM_ROOT" \
  --gateway-url "$GATEWAY_URL" --json
kb-create restart --platform-root "$PLATFORM_ROOT"
kb --version
```

If the new root degrades, restore the recorded snapshot:

```sh
kb-create rollback --platform-root "$PLATFORM_ROOT" \
  --snapshot "$SNAPSHOT" --yes --registry "$REGISTRY" --json
kb --version
```

Keep the Verdaccio storage directory with the Mac's other protected platform
state. Do not put its auth file inside a repository checkout.
