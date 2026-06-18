import type { ErrorCode, ErrorResponse } from "../../src";

export class InvalidCursorError extends Error {
  constructor(rawCursor: string) {
    super(`Invalid cursor parameter: ${rawCursor}`);
    this.name = "InvalidCursorError";
  }
}

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

export function jsonOrNotFound(value: unknown, message: string): Response {
  if (value === undefined) {
    if (message.startsWith("entity")) return protocolError(message, "ENTITY_NOT_FOUND", 404);
    if (message.startsWith("task")) return protocolError(message, "TASK_NOT_FOUND", 404);
    if (message.startsWith("object")) return protocolError(message, "OBJECT_NOT_FOUND", 404);
    return protocolError(message, "VALIDATION_ERROR", 404);
  }
  return json(value);
}

export async function readBody<T>(init: RequestInit): Promise<T> {
  return JSON.parse(String(init.body ?? "{}")) as T;
}

export function protocolError(message: string, error_code: ErrorCode, status: number): Response {
  return json({ success: false, message, error_code } satisfies ErrorResponse, status);
}

export function pageValues<T>(items: T[], limit: number, rawCursor: string | null): { items: T[]; hasMore: boolean; nextCursor?: string } {
  if (limit <= 0) {
    return { items, hasMore: false };
  }
  const offset = pageOffset(rawCursor);
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const hasMore = nextOffset < items.length;
  return {
    items: page,
    hasMore,
    nextCursor: hasMore ? String(nextOffset) : undefined
  };
}

function pageOffset(rawCursor: string | null): number {
  if (rawCursor === null) {
    return 0;
  }
  const offset = Number(rawCursor);
  if (!Number.isInteger(offset) || offset < 0 || String(offset) !== rawCursor) {
    throw new InvalidCursorError(rawCursor);
  }
  return offset;
}
