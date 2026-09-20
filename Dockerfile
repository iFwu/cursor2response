FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.runtime.json tsconfig.json ./
COPY sidecar ./sidecar
COPY core ./core
COPY scripts/validate-grok-hybrid.ts scripts/validate-responses-phases.ts ./scripts/
COPY tools/trace-viewer ./tools/trace-viewer
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/tools/trace-viewer/dist ./tools/trace-viewer/dist
COPY --from=build /app/dist/runtime ./dist/runtime
COPY --chown=node:node package.json LICENSE THIRD_PARTY_NOTICES.md ./
COPY --chown=node:node bridge ./bridge
COPY --chown=node:node scripts/structured-log-runner.mjs ./scripts/structured-log-runner.mjs
COPY --chown=node:node tools/trace-viewer/*.mjs ./tools/trace-viewer/
RUN mkdir -p /workspace /home/node/.cursor /data/state /data/logs /data/traces \
    && chown -R node:node /workspace /home/node/.cursor /data
USER node
CMD ["node", "scripts/structured-log-runner.mjs", "bridge", "--", "node", "bridge/server.mjs"]
