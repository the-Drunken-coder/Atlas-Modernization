FROM node:24-bookworm-slim AS builder

WORKDIR /app
COPY --chown=node:node . .
RUN chown node:node /app
USER node
RUN npm ci && npm run build --workspace @the-drunken-coder/atlas-connector-adsb

FROM node:24-bookworm-slim

WORKDIR /app
COPY --from=builder --chown=node:node /app/atlas_connectors/adsb/dist ./atlas_connectors/adsb/dist
COPY --from=builder --chown=node:node /app/atlas_sdk/package.json ./node_modules/@the-drunken-coder/atlas-sdk/package.json
COPY --from=builder --chown=node:node /app/atlas_sdk/dist ./node_modules/@the-drunken-coder/atlas-sdk/dist
USER node

CMD ["node", "atlas_connectors/adsb/dist/index.js", "run"]
