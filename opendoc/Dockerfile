FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build
WORKDIR /work
COPY opendoc/package.json opendoc/package-lock.json ./
RUN npm ci --ignore-scripts
COPY opendoc/src ./src
COPY opendoc/web ./web
COPY opendoc/scripts ./scripts
RUN npm run check:web && npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
LABEL org.opencontainers.image.source="https://github.com/repetere/gpdoc-components" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.description="Experimental OpenDoc deployable PostgreSQL/OIDC document server"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /work/package.json /work/package-lock.json ./
COPY --from=build /work/node_modules ./node_modules
COPY --from=build /work/src ./src
COPY --from=build /work/web ./web
COPY opendoc/migrations ./migrations
COPY LICENSE ./LICENSE
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=7s --start-period=15s --retries=3 CMD ["node", "src/server-health.mjs", "/run/opendoc/server.json"]
ENTRYPOINT ["node", "src/server-cli.mjs"]
CMD ["start", "--config", "/run/opendoc/server.json"]
