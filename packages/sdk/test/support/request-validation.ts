import {
  type EntityCheckInRequest,
  type EntityCreateRequest,
  type EntityUpdateRequest,
  type ErrorCode,
  isEntityCheckInRequest,
  isEntityCreateRequest,
  isEntityUpdateRequest,
  isObjectCreateRequest,
  isObjectUpdateRequest,
  isRuntimeReadyRequest,
  isRuntimeRegistrationRequest,
  isRuntimeStopRequest,
  isTaskAcknowledgeRequest,
  isTaskCancelRequest,
  isTaskCompleteRequest,
  isTaskCreateRequest,
  isTaskFailRequest,
  isTaskProgressRequest,
  isTaskStartRequest,
  type ObjectCreateRequest,
  type ObjectUpdateRequest,
  type RuntimeReadyRequest,
  type RuntimeRegistrationRequest,
  type RuntimeStopRequest,
  type TaskAcknowledgeRequest,
  type TaskCancelRequest,
  type TaskCompleteRequest,
  type TaskCreateRequest,
  type TaskFailRequest,
  type TaskProgressRequest,
  type TaskStartRequest
} from "../../src";
import { protocolError, readBody } from "./http.js";

type RequestValidator<T> = (value: unknown) => value is T;

export const requestValidators = {
  entityCheckIn: isEntityCheckInRequest,
  entityCreate: isEntityCreateRequest,
  entityUpdate: isEntityUpdateRequest,
  objectCreate: isObjectCreateRequest,
  objectUpdate: isObjectUpdateRequest,
  runtimeReady: isRuntimeReadyRequest,
  runtimeRegistration: isRuntimeRegistrationRequest,
  runtimeStop: isRuntimeStopRequest,
  taskAcknowledge: isTaskAcknowledgeRequest,
  taskCancel: isTaskCancelRequest,
  taskComplete: isTaskCompleteRequest,
  taskCreate: isTaskCreateRequest,
  taskFail: isTaskFailRequest,
  taskProgress: isTaskProgressRequest,
  taskStart: isTaskStartRequest
} satisfies {
  entityCheckIn: RequestValidator<EntityCheckInRequest>;
  entityCreate: RequestValidator<EntityCreateRequest>;
  entityUpdate: RequestValidator<EntityUpdateRequest>;
  objectCreate: RequestValidator<ObjectCreateRequest>;
  objectUpdate: RequestValidator<ObjectUpdateRequest>;
  runtimeReady: RequestValidator<RuntimeReadyRequest>;
  runtimeRegistration: RequestValidator<RuntimeRegistrationRequest>;
  runtimeStop: RequestValidator<RuntimeStopRequest>;
  taskAcknowledge: RequestValidator<TaskAcknowledgeRequest>;
  taskCancel: RequestValidator<TaskCancelRequest>;
  taskComplete: RequestValidator<TaskCompleteRequest>;
  taskCreate: RequestValidator<TaskCreateRequest>;
  taskFail: RequestValidator<TaskFailRequest>;
  taskProgress: RequestValidator<TaskProgressRequest>;
  taskStart: RequestValidator<TaskStartRequest>;
};

export async function readValidatedBody<T>(
  init: RequestInit,
  validate: RequestValidator<T>,
  validationErrorCode: ErrorCode = "INVALID_JSON"
): Promise<T | Response> {
  let value: unknown;
  try {
    value = await readBody<unknown>(init);
  } catch {
    return protocolError("Invalid JSON body", "INVALID_JSON", 400);
  }
  if (!validate(value)) {
    return protocolError("Invalid JSON body", validationErrorCode, 400);
  }
  return value;
}
