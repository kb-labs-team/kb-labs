# kb-labs-platform Helm chart

Deploys the KB Labs platform's backend units — `gateway`, `rest-api`,
`workflow`, `marketplace`, `marketplace-registry`, `state-daemon`, `mcp`,
`studio` — from the images built in
`docs/plans/2026-07-31-cloud-deployment-overhaul.md` Phase 2. See
[ADR-0037](../../../docs/adr/0037-containers-are-canonical-cloud-delivery.md)
for the design this chart implements.

## Install

```sh
helm install my-platform . --set image.tag=<release-version>
```

`image.tag` is required — the chart refuses to render without it (never
defaults to `latest`, see `docs/deployment/docker-build-hygiene.md`).

The gateway, REST API, and marketplace-registry also require the same
`GATEWAY_INTERNAL_SECRET` in every mode. Create a Kubernetes Secret and pass
its name to the chart; rendering fails if the name is omitted:

```sh
kubectl create secret generic kb-platform-internal --from-literal=GATEWAY_INTERNAL_SECRET="$(openssl rand -hex 32)"
helm install my-platform . --set image.tag=<release-version> --set internalSecretSecretName=kb-platform-internal
```

## Composition

The chart always mounts a chart-owned config overlay that sets
`platform.deployment.topology: k8s` and secured Gateway access. The runtime
merges this file over the image's baked cloud composition. Users cannot
override topology or disable authentication in a k8s render.

Declare adapters/plugins in `values.yaml`'s `config` field, and secrets via
`secretRefs` (names of Kubernetes Secrets you create yourself — this chart
never handles secret values directly):

```yaml
image:
  tag: "2.114.0"

config:
  platform:
    adapters:
      cache: "@kb-labs/adapters-redis"
      llm: "@kb-labs/adapters-openai"
    adapterOptions:
      llm:
        apiKey: "${OPENAI_API_KEY}"

secretRefs:
  - my-platform-secrets   # must contain OPENAI_API_KEY, GATEWAY_JWT_SECRET, etc.

internalSecretSecretName: kb-platform-internal # must contain GATEWAY_INTERNAL_SECRET
```

`${VAR}` placeholders in `config` are **not** touched by Helm — they're
resolved by the running process at boot
(`core/runtime/src/config-interpolation.ts`), from the env `secretRefs`
wires in. Validate a composition before shipping it:

```sh
kb-create validate my-kb.config.json --lock my-marketplace.lock
```

The baked image composition supplies service and adapter defaults. `config`
overrides those values; `marketplaceLock` is mounted only when provided.

## Guardrails enforced at render time

- **`services.workflow.replicas` cannot exceed 1.** `JobBroker`/`CronScheduler`
  run in-process; a second replica double-fires every scheduled job. Setting
  it higher fails `helm template`/`helm install`, not a silent bad deploy.
- **`image.tag` is required.** Unset fails the render with a clear message.
- **Cloud authentication is mandatory.** A local access mode or
  `gateway.auth.enabled: false` fails with `KB_DEPLOYMENT_AUTH_REQUIRED`.
- **`marketplace-registry` is optional** and disabled by default. Enabling it
  also starts its `state-daemon` readiness dependency.
- **`marketplace-registry` waits for `state-daemon`** via an initContainer
  (real runtime dependency — `services/marketplace-registry/README.md:46`).

Disable any unit you don't need with `--set services.<name>.enabled=false`
(e.g. `studio`, `mcp`) — no fork required.

## Verified, not yet live-tested

`helm lint` and `helm template` pass, and the guardrails above are confirmed
by rendering with bad input and checking the error. **Not yet run as a real
`helm install` against a live cluster** — no `kind`/`k3d` cluster was
available when this chart was written. Before relying on it in production,
run a real install against a throwaway cluster and confirm pods actually
reach Ready.
