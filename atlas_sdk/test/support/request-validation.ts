import {
  isEntityCreateRequest,
  isEntityUpdateRequest,
  isObjectCreateRequest,
  isObjectUpdateRequest,
  isTaskCreateRequest,
  isTaskUpdateRequest,
  type EntityCreateRequest,
  type EntityUpdateRequest,
  type ObjectCreateRequest,
  type ObjectUpdateRequest,
  type TaskCreateRequest,
  type TaskUpdateRequest
} from "../../src";
import { protocolError, readBody } from "./http.js";

type RequestValidator<T> = (value: unknown) => value is T;

export const requestValidators = {
  entityCreate: isEntityCreateRequest,
  entityUpdate: isEntityUpdateRequest,
  objectCreate: isObjectCreateRequest,
  objectUpdate: isObjectUpdateRequest,
  taskCreate: isTaskCreateRequest,
  taskUpdate: isTaskUpdateRequest
} satisfies {
  entityCreate: RequestValidator<EntityCreateRequest>;
  entityUpdate: RequestValidator<EntityUpdateRequest>;
  objectCreate: RequestValidator<ObjectCreateRequest>;
  objectUpdate: RequestValidator<ObjectUpdateRequest>;
  taskCreate: RequestValidator<TaskCreateRequest>;
  taskUpdate: RequestValidator<TaskUpdateRequest>;
};

export async function readValidatedBody<T>(init: RequestInit, validate: RequestValidator<T>): Promise<T | Response> {
  let value: unknown;
  try {
    value = await readBody<unknown>(init);
  } catch {
    return protocolError("Invalid JSON body", "INVALID_JSON", 400);
  }
  if (!validate(value)) {
    return protocolError("Invalid JSON body", "INVALID_JSON", 400);
  }
  return value;
}
