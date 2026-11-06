# KB Labs release process

KB Labs releases the SDK, platform and binaries as one flow with one version (`platform`); separate SDK versioning may return later. A release is only promotable when its immutable artifacts, launcher index and required smoke are all verified; publishing a tag is not itself a stable release.

| Stream | Tag | Publishes | Required order |
| --- | --- | --- | --- |
| Platform (includes `@kb-labs/sdk` and `@kb-labs/platform-client`) | `platform-vX.Y.Z` | SDK, platform and service npm tarballs with V2 launcher manifests, binaries and one sealed release index | one candidate, one version |
| Binaries | `vX.Y.Z-binaries` | the binary assets and checksums referenced by that candidate index | as part of the same candidate |

There is no separate `sdk` flow: `sdk-vX.Y.Z` tags are no longer created
(existing ones stay). The release flow stamps one version across the first
platform, SDK and binary release. The index records each staged version and
its exact compatibility relations; the catalog's compatibility matrix is the
only gate.

## Candidate gates

`release-build-candidate.yml` first runs the installer and user-scenario
journey contract. The candidate cannot build while any declared scenario is
marked NOT COVERED or while a journey fails. The contract and current gaps are
listed in the [release journey coverage page](/guides/release-journey-coverage).

The workflow engine creates a release intent and dispatches the candidate
builder. The candidate workflow creates the immutable bundle; the delivery
workflow only verifies and publishes that bundle. For a platform candidate:

1. the engine runs checks, approval and creates a release intent;
2. `release-build-candidate.yml` builds packages and Go binaries once, stages
   exact npm tarballs and generates the binary manifest from GoReleaser's
   checksums;
3. the same workflow seals `.kb/release/release-index.json`, uploads one
   immutable candidate bundle, and exposes its trusted identity and semantic
   digest in the run summary outside the bundle;
4. `release-deliver-candidate.yml` downloads the bundle, verifies the GitHub
   artifact archive digest, and checks the extracted bytes against the trusted
   summary values;
5. it publishes the exact npm tarballs and binary assets to the requested
   channel;
6. it runs a clean `kb-create apply` against the public candidate and asserts
   that `kb.config.jsonc`, `devservices.yaml` and the plugin workflow are
   functional.

Binary assets are part of the same candidate bundle as the platform index.
There is no independent binary release workflow or separate binary promotion
path. The workflow engine invokes delivery for `canary` or `stable` only after
the candidate identity and smoke evidence are valid.

The delivery workflow's post-publish smoke remains a bounded
installer/package/config/workflow check. Before candidate build, the release
journey gate above exercises the declared user scenarios, including service
startup; a green post-publish smoke does not replace that matrix.

The first release records exact staged platform, SDK and binary versions and
their explicit relations in the compatibility matrix. Independent versions
later are a release-flow data change; the installer, catalog and index
preparer continue to use the matrix as the only compatibility gate.

## Promotion checklist

1. Confirm the candidate bundle and post-publish smoke are successful.
2. Approve the `release-promote` workflow-engine transition for `stable`.
3. Confirm delivery used the same candidate ID and bundle digest.
4. Perform the stable clean-install acceptance run using the released binary
   and stable index pointer; retain its log/dossier with the release evidence.

The stable pointer is mutable convenience metadata. The fetched index remains immutable and hash-verified by the consumer.

## Failure handling

- **Index sealing fails:** a selected package is missing a valid V2 manifest or the manifest contradicts the platform topology. Fix the package contract; do not hand-edit the index.
- **Registry binding fails:** npm did not serve the tarball bytes staged for the candidate. Treat this as a delivery failure, not a retryable installer warning.
- **Launcher smoke fails:** inspect its `.kb/logs/` and diagnostic dossier. Fix the resolver, manifest or generated config; do not relax the smoke.
- **A service suite fails:** use the owning E2E shard and its scenario report. Do not make the candidate smoke start every service to mask shard ownership.
- **Stable install fails:** freeze promotion, retain the immutable index and dossier, then repair and publish a new candidate. Never overwrite a released index.

Local preparation through `kb workflow:run` creates only release intent and
approval state. Candidate build, bundle creation, delivery and public-byte
verification happen on controlled GitHub runners.
