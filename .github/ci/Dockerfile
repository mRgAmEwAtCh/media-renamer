# CI image for the test job: the app image's base plus ffmpeg/ffprobe, prebuilt so
# CI doesn't install ffmpeg on every run. Published by .github/workflows/ci-image.yml.
FROM node:26-alpine

RUN apk add --no-cache ffmpeg
