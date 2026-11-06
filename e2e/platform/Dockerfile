# KB Labs E2E — Platform container
#
# Stage 1 (go-builder): compiles kb-create and kb-dev from monorepo source so
# the E2E suite never needs kblabs.ru or GitHub releases to be reachable (CI-safe).
#
# Stage 2 (runtime): test image with the compiled binaries pre-installed.
# entrypoint.sh detects the pre-installed binaries and skips the remote
# install.sh download. kb-create then installs all @kb-labs/* packages from
# the Verdaccio local registry (started by the verdaccio Compose service),
# which is pre-populated from the monorepo build by the publisher service.
#
# Build:  docker build -t kb-e2e-platform -f e2e/platform/Dockerfile .
# Run:    docker compose -f e2e/docker-compose.yml up

# Candidate binaries and the host sealer are prepared by the release owner
# before Docker receives its build context.
FROM node:24-bookworm AS release-index-builder

ARG SOURCE_REVISION

WORKDIR /src
COPY e2e/packages /src/packages
COPY e2e/platform/registry-manifest.json /src/registry-manifest.json
COPY e2e/platform/prepare-release-index.mjs /src/prepare-release-index.mjs
COPY e2e/platform/release-index-package-stage.mjs /src/release-index-package-stage.mjs
COPY e2e/platform/release-provenance.mjs /src/release-provenance.mjs
COPY e2e/platform/journey-update-packages.mjs /src/journey-update-packages.mjs
COPY e2e/platform/release-index-version.mjs /src/release-index-version.mjs
COPY tools/kb-create/scripts/prepare-binary-manifest.mjs /src/tools/kb-create/scripts/prepare-binary-manifest.mjs
COPY scripts/prepare-candidate-binaries.sh /src/scripts/prepare-candidate-binaries.sh
COPY dist /src/dist
COPY .journey/e2e-platform-binaries /out/binaries
COPY tools/kb-create/scripts/prepare-release-index.mjs /src/kb-create/scripts/prepare-release-index.mjs
COPY tools/kb-create/scripts/platform-release-config.mjs /src/kb-create/scripts/platform-release-config.mjs
COPY tools/kb-create/package.json /src/node_modules/kb-create/package.json
COPY tools/kb-create/scripts/package-provenance.mjs /src/node_modules/kb-create/scripts/package-provenance.mjs
COPY tools/kb-create/scripts/platform-release-config.mjs /src/node_modules/kb-create/scripts/platform-release-config.mjs
COPY tools/kb-create/config/platform-release.jsonc /src/platform-release.jsonc
COPY tools/kb-create/config/platform-release.jsonc /src/kb-create/config/platform-release.jsonc
RUN cp /out/binaries/kb-create-release-index /usr/local/bin/kb-create-release-index && \
    cp /out/binaries/binary-manifest.json /out/binary-manifest.json && \
    BINARY_VERSION="$(node -e 'const fs=require("node:fs"); const {execFileSync}=require("node:child_process"); const file=fs.readdirSync("/src/packages").find(name=>name.startsWith("kb-labs-core-runtime-") && name.endsWith(".tgz")); if (!file) throw new Error("@kb-labs/core-runtime tarball is missing"); process.stdout.write(JSON.parse(execFileSync("tar", ["-xOzf", `/src/packages/${file}`, "package/package.json"], {encoding:"utf8"})).version)')" && \
    node /src/prepare-release-index.mjs \
      --packages-dir /src/packages \
      --registry-manifest /src/registry-manifest.json \
      --sealer /usr/local/bin/kb-create-release-index \
      --binary-dir /out/binaries \
      --binary-manifest /out/binary-manifest.json \
      --binary-manifest-tool /src/scripts/prepare-candidate-binaries.sh \
      --binary-artifacts /src/dist/artifacts.json \
      --binary-checksums /src/dist/checksums.txt \
      --release-config /src/platform-release.jsonc \
      --binary-version "$BINARY_VERSION" \
      --source-revision "$SOURCE_REVISION" \
      --output /out/release-index.json

# ── Stage 2: runtime ──────────────────────────────────────────────────────
FROM node:24-bookworm

RUN apt-get update -qq && \
    apt-get install -y -qq curl ca-certificates git jq && \
    npm install -g pnpm@11.4.0 && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

RUN git config --global user.email "e2e@kblabs.test" && \
    git config --global user.name "KB Labs E2E"

# Pre-install binaries — entrypoint.sh skips kblabs.ru download when these exist
COPY --from=release-index-builder /out/binaries/kb-create-linux-amd64 /usr/local/bin/kb-create
COPY --from=release-index-builder /out/binaries/kb-dev-linux-amd64 /usr/local/bin/kb-dev
COPY --from=release-index-builder /out/binaries/kb-devkit-linux-amd64 /usr/local/bin/kb-devkit
COPY --from=release-index-builder /out/release-index.json /release-index.json

# Manifest that points kb-create at the local Verdaccio registry
COPY e2e/platform/registry-manifest.json /e2e-registry-manifest.json

COPY e2e/platform/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 4000 5050 5070 7777 7778

CMD ["/entrypoint.sh"]
