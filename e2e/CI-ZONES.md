# E2E zones

Each E2E domain owns a `ci.zone.json` next to its suite. The manifest answers
one question: which source paths require this suite to run?

```json
{
  "zone": "mind",
  "watch": ["plugins/mind/**", "e2e/mind/**"],
  "suites": ["e2e-mind"]
}
```

`scripts/ci/resolve-e2e-zones.mjs` evaluates the complete diff from the PR's
base SHA to the merge commit tested by CI. It uses Git rename detection and
matches both the old and new path of a move. A rename from an owned path to an
unowned path selects the old zone and produces a PR warning.

`e2e/_global/ci.zone.json` owns shared infrastructure. Its matches select every
zone. Add a path there only when it can affect every platform E2E suite.

The CI test-plan comment is report-only while coverage is audited. A warning for
an unowned production path is actionable: add the path to the zone that tests
it, or add a new E2E zone.

## Compose overlays for platform E2E

Local platform E2E uses the shared base and the platform fixture overlay:

```bash
docker compose -f e2e/docker-compose.yml -f e2e/docker-compose.platform.yml up -d --no-build platform
```

This keeps the base's `verdaccio-storage` named volume. Hosted Docker E2E adds
`e2e/docker-compose.ci.yml`, optionally `e2e/docker-compose.fast-ci.yml`, and
then the platform overlay, followed by any suite-specific overlay. Local startup also requires the candidate binaries to be staged by the E2E platform
build step. Browser E2E adds the platform overlay to its supplied compose files. The platform overlay owns the candidate
binary origin and readiness marker check.

The full installer Journey uses `e2e/docker-compose.yml` with
`e2e/journey/docker-compose.yml`; its origin serves the release bundle. The Go
launcher uses its base, CI, and launcher compose files and does not use the
platform overlay.
