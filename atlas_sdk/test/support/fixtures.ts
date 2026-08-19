import type { EntityResource, ObjectResource, TaskCreateRequest, TaskResource } from "../../src";

export type FakeTaskResource = TaskResource & { readonly metadata: ReturnType<typeof metadata> };

export function entity(id: string): EntityResource {
  return { entity_id: id, entity_type: "asset", subtype: null, alias: null, components: {}, metadata: metadata(0) };
}

export function task(id: string, assetId: string): FakeTaskResource {
  return withTaskMetadata(
    {
      task_id: id,
      asset_id: assetId,
      command: "fixture.queued",
      input: { value: id },
      status: "pending",
      created_at: "2026-06-12T12:00:00Z",
      updated_at: "2026-06-12T12:00:00Z"
    },
    0
  );
}

export function taskFromCreateRequest(request: TaskCreateRequest): FakeTaskResource {
  return withTaskMetadata(
    {
      task_id: `task-${crypto.randomUUID()}`,
      asset_id: request.asset_id,
      command: request.command,
      input: request.input,
      status: "pending",
      created_at: "2026-06-12T12:00:00Z",
      updated_at: "2026-06-12T12:00:00Z"
    },
    0
  );
}

export function object(id: string): ObjectResource {
  return {
    object_id: id,
    path: null,
    content_type: null,
    type: "image",
    size_bytes: null,
    usage_hints: [],
    bucket: null,
    metadata: metadata(0)
  };
}

export function metadata(version: number) {
  return { created_at: "2026-06-12T12:00:00Z", updated_at: "2026-06-12T12:00:00Z", version };
}

export function withTaskMetadata(task: TaskResource, version: number): FakeTaskResource {
  const value = { ...task } as FakeTaskResource;
  Object.defineProperty(value, "metadata", { value: metadata(version), enumerable: false });
  return value;
}
