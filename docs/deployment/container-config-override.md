# Production composition contract

> **Historical container-delivery proposal.** It references pre-V2 launcher
> commands (`deployment export`, `provision`) that are not public operations
> today. The active installer contract is the sealed release index described
> in [the launcher lifecycle](../guides/installation-flow.md).

KB Labs release images contain a generated default config at
`.kb/kb.config.json`, including `platform.deployment.topology: cloud`, secured
Gateway access, and the secured-install administrator default. Compose uses
that config directly. Helm mounts a separate `.kb/kb.config.override.json`
layer so the image config remains intact while the chart sets k8s topology and
secured Gateway access. The release image config is generated once by
`tools/release/generate-platform-image-default.mjs` during image preparation.
The preview Compose stack has no Marketplace source configured; x129 owns the `marketplace.sources` configuration.

Build a user-owned image with `kb-create deployment export`; its generated
Dockerfile copies an explicit config and lock, then runs `kb-create provision`
at image build time. The resulting image is the artifact deployed to Compose
or Kubernetes.

```text
local kb-create installation
  -> explicit config + portable lock
  -> user-owned derived image
  -> VPS / Kubernetes
```

`kb-create` writes `platform.deployment.topology: local` into the generated
local composition. The release image and Helm chart declare their own
topologies through their delivery-owned config.

Every `${VAR}` in an exported production config must be supplied as an image
runtime environment variable or Secret. `NODE_ENV=production` makes an
unresolved variable fatal at boot.
