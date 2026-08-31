import { definePlugin, defineSpatialOperation } from "../../src/index.js";

const plugin = definePlugin({
  pluginId: "typed_fixture",
  displayName: "Typed fixture",
  operations: {
    inspect: {
      displayName: "Inspect",
      timeoutMs: 500,
      handler(input: { key: string }) {
        return { key: input.key, found: true };
      }
    }
  }
});

plugin.operations.inspect.handler({ key: "alpha" });
// @ts-expect-error typed handlers reject the wrong input shape
plugin.operations.inspect.handler({ nope: true });

const spatialOperation = defineSpatialOperation({
  displayName: "Search area",
  timeoutMs: 1000,
  handler(area) {
    area.west satisfies number;
    return {
      features: [],
      provenance: { connector_id: "fixture", source: "Fixture" },
      attribution: { text: "Fixture", url: "https://example.test" },
      retrieved_at: "2026-08-30T12:00:00Z",
      truncation: null
    };
  }
});

spatialOperation.handler({ west: -71.31, south: 42.27, east: -71.3, north: 42.28 }, new AbortController().signal);
// @ts-expect-error spatial handlers require the standard map-area input
spatialOperation.handler({ west: -71.31 }, new AbortController().signal);
