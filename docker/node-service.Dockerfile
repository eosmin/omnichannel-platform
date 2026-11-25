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
FROM ${RUNTIME_IMAGE} AS native-sharp
COPY package.json /tmp/repo-package.json
RUN version="$(node -p "require('/tmp/repo-package.json').dependencies.sharp")" \
 && mkdir /native && cd /native \
 && npm install --omit=dev --no-audit --no-fund --ignore-scripts "sharp@${version}" \
 && rm -rf /root/.npm
# The worker cleans the pictures of messages and the api makes the 128 px icon of a channel plugin (Step 5.6): both load
# sharp. An app that loads no native package would take an empty stage, with /native/node_modules there and empty.
FROM native-sharp AS native-worker
FROM native-sharp AS native-api

# ffmpeg and ffprobe for the worker (Step 7.1-J: the metadata of video and audio, GPS included, is cut out of what customers and agents
# send). Built from the source of a release, never downloaded as a binary, with the version and the SHA-256 of the tarball PINNED here:
# a download that does not match stops the build, so a changed or poisoned file never gets in. The checksum is the one of the tarball
# published at https://ffmpeg.org/releases/ (checked against the file, 2026-11-25; the SHA-512 in the Alpine package of the same release matches, which only shows that the file was the same when Alpine packaged it: the signature of the release is NOT verified, see the plan).
# Why this build and not `apk add ffmpeg`: the package of the distribution is GPL (x264, x265, ...) and carries every codec and every
# protocol, which is attack surface the cleaner never needs, because it only copies the streams (`-c copy`). This one is LGPL 2.1+
# (`--disable-gpl --disable-nonfree --disable-version3`: no GPL codec, no non-free one, nothing that raises the license), shared
# libraries so that the LGPL relinking right is met by the files themselves (the recipe is this file), and `--disable-everything` plus a
# list of the five demuxers and six muxers of the types the platform accepts (`AllowedContentTypes`: mp4, mov, mp3, ogg, wav, m4a, aac).
# One decoder (aac: a raw ADTS file has its sample rate only after the first frame is decoded, without it the copy fails), no encoder,
# no filter, no network (`--disable-network`: the sockets are not even compiled in) and only the `file` protocol.
# Updating: change both ARGs together, read the release notes for the demuxers listed here, and run the build (it prints the licence
# and the lists that the smoke test below checks).
# NOT watched by Trivy: it reads the packages of the operating system and the lockfiles, and this binary is neither, so its CVEs are never
# reported. The control is `.github/workflows/ffmpeg-version.yml` (weekly: fails and opens an issue when FFMPEG_VERSION is behind the newest
# release published on ffmpeg.org), whose failure is read by the owner of Step 7.3 (dependency review).
FROM ${RUNTIME_IMAGE} AS ffmpeg-build
ARG FFMPEG_VERSION=9.1
ARG FFMPEG_SHA256=1a4d394ae63d190a526cd052eb4415c156b5c5e2df37efab41a7de0b8fde2433
RUN apk add --no-cache build-base curl xz
WORKDIR /src
RUN curl --fail --silent --show-error --retry 5 --retry-all-errors --location --proto '=https' --tlsv1.2 \
      --output ffmpeg.tar.xz "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
 && echo "${FFMPEG_SHA256}  ffmpeg.tar.xz" | sha256sum -c - \
 && tar -xJf ffmpeg.tar.xz --strip-components=1 \
 && rm ffmpeg.tar.xz
RUN ./configure \
      --prefix=/opt/ffmpeg \
      --disable-everything --disable-autodetect --disable-network \
      --disable-gpl --disable-nonfree --disable-version3 \
      --disable-doc --disable-debug --disable-ffplay --disable-avdevice --disable-asm \
      --enable-pic --enable-shared --disable-static \
      --extra-ldflags='-Wl,-rpath,/opt/ffmpeg/lib' \
      --enable-protocol=file \
      --enable-demuxer=mov,mp3,ogg,wav,aac \
      --enable-muxer=mp4,mov,mp3,ogg,wav,adts \
      --enable-parser=aac,aac_latm,h264,hevc,mpeg4video,mpegaudio,opus,vorbis,flac,av1,vp9 \
      --enable-decoder=aac \
 && make -j"$(nproc)" \
 && make install \
 && mkdir -p /opt/ffmpeg/share/licenses \
 && cp COPYING.LGPLv2.1 LICENSE.md /opt/ffmpeg/share/licenses/ \
 && rm -rf /opt/ffmpeg/include /opt/ffmpeg/lib/pkgconfig /opt/ffmpeg/share/man /opt/ffmpeg/share/ffmpeg
# Smoke test of the build: the license is LGPL, no network, only the file protocol
RUN /opt/ffmpeg/bin/ffmpeg -hide_banner -version | tee /dev/stderr | grep -q -- '--disable-gpl' \
 && ! /opt/ffmpeg/bin/ffmpeg -hide_banner -L | grep -qi 'GNU General' \
 && test "$(/opt/ffmpeg/bin/ffmpeg -hide_banner -protocols | sed -n '/Input:/,/Output:/p' | grep -Evc 'Input:|Output:')" = "1"
# The worker takes the stage with the tools; the api, which never cleans a video, takes an empty one
FROM ffmpeg-build AS av-worker
FROM ${RUNTIME_IMAGE} AS av-api
RUN mkdir -p /opt/ffmpeg
FROM av-${APP} AS av

# The stage of the app being built (COPY --from cannot expand a variable, FROM can)
FROM native-${APP} AS native

# The bundle holds every dependency, so the image needs no node_modules: only Node and the files
FROM ${RUNTIME_IMAGE} AS runtime
ENV NODE_ENV=production TZ=UTC
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
# ffmpeg and ffprobe, owned by root and read-only for the service, for the worker alone (stage av: the api takes an empty directory). prlimit
# (util-linux) sets the limits of the kernel on each child of the cleaner of video and audio metadata (`FfmpegAvCleaner`); the build stops
# if the tools do not start on this base, so a mismatch of libc is found here and not in production
COPY --from=av /opt/ffmpeg/ /opt/ffmpeg/
RUN if [ "$APP" = "worker" ]; then \
      apk add --no-cache util-linux-misc \
      && /opt/ffmpeg/bin/ffmpeg -hide_banner -version >/dev/null \
      && /opt/ffmpeg/bin/ffprobe -hide_banner -version >/dev/null \
      && prlimit --version >/dev/null; \
    fi
COPY --from=build --chown=node:node /repo/dist/apps/${APP}/ ./
# The one thing found on disk at run time: Bull Board looks for the files of its page in
# node_modules/@bull-board/ui (3 MB), starting from the working directory. Without them the api fails
# to start when BULL_BOARD_ENABLED is on.
COPY --from=build --chown=node:node /repo/node_modules/@bull-board/ui/ ./node_modules/@bull-board/ui/
# sharp and the binary it needs, for the apps that load it (stage native-<app>)
COPY --from=native --chown=node:node /native/node_modules/ ./node_modules/
USER node
EXPOSE 8080
CMD ["node", "main.js"]
