# syntax=docker/dockerfile:1
#
# One image, two processes:
#   API     -> node dist/server.js            (default CMD)
#   Worker  -> node dist/temporal/worker.js
#
# Debian slim (glibc) is used instead of Alpine because Temporal's native
# core-bridge ships glibc binaries only.

ARG NODE_VERSION=22

# ---- deps: install all dependencies (cached unless the lockfile changes) ----
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# ---- build: compile TypeScript + pre-bundle workflow code, then drop dev deps ----
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
# Temporal ships native binaries for every OS/arch (~140 MB); keep only this image's one.
RUN cd node_modules/@temporalio/core-bridge/releases \
 && keep="$(uname -m)-unknown-linux-gnu" \
 && test -d "$keep" \
 && find . -mindepth 1 -maxdepth 1 -type d ! -name "$keep" -exec rm -rf {} +

# ---- runtime: minimal, non-root ----
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
