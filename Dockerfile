# syntax=docker/dockerfile:1

# Build the web UI (React + Vite). Its output is plain files, so it is built once
# on the build machine's platform, even for multi-arch images.
FROM --platform=$BUILDPLATFORM node:26-alpine AS web
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY vite.config.ts ./
COPY web ./web
COPY lib/types.ts lib/api-types.ts ./lib/
RUN npm run build

# The app. Multi-arch base (amd64, arm64) so the image also builds on 64-bit ARM NAS boxes.
FROM node:26-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173 \
    MEDIA_RENAMER_ROOTS=/media \
    MEDIA_RENAMER_CONFIG_DIR=/config

WORKDIR /app

# ffmpeg/ffprobe for the optional audio fix (adds E-AC-3 tracks next to DTS tracks).
RUN apk add --no-cache ffmpeg

# No runtime npm dependencies: Node runs the .ts files directly, and React is bundled
# into the built web UI. Secrets (.env) are excluded by .dockerignore.
COPY package.json server.ts ./
COPY bin ./bin
COPY lib ./lib
COPY --from=web /build/dist/web ./dist/web

RUN chmod 0755 bin/media-renamer.ts \
 && ln -s /app/bin/media-renamer.ts /usr/local/bin/media-renamer \
 && mkdir -p /media /config

# Saved settings (patterns, destinations, …) live here; mount a writable folder to keep them.
VOLUME /config

# Runs unprivileged; compose overrides the uid:gid to match the owner of your media files.
USER node
EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1

ENTRYPOINT ["media-renamer"]
CMD ["serve"]
