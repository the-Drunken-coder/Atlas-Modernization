import { definePlugin } from "../../src/index.js";

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
