import assert from "node:assert/strict";
import test from "node:test";

import { validatePackageImage } from "./package-metadata-validation.mjs";

const digest = "a".repeat(64);

test("package images are production GHCR digests by default", () => {
  assert.doesNotThrow(() => validatePackageImage(null));
  assert.doesNotThrow(() => validatePackageImage(`ghcr.io/the-drunken-coder/atlas-core@sha256:${digest}`));
  assert.throws(() => validatePackageImage(`localhost:5000/atlas-core@sha256:${digest}`));
});

test("the isolated CI registry is accepted only in explicit test mode", () => {
  assert.doesNotThrow(() => validatePackageImage(`localhost:5000/atlas-core@sha256:${digest}`, true));
  assert.throws(() => validatePackageImage(`registry.example/atlas-core@sha256:${digest}`, true));
  assert.throws(() => validatePackageImage("localhost:5000/atlas-core:latest", true));
});
