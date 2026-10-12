# Thin wrapper around the official Homepage image. When updating, bump the
# tag, the multi-arch index digest and `version` in config.yaml together.
FROM ghcr.io/gethomepage/homepage:v2.5.0@sha256:57c4a0531937889c0b968b120fe9c2560bbe036b5c9e18c49a9e2479de9975d1

ARG BUILD_VERSION
ARG BUILD_ARCH
LABEL \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.type="app" \
  io.hass.arch="${BUILD_ARCH}"

# zlib 1.3.2-r0 in the base image has a High CVE fixed in r1.
RUN apk upgrade --no-cache zlib

COPY --chmod=755 run.sh /usr/local/bin/addon-run.sh
COPY addon-options.cjs lan-guard.cjs /usr/local/lib/addon/

# Upstream WORKDIR (/app), USER (root) and HEALTHCHECK are inherited.
# HOMEPAGE_ALLOWED_HOSTS is computed at start-up by run.sh; never set it here.
ENTRYPOINT ["/usr/local/bin/addon-run.sh"]
CMD ["node", "server.js"]
