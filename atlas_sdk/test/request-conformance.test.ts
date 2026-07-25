import { describe, expect, it } from "vitest";

import requestCorpus from "../../atlas_protocol/conformance/request-validation.json";
import {
  isEntityCreateRequest,
  isEntityUpdateRequest,
  isObjectCreateRequest,
  isObjectUpdateRequest,
  isTaskCreateRequest,
  isTaskUpdateRequest
} from "../src";

const validators = {
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
});
