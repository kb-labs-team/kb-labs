# syntax=docker/dockerfile:1
FROM node:24-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
# StateDaemonServer binds "localhost" by default (src/bootstrap.ts) — must be
# overridden for the process to accept traffic from outside the container.
ENV KB_STATE_DAEMON_HOST=0.0.0.0

RUN addgroup --system --gid 1001 nodejs && \
    adduser  --system --uid 1001 --ingroup nodejs kb

# Persistent state journals use flock(2) across container recreation. Install
# util-linux explicitly instead of relying on the base image's package set.
RUN apt-get update && \
    apt-get install -y --no-install-recommends util-linux && \
    rm -rf /var/lib/apt/lists/*

# deploy/ produced on CI by: pnpm deploy --filter @kb-labs/core-state-daemon --prod .kb/deploy/state-daemon
COPY --chown=kb:nodejs .kb/deploy/state-daemon/node_modules ./node_modules
COPY --chown=kb:nodejs .kb/deploy/state-daemon/dist ./dist
COPY --chown=kb:nodejs .kb/deploy/image-default/kb.config.json /app/.kb/kb.config.json
COPY --chown=kb:nodejs .kb/deploy/image-default/platform-layout.json /app/.kb/v2/platform-layout.json
COPY --chmod=0755 services/state/daemon/docker-entrypoint.sh /usr/local/bin/kb-state-daemon-entrypoint
RUN mkdir -p /app/.kb/data/state && chown -R kb:nodejs /app/.kb/data

# Set KB_STATE_DAEMON_DATA_ROOT to a persistent mount to enable the append-only
# journal backend in standalone containers. Without it, the broker is in-memory.

USER kb

ENTRYPOINT ["/usr/local/bin/kb-state-daemon-entrypoint"]

EXPOSE 7777
