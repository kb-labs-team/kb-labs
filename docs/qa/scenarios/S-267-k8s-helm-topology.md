---
id: S-267
title: Kubernetes — render the secured default Helm topology
persona: platform-team
area: deployment
priority: P1
status: active
release: false
modes: [secured]
surfaces: [cli, api]
---

## Goal

A platform operator renders the Helm chart into a secured Kubernetes service set whose default images match the published release and which does not deploy the optional Registry backend.

## Prerequisites

- [ ] Helm is available and the chart and image-publish workflow are from the same checkout.
- [ ] A release tag and the name of a pre-created internal-secret Secret are available for the render.

## Steps

| # | Action | Expected |
|---|---|---|
| S-267.1 | Run `helm template kb-labs-platform deploy/helm/kb-labs-platform --set image.tag=<release-tag> --set internalSecretSecretName=<secret-name>`. | The chart renders successfully with Gateway, REST API, workflow, state-daemon, marketplace, MCP, and Studio resources; marketplace-registry has no rendered Deployment or Service by default. |
| S-267.2 | Compare the default-enabled rendered service image identities with the image identities published by `.github/workflows/publish-platform-images.yml`. | The rendered image set exactly equals the published set restricted to services enabled by the chart defaults; the optional marketplace-registry image remains publishable but is absent from the default render. |
| S-267.3 | Inspect the rendered configuration for every service. | Each service receives `platform.deployment.topology: k8s`; Gateway configuration cannot render `gateway.access.mode: local` or `gateway.auth.enabled: false`. |
| S-267.4 | Render once with `gateway.access.mode=local` and once with `gateway.auth.enabled=false`. | Both renders fail with the catalogued `KB_DEPLOYMENT_AUTH_REQUIRED` error. |
| S-267.5 | Render with `services.workflow.replicas=2`. | Rendering fails with the workflow replicas guard. |
