# syntax=docker/dockerfile:1
FROM node:24-slim AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs && \
    adduser  --system --uid 1001 --ingroup nodejs kb

# deploy/ produced on CI by: pnpm deploy --filter @kb-labs/marketplace-app --prod .kb/deploy/marketplace-app
COPY --chown=kb:nodejs .kb/deploy/marketplace-app/node_modules ./node_modules
COPY --chown=kb:nodejs .kb/deploy/marketplace-app/dist ./dist

# Consumer-side daemon (distinct from marketplace-registry at :5071, the
# publisher/storage service). Registry endpoint is read from marketplace.
# registry.url in a mounted .kb/kb.config.json, falling back to KB_REGISTRY_URL
# (src/bootstrap.ts:37-39) — no adapter composition required to boot, so no
# baked default config/lock, unlike gateway/marketplace-registry.
# KB_REGISTRY_URL must point at your own marketplace-registry deployment in
# production — do not rely on any upstream default.

USER kb

EXPOSE 5070

CMD ["node", "dist/bin.js"]
