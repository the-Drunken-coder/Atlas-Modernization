import { randomUUID } from "node:crypto";
import { AtlasClient, isAtlasAPIError } from "@the-drunken-coder/atlas-sdk";
import { runAcceptance } from "./support/stack.mjs";

const reproduction =
  "npm run build:sdk && node tests/acceptance/sdk-objects.mjs";
const initialBytes = Uint8Array.of(
  0,
  1,
  2,
  3,
  255,
  0,
  17,
  34,
  51,
  68,
  85,
  102,
  119,
  136,
  153,
  170,
  187,
  204,
  221,
  238,
);
const replacementBytes = Uint8Array.of(
  238,
  221,
  204,
  187,
  170,
  153,
  136,
  119,
  102,
  85,
  68,
  51,
  34,
  17,
  0,
  255,
  3,
  2,
  1,
  0,
  42,
  99,
  18,
);

await runAcceptance({
  name: "sdk-objects",
  reproduction,
  run: async ({ baseUrl, apiKey, record, signal }) => {
    const objectID = `object-${randomUUID()}`;
    const incompleteObjectID = `incomplete-${randomUUID()}`;
    const client = new AtlasClient({
      baseUrl,
      apiKey,
      sync: false,
      pollIntervalMs: 0,
      requestTimeoutMs: 10_000,
    });

    const initialUpload = await uploadObject(
      baseUrl,
      apiKey,
      objectID,
      initialBytes,
      {
        contentType: "application/x-atlas-initial-bytes",
        type: "acceptance-initial-object",
        signal,
      },
    );
    record({
      check: "initial Object upload completed through authenticated Core",
      expected: { status: 201 },
      actual: initialUpload,
      passed: initialUpload.status === 201,
    });

    const initialMetadata = await client.objects.get(objectID, {
      fresh: true,
      signal,
    });
    record({
      check: "initial Object metadata describes the stored byte fixture",
      expected: {
        object_id: objectID,
        type: "acceptance-initial-object",
        content_type: "application/x-atlas-initial-bytes",
        size_bytes: initialBytes.byteLength,
        bucket: "atlas-media",
        path: "stored",
      },
      actual: summarizeMetadata(initialMetadata),
      passed:
        initialMetadata.object_id === objectID &&
        initialMetadata.type === "acceptance-initial-object" &&
        initialMetadata.content_type === "application/x-atlas-initial-bytes" &&
        initialMetadata.size_bytes === initialBytes.byteLength &&
        initialMetadata.bucket === "atlas-media" &&
        typeof initialMetadata.path === "string" &&
        initialMetadata.path.length > 0,
    });

    const initialDownload = new Uint8Array(
      await client.objects.content(objectID),
    );
    record({
      check: "built SDK downloaded the initial Object byte for byte",
      expected: summarizeBytes(initialBytes),
      actual: summarizeBytes(initialDownload),
      passed: bytesEqual(initialDownload, initialBytes),
    });

    const replacementUpload = await uploadObject(
      baseUrl,
      apiKey,
      objectID,
      replacementBytes,
      {
        contentType: "application/x-atlas-replacement-bytes",
        type: "acceptance-replacement-object",
        signal,
      },
    );
    record({
      check: "replacement Object upload completed through authenticated Core",
      expected: { status: 201 },
      actual: replacementUpload,
      passed: replacementUpload.status === 201,
    });

    const replacementMetadata = await client.objects.get(objectID, {
      fresh: true,
      signal,
    });
    record({
      check: "replacement Object metadata points at the replacement content",
      expected: {
        object_id: objectID,
        type: "acceptance-replacement-object",
        content_type: "application/x-atlas-replacement-bytes",
        size_bytes: replacementBytes.byteLength,
        version_greater_than: initialMetadata.metadata.version,
        path_changed: true,
      },
      actual: {
        ...summarizeMetadata(replacementMetadata),
        path_changed: replacementMetadata.path !== initialMetadata.path,
      },
      passed:
        replacementMetadata.object_id === objectID &&
        replacementMetadata.type === "acceptance-replacement-object" &&
        replacementMetadata.content_type ===
          "application/x-atlas-replacement-bytes" &&
        replacementMetadata.size_bytes === replacementBytes.byteLength &&
        replacementMetadata.metadata.version >
          initialMetadata.metadata.version &&
        replacementMetadata.path !== initialMetadata.path,
    });

    const replacementDownload = new Uint8Array(
      await client.objects.content(objectID),
    );
    record({
      check:
        "built SDK downloaded replacement Object bytes without returning cached initial content",
      expected: summarizeBytes(replacementBytes),
      actual: summarizeBytes(replacementDownload),
      passed: bytesEqual(replacementDownload, replacementBytes),
    });

    await client.objects.delete(objectID);
    signal.throwIfAborted();
    const deletedMetadata = await atlasFailure(() =>
      client.objects.get(objectID, { fresh: true, signal }),
    );
    record({
      check:
        "deleted Object metadata is no longer readable through the built SDK",
      expected: { status: 404, error_code: "OBJECT_NOT_FOUND" },
      actual: deletedMetadata,
      passed:
        deletedMetadata.status === 404 &&
        deletedMetadata.error_code === "OBJECT_NOT_FOUND",
    });
    const deletedContent = await atlasFailure(() =>
      client.objects.content(objectID),
    );
    record({
      check:
        "deleted Object content is no longer downloadable through the built SDK",
      expected: { status: 404, error_code: "OBJECT_NOT_FOUND" },
      actual: deletedContent,
      passed:
        deletedContent.status === 404 &&
        deletedContent.error_code === "OBJECT_NOT_FOUND",
    });

    const incompleteUpload = await uploadIncompleteMultipart(
      baseUrl,
      apiKey,
      incompleteObjectID,
      initialBytes,
      signal,
    );
    record({
      check: "incomplete multipart Object upload is rejected before completion",
      expected: { status: 400, error_code: "INVALID_FORM" },
      actual: incompleteUpload,
      passed:
        incompleteUpload.status === 400 &&
        incompleteUpload.error_code === "INVALID_FORM",
    });
    const incompleteMetadata = await atlasFailure(() =>
      client.objects.get(incompleteObjectID, { fresh: true, signal }),
    );
    record({
      check:
        "failed upload does not expose incomplete Object metadata as completed",
      expected: { status: 404, error_code: "OBJECT_NOT_FOUND" },
      actual: incompleteMetadata,
      passed:
        incompleteMetadata.status === 404 &&
        incompleteMetadata.error_code === "OBJECT_NOT_FOUND",
    });
    const incompleteContent = await atlasFailure(() =>
      client.objects.content(incompleteObjectID),
    );
    record({
      check:
        "failed upload does not expose incomplete Object content as completed",
      expected: { status: 404, error_code: "OBJECT_NOT_FOUND" },
      actual: incompleteContent,
      passed:
        incompleteContent.status === 404 &&
        incompleteContent.error_code === "OBJECT_NOT_FOUND",
    });
  },
});

