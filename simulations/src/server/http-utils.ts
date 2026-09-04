import { type IncomingMessage, type ServerResponse } from "node:http";
import { sanitizeErrorMessage } from "@the-drunken-coder/atlas-sdk";
import type { StartRunRequest } from "../shared/types.js";
import { isLoopbackHostname } from "./loopback.js";

const MUTATION_HEADER = "x-atlas-simulations-request";
const TARGET_API_KEY_HEADER = "x-atlas-target-api-key";
const MAX_REQUEST_API_KEY_BYTES = 16_384;

export class RequestBodyError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export async function readRequestText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > 1_000_000) {
      throw new RequestBodyError(413, "Request body is too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function drainRequestBody(request: IncomingMessage): Promise<void> {
  await readRequestText(request);
}

export function readRequestBody(bodyText: string): StartRunRequest {
  try {
    const body = readJSON(bodyText);
    if (!isRecord(body)) {
      throw new RequestBodyError(400, "Request body must be a JSON object");
    }
    if (typeof body.scenarioId !== "string") {
      throw new RequestBodyError(400, "scenarioId is required");
    }
    return body as StartRunRequest;
  } catch (error) {
    if (error instanceof RequestBodyError) {
      throw error;
    }
    throw new RequestBodyError(400, errorMessage(error));
  }
}

export function apiKeyForRequest(request: IncomingMessage): string | undefined {
  const header = request.headers[TARGET_API_KEY_HEADER];
  const value = Array.isArray(header) ? header.at(-1) : header;
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (Buffer.byteLength(trimmed, "utf8") > MAX_REQUEST_API_KEY_BYTES) {
    throw new RequestBodyError(400, "Atlas API key is too large");
  }
  return trimmed;
}

export function sendJSON(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(sanitizeResponseMessages(body)));
}

export function requireTrustedMutation(request: IncomingMessage, response: ServerResponse): boolean {
  if (hasTrustedMutation(request)) return true;
  response.setHeader("Connection", "close");
  sendJSON(response, 403, { message: "Mutating simulation requests require a local UI request header" });
  return false;
}

export function hasLoopbackHost(host: string | undefined): boolean {
  const hostUrl = urlForHost(host);
  return !!hostUrl && isLoopbackHostname(hostUrl.hostname);
}

export function safeDecodeURIComponent(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

export function errorMessage(error: unknown): string {
  return sanitizeErrorMessage(error, { fallback: "Unknown error" });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJSON(body: string): unknown {
  if (!body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new RequestBodyError(400, "Request body must be valid JSON");
  }
}

function sanitizeResponseMessages(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeResponseMessages);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      (key === "message" || key === "lastError") && typeof item === "string"
        ? sanitizeErrorMessage(item, { fallback: "Unknown error" })
        : sanitizeResponseMessages(item)
    ])
  );
}

function hasTrustedMutation(request: IncomingMessage): boolean {
  if (!hasLoopbackHost(request.headers.host)) return false;
  return request.headers.origin ? hasSameOrigin(request) : hasMutationHeader(request);
}

function hasMutationHeader(request: IncomingMessage): boolean {
  const value = request.headers[MUTATION_HEADER];
  return Array.isArray(value) ? value.includes("1") : value === "1";
}

function hasSameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  const hostUrl = urlForHost(request.headers.host);
  if (!origin || !hostUrl) return false;
  try {
    const originUrl = new URL(origin);
    return originUrl.protocol === "http:" && originUrl.host === hostUrl.host && isLoopbackHostname(originUrl.hostname);
  } catch {
    return false;
  }
}

function urlForHost(host: string | undefined): URL | undefined {
  if (!host) return undefined;
  try {
    return new URL(`http://${host}`);
  } catch {
    return undefined;
  }
}
