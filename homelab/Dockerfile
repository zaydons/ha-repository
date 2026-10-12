# Homelab Dashboard. Built locally by the Supervisor from this folder.
# When updating Node, bump the tag and the multi-arch index digest together.
FROM node:24.21.0-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

ARG BUILD_VERSION
ARG BUILD_ARCH
LABEL \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.type="app" \
  io.hass.arch="${BUILD_ARCH}"

# iputils-ping: unprivileged ICMP (no NET_RAW). su-exec: drop to the node user.
RUN apk add --no-cache iputils-ping su-exec

WORKDIR /app
COPY app/package.json app/package-lock.json ./
# Runtime deps only, no install scripts; then remove the package managers,
# which the running app never needs (this hardens the image; it can't shrink
# the base layer). Also drop simple-icons' JS bundles: 10 MB duplicating the
# SVGs in simple-icons/icons/, which is what the icon service reads.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
     /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* \
     /usr/local/bin/yarn /usr/local/bin/yarnpkg /root/.npm \
  && rm -f node_modules/simple-icons/index.js node_modules/simple-icons/index.mjs \
     node_modules/simple-icons/index.d.ts

COPY app/src ./src
COPY app/web ./web
COPY app/sample ./sample
COPY --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh

ENV NODE_ENV=production \
    HL_VERSION="${BUILD_VERSION}"

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8099/api/health || exit 1

# Starts as root only to prepare /data and seed /config, then runs as node (uid 1000).
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
