# syntax=docker/dockerfile:1
FROM node:24-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
# StateDaemonServer binds "localhost" by default (src/bootstrap.ts) — must be
# overridden for the process to accept traffic from outside the container.
ENV KB_STATE_DAEMON_HOST=0.0.0.0

RUN addgroup --system --gid 1001 nodejs && \
    adduser  --system --uid 1001 --ingroup nodejs kb

# deploy/ produced on CI by: pnpm deploy --filter @kb-labs/core-state-daemon --prod .kb/deploy/state-daemon
COPY --chown=kb:nodejs .kb/deploy/state-daemon/node_modules ./node_modules
COPY --chown=kb:nodejs .kb/deploy/state-daemon/dist ./dist
COPY --chown=kb:nodejs .kb/deploy/image-default/kb.config.json /app/.kb/kb.config.json

# State uses InMemoryStateBroker (core/state-broker/src/factory.ts), so state
# does not survive container recreation; the baked composition declares the
# deployment topology shared by all release services.

USER kb

EXPOSE 7777

CMD ["node", "dist/bin.cjs"]
