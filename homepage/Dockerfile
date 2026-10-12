# Thin wrapper around the official Homepage image. Keep this tag and
# `version` in config.yaml in sync when updating.
FROM ghcr.io/gethomepage/homepage:v2.5.0

ARG BUILD_VERSION
ARG BUILD_ARCH
LABEL \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.type="app" \
  io.hass.arch="${BUILD_ARCH}"

COPY --chmod=755 run.sh /usr/local/bin/addon-run.sh
COPY addon-options.cjs lan-guard.cjs /usr/local/lib/addon/

# Upstream WORKDIR (/app), USER (root) and HEALTHCHECK are inherited.
# HOMEPAGE_ALLOWED_HOSTS is computed at start-up by run.sh; never set it here.
ENTRYPOINT ["/usr/local/bin/addon-run.sh"]
CMD ["node", "server.js"]
