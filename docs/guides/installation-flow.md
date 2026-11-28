# KB Labs installer lifecycle

`kb-create` uses one V2 installer contract. A person can run the interactive
`install` flow; CI and agents can apply a request directly. Both resolve a
sealed release index before changing the installation.

The installer supports Linux and macOS. A Windows request fails during
planning with catalogued `KB_INSTALL_UNSUPPORTED_PLATFORM` before downloading
an artifact, and does not mutate the installation.

## Interactive install

Use the interactive command to choose a scenario and apply its plan:

```bash
kb-create install \
  --index release-index.json \
  --platform-root /srv/kb-platform
```

The command presents the install choices, shows the selected platform version
and artifact count, applies the plan, and reports the result. `--platform-root`
selects where the platform is installed.

## Plan and apply a request

Automation can use the same resolver without interactive prompts. Plan first
to inspect the exact versions and artifacts:

```bash
kb-create plan \
  --index release-index.json \
  --platform-root /srv/kb-platform \
  --service-profile default \
  --scenario commit \
  --json
```

Apply the same request when its plan is ready:

```bash
kb-create apply \
  --index release-index.json \
  --platform-root /srv/kb-platform \
  --service-profile default \
  --scenario commit \
  --json
```

Use `--input request.json` when a request file is the source of configuration.
The request may select a platform channel, plugins, adapters, provider, and
compatibility policy. Use `kb-create plan --help` to see the supported request
flags. `--secret-env requirement.id=ENV` passes a secret by environment
variable reference; the secret value is not written into the request or
receipt.
For a service transport override, use `serviceTransportURLs` keyed by a
service ID declared in the selected platform manifest. The resolver emits a
URL-only override at that service's transport endpoint; the config does not
replace `platform.adapterOptions` or accept arbitrary paths. The Gateway URL
is derived from `gatewayUrl` and cannot be overridden through this field.

For a reviewed, repeatable plan, pass a separate declarative config to both
commands. Config values use requirement IDs from the selected release catalog;
they do not accept arbitrary config paths or patch operations. Use the typed
`marketplaceSources` fields for Registry and npm URLs and environment-variable
references. For secret options nested inside a config value, use exactly the
`${ENV_NAME}` reference declared by that artifact's manifest.

`request.json`:

```json
{
  "schema": "kb.create/v2",
  "platform": { "channel": "stable" },
  "platformRoot": "/srv/kb-platform",
  "gatewayUrl": "http://127.0.0.1:45100"
}
```

`install-config.json`:

```json
{
  "marketplaceSources": {
    "registryUrl": "https://registry.example.test/api/v1/marketplace-registry",
    "signingPublicKeyEnv": "KB_REGISTRY_PUBLIC_KEY",
    "registryTokenEnv": "KB_REGISTRY_TOKEN",
    "npmUrl": "https://registry.npmjs.org"
  },
  "values": {
    "gateway.access.mode": "local"
  }
}
```

Write and review the normalized plan, then apply that output with the same
config and release index:

```bash
kb-create plan --index release-index.json --input request.json \
  --config install-config.json --json > plan.json
kb-create apply --index release-index.json --input plan.json \
  --config install-config.json --json
```

When `apply` reads a saved CLI plan, it uses only `plan.request` and resolves
the plan again against the supplied release index. Derived artifacts, config
patches, and paths in the saved JSON are not treated as instructions. Secret
values remain in the environment or secret store; requests and config files
contain references only.

## Verify and maintain the installation

```bash
kb-create status --platform-root /srv/kb-platform --json
kb-create doctor --platform-root /srv/kb-platform --json
```

Status reports the active receipt and host state. Doctor reports unmet
manifest requirements with their owner, path, and remediation hint. For
updates, recovery, and removal, use `kb-create update`, `rollback`, and
`uninstall` with the same platform root.

The release index pins artifact versions, hashes, compatibility, and the
service graph. Planning resolves that data before apply mutates installed files.
