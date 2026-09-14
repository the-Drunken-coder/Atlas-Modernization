FROM node:24-alpine

WORKDIR /app
COPY fixture.json ./fixture.json
COPY plugin-fixture.mjs ./plugin-fixture.mjs

USER node
EXPOSE 8080
CMD ["node", "plugin-fixture.mjs"]
