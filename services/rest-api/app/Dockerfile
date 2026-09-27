# syntax=docker/dockerfile:1
FROM node:24-slim AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs && \
    adduser  --system --uid 1001 --ingroup nodejs kb

# deploy/ produced on CI by: pnpm deploy --filter @kb-labs/rest-api-app --prod .kb/deploy/rest-api-app
COPY --chown=kb:nodejs .kb/deploy/rest-api-app/node_modules ./node_modules
COPY --chown=kb:nodejs .kb/deploy/rest-api-app/dist ./dist

# Composition is deliberately absent from the release image. kb-create writes
# the user's explicit config and lock into their derived image; the entrypoint
# refuses to boot without both files.
COPY --chown=kb:nodejs services/rest-api/app/docker-entrypoint.sh /app/docker-entrypoint.sh

RUN mkdir -p .kb && chown -R kb:nodejs .kb && chmod +x /app/docker-entrypoint.sh

USER kb

EXPOSE 5050

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "dist/bin.js"]
