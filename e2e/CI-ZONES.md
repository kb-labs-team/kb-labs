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
