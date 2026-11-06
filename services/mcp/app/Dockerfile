# syntax=docker/dockerfile:1
FROM node:24-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
# HTTP server (StreamableHTTPServerTransport), NOT stdio — but defaults to
# host "localhost" (src/bootstrap.ts), which accepts no traffic from outside
# the container. Override explicitly.
ENV KB_MCP_DAEMON_HOST=0.0.0.0

RUN addgroup --system --gid 1001 nodejs && \
    adduser  --system --uid 1001 --ingroup nodejs kb

# deploy/ produced on CI by: pnpm deploy --filter @kb-labs/mcp-app --prod .kb/deploy/mcp-app
COPY --chown=kb:nodejs .kb/deploy/mcp-app/node_modules ./node_modules
COPY --chown=kb:nodejs .kb/deploy/mcp-app/dist ./dist
COPY --chown=kb:nodejs .kb/deploy/image-default/kb.config.json /app/.kb/kb.config.json

# No config baked: only the optional `analytics` adapter is referenced
# (src/server.ts), and it falls back to NoOp/InMemory cleanly. Auth is
# fail-fast already — src/mcp/auth.ts throws at boot if GATEWAY_JWT_SECRET is
# unset and NODE_ENV=production, so it must be supplied via env/Secret.

USER kb

EXPOSE 7779

CMD ["node", "dist/index.js"]
