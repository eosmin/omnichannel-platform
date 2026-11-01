# syntax=docker/dockerfile:1
# One image definition for every Node service of the platform. Build context: the repository root.
#   docker build -f docker/node-service.Dockerfile --build-arg APP=api .

# Node.js 24.20.0, the version pinned by TDD_01 §2.4. The build runs on Debian, where the native
# tools of the build (Rspack, SWC) ship their binaries; the service runs on Alpine, which carries
# far fewer operating system packages to patch.
ARG BUILD_IMAGE=node:24.20.0-bookworm-slim
ARG RUNTIME_IMAGE=node:24.20.0-alpine
# Also needed here, to pick the stage with the native packages of the app (below)
ARG APP

FROM ${BUILD_IMAGE} AS build
# The Nx project to build: api or worker
ARG APP
# HUSKY=0: there is no .git in the build context, and the hooks are for laptops
ENV NX_DAEMON=false CI=true HUSKY=0
WORKDIR /repo
# pnpm comes from the packageManager field of package.json
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY . .
RUN test -n "$APP" \
 && pnpm exec nx run "$APP:build" \
 && find "dist/apps/$APP" -name '*.map' -delete

# The packages with a native binary cannot be in the bundle. They are installed on Alpine itself, so
# that the binary is the one for musl, and only the apps that load them copy them (stage native-<app>).
FROM ${RUNTIME_IMAGE} AS native-worker
COPY package.json /tmp/repo-package.json
RUN version="$(node -p "require('/tmp/repo-package.json').dependencies.sharp")" \
 && mkdir /native && cd /native \
 && npm install --omit=dev --no-audit --no-fund --ignore-scripts "sharp@${version}" \
 && rm -rf /root/.npm
# The api loads none: the directory the runtime copies is there and empty
FROM ${RUNTIME_IMAGE} AS native-api
RUN mkdir -p /native/node_modules

# The stage of the app being built (COPY --from cannot expand a variable, FROM can)
FROM native-${APP} AS native

# The bundle holds every dependency, so the image needs no node_modules: only Node and the files
FROM ${RUNTIME_IMAGE} AS runtime
ENV NODE_ENV=production
# Operating system fixes published after the base image was built
RUN apk upgrade --no-cache
# The service only runs node: the package managers that ship with the base image (npm, npx,
# corepack, yarn) are not needed and carry vulnerabilities of their own
RUN rm -rf /usr/local/lib/node_modules /opt/yarn* \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
# The bundle is an ES module
RUN echo '{"type":"module"}' > package.json
ARG APP
COPY --from=build --chown=node:node /repo/dist/apps/${APP}/ ./
# The one thing found on disk at run time: Bull Board looks for the files of its page in
# node_modules/@bull-board/ui (3 MB), starting from the working directory. Without them the api fails
# to start when BULL_BOARD_ENABLED is on.
COPY --from=build --chown=node:node /repo/node_modules/@bull-board/ui/ ./node_modules/@bull-board/ui/
# sharp of the worker and the binary it needs; empty for the api (stage native-api)
COPY --from=native --chown=node:node /native/node_modules/ ./node_modules/
USER node
EXPOSE 8080
CMD ["node", "main.js"]
