# syntax=docker/dockerfile:1
FROM node:24-slim AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs && \
    adduser  --system --uid 1001 --ingroup nodejs kb

# This private composition deploy importer contains the Registry service, the
# SDK, and exactly the adapter roots configured by platform-release.jsonc.
COPY --chown=kb:nodejs .kb/deploy/registry-image-composition/node_modules ./node_modules
COPY --chown=kb:nodejs .kb/deploy/image-default/kb.config.json /app/.kb/kb.config.json
COPY --chown=kb:nodejs .kb/deploy/image-default/platform-layout.json /app/.kb/v2/platform-layout.json
COPY --chown=kb:nodejs .kb/deploy/registry-image-composition/.kb/marketplace.lock /app/.kb/marketplace.lock
COPY --chown=kb:nodejs .kb/deploy/registry-image-composition/.kb/image-composition.json /app/.kb/image-composition.json

# The release composition declares cloud topology; deployment-specific config
# may be layered at runtime.
COPY --chown=kb:nodejs services/marketplace-registry/app/docker-entrypoint.sh /app/docker-entrypoint.sh

RUN mkdir -p .kb/data && chown -R kb:nodejs .kb && \
    chmod +x /app/docker-entrypoint.sh

USER kb

EXPOSE 5071

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "node_modules/@kb-labs/marketplace-registry-app/dist/bootstrap.js"]
