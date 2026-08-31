import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("reference plugin bundle", () => {
  it("keeps deployment fragments aligned with the plugin identity", () => {
    const root = join(import.meta.dirname, "..");
    const manifest = JSON.parse(readFileSync(join(root, "atlas-plugin.json"), "utf8"));
    const endpoint = JSON.parse(readFileSync(join(root, manifest.core_endpoint), "utf8"));
    const connector = JSON.parse(readFileSync(join(root, manifest.source_connector), "utf8"));
    expect(endpoint.id).toBe(manifest.plugin_id);
    expect(connector.id).toBe("reference");
  });
});
