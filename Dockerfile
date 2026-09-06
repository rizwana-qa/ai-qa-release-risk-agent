# syntax=docker/dockerfile:1
#
# The server runs TypeScript directly via Node's native type stripping, which
# needs Node >= 23.6. Pinning the base image guarantees that on any host.
# The same image runs unchanged on Render, Railway, Fly.io, Cloud Run, etc.

FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080

WORKDIR /app

# Runtime dependencies only (skips typescript, @types/node, @playwright/test).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Full source tree — the assessment pipeline spawns `node src/pipelineCli.ts`,
# so `src/`, `data/` and `workflows/` must be present at runtime, not just a build.
COPY --chown=node:node api ./api
COPY --chown=node:node src ./src
COPY --chown=node:node web ./web
COPY --chown=node:node data ./data
COPY --chown=node:node workflows ./workflows
COPY --chown=node:node tsconfig.json ./

# Per-assessment temp state is written here and deleted after each run.
RUN mkdir -p /app/.pipeline-run && chown -R node:node /app/.pipeline-run
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "api/server.ts"]
