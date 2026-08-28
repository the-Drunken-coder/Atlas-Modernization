FROM node:24-alpine AS builder
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/protocol/generated/typescript/ packages/protocol/generated/typescript/
COPY packages/sdk/ packages/sdk/
COPY packages/plugin-runtime/ packages/plugin-runtime/
COPY plugins/reference/ plugins/reference/
RUN npm ci --ignore-scripts && npm run build:sdk && npm run build:plugin-runtime && npm run build --workspace @the-drunken-coder/atlas-reference-plugin

FROM node:24-alpine AS plugin
WORKDIR /app
COPY --from=builder /repo/node_modules/ /app/node_modules/
COPY --from=builder /repo/packages/sdk/package.json /app/packages/sdk/package.json
COPY --from=builder /repo/packages/sdk/dist/ /app/packages/sdk/dist/
COPY --from=builder /repo/packages/plugin-runtime/package.json /app/packages/plugin-runtime/package.json
COPY --from=builder /repo/packages/plugin-runtime/dist/ /app/packages/plugin-runtime/dist/
COPY --from=builder /repo/plugins/reference/dist/ /app/plugins/reference/dist/
USER node
EXPOSE 8080
CMD ["node", "/app/plugins/reference/dist/plugins/reference/src/index.js"]

FROM node:24-alpine AS source
WORKDIR /app
COPY plugins/reference/fixture-source.mjs ./fixture-source.mjs
USER node
EXPOSE 8090
CMD ["node", "fixture-source.mjs"]
