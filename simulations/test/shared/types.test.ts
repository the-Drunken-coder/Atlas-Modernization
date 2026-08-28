import { RESOURCE_TYPE_VALUES } from "@the-drunken-coder/atlas-sdk";
import { describe, expect, it } from "vitest";
import { CREATED_RESOURCE_TYPES, isCreatedResource } from "../../src/shared/types.js";

describe("created resource contracts", () => {
  it("supports every Protocol resource type in schema order", () => {
    expect(CREATED_RESOURCE_TYPES).toBe(RESOURCE_TYPE_VALUES);
    for (const type of RESOURCE_TYPE_VALUES) {
      expect(isCreatedResource({ type, id: `${type}-1` })).toBe(true);
    }
  });
});
