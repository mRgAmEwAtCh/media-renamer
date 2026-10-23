# syntax=docker/dockerfile:1
# Multi-arch base (amd64, arm64, arm/v7) so the image also builds on ARM NAS boxes.
FROM node:25-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173 \
    MEDIA_RENAMER_ROOTS=/media \
    MEDIA_RENAMER_CONFIG_DIR=/config

WORKDIR /app

# ffmpeg/ffprobe for the optional audio fix (adds E-AC-3 tracks next to DTS tracks).
RUN apk add --no-cache ffmpeg

# No npm dependencies: copy only the application. Secrets (.env) are excluded by .dockerignore.
COPY package.json server.js ./
COPY bin ./bin
COPY lib ./lib
COPY public ./public

RUN chmod 0755 bin/media-renamer.js \
 && ln -s /app/bin/media-renamer.js /usr/local/bin/media-renamer \
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
