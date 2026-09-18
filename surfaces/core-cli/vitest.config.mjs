import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const testMetadata = fileURLToPath(new URL("./test/package-metadata.fixture.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^(?:\.\/package-metadata|\.\.\/src\/package-metadata)\.js$/u,
        replacement: testMetadata
      }
    ]
  }
});
