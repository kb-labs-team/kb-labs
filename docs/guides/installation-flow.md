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
