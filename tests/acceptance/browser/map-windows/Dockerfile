FROM node:24-alpine

WORKDIR /app
COPY tests/acceptance/browser/map-windows/fixture.json ./fixture.json
COPY tests/acceptance/browser/map-windows/plugin-fixture.mjs ./plugin-fixture.mjs

USER node
EXPOSE 8080
CMD ["node", "plugin-fixture.mjs"]
