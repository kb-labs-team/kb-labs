# syntax=docker/dockerfile:1
FROM node:24-slim AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs && \
    adduser  --system --uid 1001 --ingroup nodejs kb

# deploy/ produced on CI by: pnpm deploy --filter @kb-labs/marketplace-app --prod .kb/deploy/marketplace-app
COPY --chown=kb:nodejs .kb/deploy/marketplace-app/node_modules ./node_modules
COPY --chown=kb:nodejs .kb/deploy/marketplace-app/dist ./dist
COPY --chown=kb:nodejs .kb/deploy/image-default/kb.config.json /app/.kb/kb.config.json

# Consumer-side daemon (distinct from marketplace-registry at :5071, the
# publisher/storage service). Ordered plugin sources are read from the resolved
# `marketplace.sources` platform configuration; source credentials stay in
# environment references and are never baked into this image.

USER kb

EXPOSE 5070

CMD ["node", "dist/bin.js"]
