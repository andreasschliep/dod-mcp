# dod-mcp: the Definition of Done server over HTTPS (design section 11.2).
# One team per container. Mount the team's DoD folder at /dod (read-only), a volume at
# /data for the version history, and three secrets: tls_cert, tls_key, dod_tokens.

# node:26-slim, pinned by digest (Node 26.13.1, image of 2026-11-11).
ARG NODE_IMAGE=node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    DOD_TRANSPORT=https \
    DOD_DIR=/dod \
    DOD_DATABASE=sqlite:/data/dod.sqlite \
    DOD_PORT=8443 \
    DOD_TLS_CERT_FILE=/run/secrets/tls_cert \
    DOD_TLS_KEY_FILE=/run/secrets/tls_key \
    DOD_TOKEN_FILE=/run/secrets/dod_tokens
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
# The fictional example DoD as default content; a mounted team folder replaces it.
COPY dod /dod
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8443
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --start-interval=2s --retries=3 \
  CMD ["node", "dist/healthcheck.js"]
CMD ["node", "dist/main.js"]
