# syntax=docker/dockerfile:1
FROM node:24-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
# bootstrap.ts resolves plugin/cron discovery from KB_PROJECT_ROOT (falling
# back to the resolved repo root) — pin it explicitly so discovery is
# deterministic under a container WORKDIR that has no .git to anchor on.
ENV KB_PROJECT_ROOT=/app

RUN addgroup --system --gid 1001 nodejs && \
    adduser  --system --uid 1001 --ingroup nodejs kb

# deploy/ produced on CI by: pnpm deploy --filter @kb-labs/workflow-daemon --prod .kb/deploy/workflow-daemon
COPY --chown=kb:nodejs .kb/deploy/workflow-daemon/node_modules ./node_modules
COPY --chown=kb:nodejs .kb/deploy/workflow-daemon/dist ./dist

# Composition is deliberately absent from the release image. kb-create writes
# the user's explicit config and lock into their derived image; the entrypoint
# refuses to boot without both files.
#
# IMPORTANT — replicas: only ever run ONE instance of this image. JobBroker
# and CronScheduler run in-process (src/bootstrap.ts); a second replica
# double-fires every scheduled job. See docs/adr/0037 and
# plugins/workflow/docs/adr/0014-worker-deployment-architecture.md (design
# for a worker/scheduler split — not implemented).
COPY --chown=kb:nodejs plugins/workflow/daemon/docker-entrypoint.sh /app/docker-entrypoint.sh

RUN mkdir -p .kb && chown -R kb:nodejs .kb && chmod +x /app/docker-entrypoint.sh

USER kb

EXPOSE 7778

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "dist/bin.js"]
