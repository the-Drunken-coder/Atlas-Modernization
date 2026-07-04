import type { EntityResource, ObjectResource, TaskCreateRequest, TaskResource } from "../../src";

export function entity(id: string): EntityResource {
  return { entity_id: id, entity_type: "asset", subtype: null, alias: null, components: {}, metadata: metadata(0) };
}

export function task(id: string, entity_id: string | null): TaskResource {
  return { task_id: id, status: "pending", entity_id, components: {}, metadata: metadata(0) };
}

export function taskFromCreateRequest(request: TaskCreateRequest): TaskResource {
  return {
    task_id: "task_id" in request ? request.task_id : `command-${request.components.command.id ?? request.components.command.type}`,
    status: request.status ?? "pending",
    entity_id: request.entity_id ?? null,
    components: request.components ?? {},
    ...(request.extra === undefined ? {} : { extra: request.extra }),
    metadata: metadata(0)
  };
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
