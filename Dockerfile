# Builds the server only. Run from the repository root.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production NODE_NO_WARNINGS=1
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY packages/api-types/package.json packages/api-types/package.json
RUN npm ci --omit=dev --workspace @hip3-oracle-watch/server --include-workspace-root
COPY packages/api-types packages/api-types
COPY apps/server apps/server
# The SQLite file lives on a mounted volume; without one, data is lost on redeploy.
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/v1/health').then(r=>r.json()).then(h=>process.exit(h.collectorRunning?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "apps/server/src/cli.ts", "run", "--db", "/data/oracle-watch.db", "--host", "0.0.0.0", "--config", "/data/alerts.json"]
