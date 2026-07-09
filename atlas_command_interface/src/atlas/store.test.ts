import { describe, expect, it } from "vitest";
import { emptySnapshot } from "./store.js";

describe("snapshot state", () => {
  it("starts empty with keyed entity and task records", () => {
    expect(emptySnapshot).toEqual({ entities: {}, tasks: {} });
  });
});
