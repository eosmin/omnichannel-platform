# syntax=docker/dockerfile:1
# The Next.js app. Build context: the repository root.
#   docker build -f apps/web/Dockerfile \
#     --build-arg NEXT_PUBLIC_API_URL=https://api.example.com \
#     --build-arg NEXT_PUBLIC_WS_URL=https://api.example.com \
#     --build-arg NEXT_PUBLIC_STORAGE_URL=https://files.example.com \
#     --build-arg NEXT_PUBLIC_WIDGET_SCRIPT_URL=https://cdn.example.com/widget.js .

# Same Node.js and the same Debian/Alpine split as docker/node-service.Dockerfile
ARG BUILD_IMAGE=node:24.20.0-bookworm-slim
ARG RUNTIME_IMAGE=node:24.20.0-alpine

FROM ${BUILD_IMAGE} AS build
# Next.js inlines NEXT_PUBLIC_* into the bundle at build time, and the CSP built in proxy.ts reads
# them too, so they are arguments of the build and not variables of the container
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WS_URL
ARG NEXT_PUBLIC_STORAGE_URL
ARG NEXT_PUBLIC_WIDGET_SCRIPT_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL \
    NEXT_PUBLIC_STORAGE_URL=$NEXT_PUBLIC_STORAGE_URL \
    NEXT_PUBLIC_WIDGET_SCRIPT_URL=$NEXT_PUBLIC_WIDGET_SCRIPT_URL \
    NX_DAEMON=false CI=true HUSKY=0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY . .
RUN pnpm exec nx run web:build \
 && find apps/web/.next/standalone -name '*.map' -delete

FROM ${RUNTIME_IMAGE} AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN apk upgrade --no-cache
# The server only runs node: no package managers
RUN rm -rf /usr/local/lib/node_modules /opt/yarn* \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
# The traced server keeps the layout of the repository, so server.js sits under apps/web. The
# static files are not part of the trace: `next start` serves them from .next/static
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone/ ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static/ ./apps/web/.next/static/
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
