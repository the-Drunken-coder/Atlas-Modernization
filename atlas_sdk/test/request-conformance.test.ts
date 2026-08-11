import { describe, expect, it } from "vitest";

import requestCorpus from "../../atlas_protocol/conformance/request-validation.json";
import {
  isEntityCheckInRequest,
  isEntityCreateRequest,
  isEntityUpdateRequest,
  isObjectCreateRequest,
  isObjectUpdateRequest,
  isTaskCreateRequest,
  isTaskUpdateRequest
} from "../src";
import { isObjectDetailResource, isObjectResource } from "../src/protocol.js";

const validators = {
  EntityCheckInRequest: isEntityCheckInRequest,
  EntityCreateRequest: isEntityCreateRequest,
  EntityUpdateRequest: isEntityUpdateRequest,
  ObjectCreateRequest: isObjectCreateRequest,
  ObjectUpdateRequest: isObjectUpdateRequest,
  TaskCreateRequest: isTaskCreateRequest,
  TaskUpdateRequest: isTaskUpdateRequest
} as const;

describe("generated request validator conformance", () => {
  for (const testCase of requestCorpus.cases) {
    it(testCase.name, () => {
      const validate = validators[testCase.definition as keyof typeof validators];
      expect(validate, `missing validator for ${testCase.definition}`).toBeDefined();
      expect(validate(testCase.value)).toBe(testCase.valid);
    });
  }

  it("rejects aggregate polygon position overflow in entity check-ins", () => {
    const ring = Array.from({ length: 10_001 }, () => [0, 0]);
    expect(isEntityCheckInRequest({ components: { geometry: { type: "Polygon", coordinates: [ring] } } })).toBe(false);
  });

  it("validates deeply nested JSON without recursion and preserves cycle semantics", () => {
    let nested: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 3_000; depth++) nested = { nested };

    expect(() => isObjectCreateRequest({ object_id: "object-deep-json", extra: nested })).not.toThrow();
    expect(isObjectCreateRequest({ object_id: "object-deep-json", extra: nested })).toBe(true);

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(isObjectCreateRequest({ object_id: "object-cycle", extra: cycle })).toBe(false);

    const shared = { confidence: 0.9 };
    expect(isObjectCreateRequest({ object_id: "object-shared", extra: { first: shared, second: shared } })).toBe(true);
    expect(isObjectCreateRequest({ object_id: "object-date", extra: { value: new Date() } })).toBe(false);
    expect(isObjectCreateRequest({ object_id: "object-nan", extra: { value: Number.NaN } })).toBe(false);
  });

  it("enforces safe size_bytes on generated object resource validators", () => {
    const metadata = { created_at: "2026-08-03T00:00:00Z", updated_at: "2026-08-03T00:00:00Z", version: 1 };
    const resource = {
      object_id: "object-safe-size",
      path: null,
      content_type: null,
      type: null,
      bucket: null,
      size_bytes: 9_007_199_254_740_991,
      usage_hints: [],
      referenced_by: [],
      metadata
    };
    expect(isObjectResource(resource)).toBe(true);
    expect(isObjectDetailResource({ ...resource, extra: {} })).toBe(true);
    expect(isObjectResource({ ...resource, size_bytes: 9_007_199_254_740_992 })).toBe(false);
    expect(isObjectDetailResource({ ...resource, size_bytes: 9_007_199_254_740_992, extra: {} })).toBe(false);
  });
});
