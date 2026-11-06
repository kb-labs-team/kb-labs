# e2e/delivery — cross-module end-to-end for kb-deploy apply

Full real-stack exercise of the ADR-0014 delivery plane:

```
┌─ host (go test) ──────────────────────────────────────────────────────┐
│  bin/kb-deploy-host apply --config …/deploy.yaml                      │
│                                                                        │
│        │ SSH 127.0.0.1:2201,2202                                       │
│        ▼                                                               │
│  ┌────────────────┐   ┌────────────────┐    ┌─────────────────────┐   │
│  │  target-1      │   │  target-2      │    │  verdaccio :4873    │   │
│  │  kb-create     │   │  kb-create     │◀──▶│  @kb-labs/gateway-  │   │
│  │  kb-dev (stub) │   │  kb-dev (stub) │    │    test@1.0.0       │   │
│  │  openssh       │   │  openssh       │    │  @kb-labs/adapter-  │   │
│  │ supported Node │   │ supported Node │    │    noop@1.0.0       │   │
│  │    + pnpm      │   │    + pnpm      │    │                     │   │
│  └────────────────┘   └────────────────┘    └─────────────────────┘   │
│          └─ docker-compose (kb-net) ───────────────────────┘           │
└────────────────────────────────────────────────────────────────────────┘
```

The test validates that apply really works against a real `openssh-server`
and real `pnpm install`, not a fake Runner. Catches bugs unit and
integration tests physically cannot — shell quoting, pnpm resolution,
symlink atomicity on overlayfs, real SSH session management, cross-module
release-id agreement.

## Running

Requires Docker Compose v2 (`docker compose`) or standalone `docker-compose`,
Go 1.24, and Node.js matching the policy in the root `package.json`
`engines.node` field.

```sh
# From this directory:
./scripts/run.sh
```

The invoker reads the required major from the root manifest, passes it to
Compose as `KB_NODE_MAJOR`, and runs the opt-in Go test. First run builds
images (~1 min); warm runs are ~10s. A plain `go test ./...` at the repo root
still skips this test. To inspect the resolved build args without building,
run `./scripts/run.sh config --format json`.

`KEEP_STACK=1` leaves the compose stack up after the test for manual
inspection. Tear down with `docker compose down -v` (or `docker-compose down -v`)
from this dir.

## What is stubbed

- **`kb-dev`** on target is a no-op shell script (`fixtures/kb-dev-stub.sh`).
  Real kb-dev lifecycle (service start, health probe, watchdog) is a
  follow-up e2e scenario — it needs bootstrap `devservices.yaml` on target.
  The present test covers delivery-specific paths (SSH, pnpm, symlink
  layout, release.json, lock).
- **Stub service** (`@kb-labs/gateway-test`) is a 10-line Node HTTP server
  unrelated to the real gateway. Keeps the fixture hermetic.
- **Stub adapter** (`@kb-labs/adapter-noop`) is a no-op export — exercises
  the pnpm install + release.json path without pulling real adapter deps.

## What is real

- Real openssh-server on each target container, key-only auth.
- Real pnpm installing from real Verdaccio with a real lockfile.
- Real `kb-create` binary (cross-compiled for linux/amd64 from the
  monorepo) — same artifact that would ship to a customer.
- Real `kb-deploy` binary invoked as a subprocess from the Go test.
- Real symlink rename on Docker overlayfs.

## Troubleshooting

- **"dial 127.0.0.1:XX: connection refused"** — a compose service is not up
  or a host port is in use. Run `docker compose ps` and `docker compose logs
  target-1` (or use standalone `docker-compose`) from this dir.
- **"ERR_PNPM_FETCH_404"** — fixtures did not publish. Re-run
  `bash scripts/publish-fixtures.sh` manually and check the Verdaccio page
  at http://localhost:4873.
- **"ssh: handshake failed"** — the fixture SSH keypair mismatches. The
  authoritative copy is `keys/id_rsa{,.pub}` under this dir; never
  regenerate without also rebuilding the target image.

## Files

```
.
├── apply_test.go                 # the Go test
├── go.mod                        # separate module (golang.org/x/crypto only)
├── Dockerfile.target             # Ubuntu + SSH + Node + binaries
├── docker-compose.yml            # Verdaccio + 2 targets
├── bin/                          # built by scripts/build-binaries.sh (gitignored)
├── keys/id_rsa{,.pub}            # e2e-only keypair (public in repo; target trusts only this key)
├── fixtures/
│   ├── kb-dev-stub.sh
│   ├── packages/
│   │   ├── gateway-test/         # minimal Node service
│   │   └── adapter-noop/         # no-op stub adapter
│   └── verdaccio/config.yaml
└── scripts/
    ├── build-binaries.sh         # cross-compiles kb-create (linux/amd64) + native kb-deploy
    └── publish-fixtures.sh       # pushes stubs to Verdaccio with auth token
```