async function uploadObject(
  baseUrl,
  apiKey,
  objectID,
  bytes,
  { contentType, type, signal },
) {
  const form = new FormData();
  form.set("object_id", objectID);
  form.set("type", type);
  form.set("file", new Blob([bytes], { type: contentType }), "fixture.bin");
  const response = await fetch(`${baseUrl}/objects/upload`, {
    method: "POST",
    headers: { "X-API-Key": apiKey },
    body: form,
    signal,
  });
  return responseSummary(response);
}

async function uploadIncompleteMultipart(
  baseUrl,
  apiKey,
  objectID,
  bytes,
  signal,
) {
  const boundary = `AtlasAcceptance${randomUUID().replaceAll("-", "")}`;
  const prefix = new TextEncoder().encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="object_id"\r\n\r\n${objectID}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="incomplete.bin"\r\n` +
      "Content-Type: application/octet-stream\r\n\r\n",
  );
  const response = await fetch(`${baseUrl}/objects/upload`, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "X-API-Key": apiKey,
    },
    body: concatenateBytes(prefix, bytes),
    signal,
  });
  return responseSummary(response);
}

async function responseSummary(response) {
  const payload = await response.json().catch(() => undefined);
  return {
    status: response.status,
    ...(payload &&
    typeof payload === "object" &&
    "error_code" in payload &&
    typeof payload.error_code === "string"
      ? { error_code: payload.error_code }
      : {}),
  };
}

async function atlasFailure(operation) {
  try {
    await operation();
    return { status: 200 };
  } catch (error) {
    if (isAtlasAPIError(error))
      return { status: error.status, error_code: error.errorCode };
    return { error: String(error) };
  }
}

function summarizeMetadata(object) {
  return {
    object_id: object.object_id,
    type: object.type,
    content_type: object.content_type,
    size_bytes: object.size_bytes,
    bucket: object.bucket,
    path: object.path === null ? null : "stored",
    version: object.metadata.version,
  };
}

function summarizeBytes(bytes) {
  return {
    byte_length: bytes.byteLength,
    hex: Buffer.from(bytes).toString("hex"),
  };
}

function bytesEqual(actual, expected) {
  return (
    actual.byteLength === expected.byteLength &&
    actual.every((value, index) => value === expected[index])
  );
}

function concatenateBytes(...parts) {
  const byteLength = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}
