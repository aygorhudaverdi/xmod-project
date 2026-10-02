# syntax=docker/dockerfile:1

# ---- deps: production dependencies only (tsx runs the TypeScript sources directly)
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- runtime
FROM node:20-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node data ./data
COPY --chown=node:node web ./web

# The official image ships an unprivileged "node" user (uid 1000).
USER node
EXPOSE 3000

# node:20-slim has no curl; use Node's built-in fetch. Honors PORT if the platform overrides it.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# Run node directly (not npm) so SIGTERM reaches the server.
CMD ["node", "--import", "tsx", "src/server/server.ts"]
