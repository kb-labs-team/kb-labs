FROM node:24-slim AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs && \
    adduser  --system --uid 1001 --ingroup nodejs kb

# deploy/ produced on CI by: pnpm deploy --filter @kb-labs/gateway-app --prod .kb/deploy/gateway-app
COPY --chown=kb:nodejs .kb/deploy/gateway-app/node_modules ./node_modules
COPY --chown=kb:nodejs .kb/deploy/gateway-app/dist ./dist
COPY --chown=kb:nodejs .kb/deploy/image-default/kb.config.json /app/.kb/kb.config.json

# The release composition declares cloud topology. Helm and kb-create provide
# their own topology through their mounted configuration.
COPY --chown=kb:nodejs services/gateway/app/docker-entrypoint.sh /app/docker-entrypoint.sh

RUN mkdir -p .kb/data && chown -R kb:nodejs .kb && \
    chmod +x /app/docker-entrypoint.sh

USER kb

EXPOSE 4000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "dist/bin.js"]

