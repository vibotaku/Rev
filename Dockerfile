# syntax=docker/dockerfile:1

# ---- build: compile web UI, CLI bundle and server bundle -------------------
FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/cli/package.json apps/cli/
RUN npm ci
COPY . .
RUN npm run build

# ---- deps: production dependencies of the server only ---------------------
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/cli/package.json apps/cli/
RUN npm ci --omit=dev --workspace @rev/server --ignore-scripts && npm cache clean --force

# ---- runtime -----------------------------------------------------------------
FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg tini \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    WEB_DIST=/app/web \
    CLI_BUNDLE=/app/cli/rev.mjs \
    MIGRATIONS_DIR=/app/server/drizzle
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /src/apps/server/dist ./server/dist
COPY --from=build /src/apps/server/drizzle ./server/drizzle
COPY --from=build /src/apps/web/dist ./web
COPY --from=build /src/apps/cli/dist/rev.mjs ./cli/rev.mjs
COPY deploy/docker-entrypoint.sh /usr/local/bin/rev-entrypoint
RUN chmod 755 /usr/local/bin/rev-entrypoint && mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["tini", "--", "rev-entrypoint"]
CMD ["node", "server/dist/index.js"]
