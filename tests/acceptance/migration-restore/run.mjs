import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect, isDeepStrictEqual } from "node:util";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const composeFile = join(repositoryRoot, "tests", "acceptance", "migration-restore", "compose.yml");
const observerScript = join(repositoryRoot, "tests", "acceptance", "migration-restore", "observer.mjs");
const protocolSchemaPath = join(
  repositoryRoot,
  "packages",
  "protocol",
  "schema",
  "jsonschema",
  "atlas.schema.json"
);
const mode = parseMode(process.argv.slice(2));
const runUUID = randomUUID();
const runID = `migration-restore-${runUUID}`;
const project = `atlas_mr_${runUUID.replaceAll("-", "_")}`;
const image = `atlas-migration-restore:${runUUID}`;
const artifacts = artifactDirectory(runUUID);
const backupDirectory = join(artifacts, "backup");
const controlDirectory = join(artifacts, "observer-control");
const commandLog = join(artifacts, "commands.log");
const evidenceLog = join(artifacts, "evidence.jsonl");
const httpLog = join(artifacts, "http.jsonl");
const credentials = createCredentials();
const bucket = `atlas-mr-${runUUID}`;
const entityID = `entity-${randomUUID()}`;
const objectID = `object-${randomUUID()}`;
const objectBytes = Buffer.from(`Atlas paired restore marker ${randomUUID()}\n`, "utf8");
const replacementBytes = Buffer.from(`Atlas post-backup replacement ${randomUUID()}\n`, "utf8");
const environment = {
  ...process.env,
  ATLAS_MIGRATION_RUN_ID: runID,
  ATLAS_MIGRATION_CORE_IMAGE: image,
  ATLAS_MIGRATION_BUCKET: bucket,
  ATLAS_MIGRATION_ARTIFACTS: artifacts,
  POSTGRES_PASSWORD: credentials.postgresPassword,
  MINIO_ROOT_USER: "atlas",
  MINIO_ROOT_PASSWORD: credentials.minioPassword,
  API_AUTH_KEY: credentials.apiKey,
  ATLAS_ADMIN_PASSWORD: credentials.adminPassword
};
const compose = [
  "compose",
  "--ansi",
  "never",
  "--project-name",
  project,
  "--file",
  composeFile
];
const scenarioTimeoutMs = mode === "nightly" ? 45 * 60_000 : 25 * 60_000;
const scenarioAbort = new AbortController();
const activeChildren = new Set();

let ownsProject = false;
let observer;
let primaryBaseURL;
let failure;
let diagnosticsFailure;
let cleanupFailure;
let interruptedSignal;
let scenarioTimer;

const startedAt = new Date();
const revision = (await capture("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })).trim();
const workingTree = (await capture("git", ["status", "--short"], { cwd: repositoryRoot })).trim();
const metadata = {
  scenario: "migration-restore",
  mode,
  run_id: runID,
  compose_project: project,
  revision,
  working_tree: workingTree || "clean",
  reproduction:
    mode === "nightly"
      ? "node tests/acceptance/migration-restore/run.mjs --nightly"
      : "node tests/acceptance/migration-restore/run.mjs",
  started_at: startedAt.toISOString(),
  timeout_ms: scenarioTimeoutMs,
  artifacts
};
writeJSON(join(artifacts, "run.json"), { ...metadata, status: "starting" });
process.stdout.write(
  `Atlas migration/restore acceptance\nrevision: ${revision}${workingTree ? " (working tree has changes)" : ""}\n` +
    `mode: ${mode}\nrun: ${runID}\nartifacts: ${artifacts}\nreproduce: ${metadata.reproduction}\n`
);

const onSignal = (signal) => {
  interruptedSignal = signal;
  scenarioAbort.abort(new Error(`migration/restore acceptance interrupted by ${signal}`));
  for (const child of activeChildren) child.kill("SIGTERM");
};
const onInterrupt = () => onSignal("SIGINT");
const onTerminate = () => onSignal("SIGTERM");
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onTerminate);

try {
  scenarioTimer = setTimeout(() => {
    scenarioAbort.abort(new Error(`migration/restore acceptance exceeded ${scenarioTimeoutMs} ms`));
    for (const child of activeChildren) child.kill("SIGTERM");
  }, scenarioTimeoutMs);

  await preflight();
  ownsProject = true;
  await execute("docker", [...compose, "build", "api"], {
    cwd: repositoryRoot,
    env: environment,
    logPath: commandLog,
    timeoutMs: 10 * 60_000,
    signal: scenarioAbort.signal
  });
  await execute("docker", [...compose, "pull", "postgres", "minio", "minio-client"], {
    cwd: repositoryRoot,
    env: environment,
    logPath: commandLog,
    timeoutMs: 10 * 60_000,
    signal: scenarioAbort.signal
  });
  await startDependencies();
  await provisionBucket();
  primaryBaseURL = await startAPI();

  const baseline = await createBaseline();
  const initialLedger = await readMigrationLedger("initial");
  assertMigrationLedger(initialLedger, "clean-start migration ledger");

  const containerBeforeRestart = await apiContainerID();
  await composeExecute(["restart", "--no-deps", "api"], 120_000);
  await waitForReadiness(primaryBaseURL, 90_000);
  const containerAfterRestart = await apiContainerID();
  record({
    check: "Core process restarted while the owned container and durable volumes remained",
    expected: { same_container: true, container_id: containerBeforeRestart },
    actual: { same_container: containerAfterRestart === containerBeforeRestart, container_id: containerAfterRestart },
    passed: containerBeforeRestart.length > 0 && containerAfterRestart === containerBeforeRestart
  });
  await verifyBaseline(baseline, "after Core restart");
  const restartLedger = await readMigrationLedger("restart");
  recordDeepEqual("migration ledger remained stable across Core restart", initialLedger, restartLedger);

  await composeExecute(["stop", "api"], 120_000);
  await backupPair(initialLedger);
  await composeExecute(["start", "api"], 120_000);
  await waitForReadiness(primaryBaseURL, 90_000);
  await createPostBackupChanges(baseline);

  observer = startObserver();
  const observerReady = await waitForJSON(join(controlDirectory, "ready.json"), 10 * 60_000, scenarioAbort.signal);
  record({
    check: "separate UUID-owned acceptance stack became ready",
    expected: { ready: true, distinct_artifacts: true },
    actual: { ready: true, artifacts: observerReady.artifacts },
    passed: typeof observerReady.artifacts === "string" && resolve(observerReady.artifacts) !== resolve(artifacts)
  });

  await composeExecute(["stop", "api"], 120_000);
  const activityStartedAt = new Date();
  writeJSON(join(controlDirectory, "activity-start.json"), { started_at: activityStartedAt.toISOString() });
  const restorePromise = restorePair("paired-restore-with-concurrent-observer");
  const observerActivityPromise = waitForJSON(
    join(controlDirectory, "activity-observed.json"),
    10 * 60_000,
    scenarioAbort.signal
  );
  const [restoreWindow] = await Promise.all([restorePromise, observerActivityPromise]);
  const activityCompletedAt = new Date();
  writeJSON(join(controlDirectory, "activity-complete.json"), { completed_at: activityCompletedAt.toISOString() });
  await observer.exit;
  observer = undefined;
  const observerActivity = JSON.parse(readFileSync(join(controlDirectory, "activity-report.json"), "utf8"));
  assertObserverOverlap(observerActivity, restoreWindow.startedAt, restoreWindow.completedAt);

  await composeExecute(["start", "api"], 120_000);
  await waitForReadiness(primaryBaseURL, 90_000);
  await verifyBaseline(baseline, "after paired restore");
  const restoredLedger = await readMigrationLedger("restored");
  recordDeepEqual("paired restore recovered the exact migration ledger", initialLedger, restoredLedger);

  await proveIncompleteStorageFailure(baseline);
  await proveIncompatibleMigrationFailure(baseline, initialLedger);
  if (mode === "nightly") await proveSchemaDriftFailure(baseline, initialLedger);

  record({
    check: "all migration/restore environments use opaque UUID ownership",
    expected: { run_uuid: true, resource_ids_max: 50, bucket_is_owned: true },
    actual: {
      run_uuid: runID.endsWith(runUUID),
      resource_id_lengths: { entity: entityID.length, object: objectID.length },
      bucket
    },
    passed:
      runID.endsWith(runUUID) &&
      entityID.length <= 50 &&
      objectID.length <= 50 &&
      bucket === `atlas-mr-${runUUID}`
  });
} catch (error) {
  failure = error;
} finally {
  clearTimeout(scenarioTimer);
  if (observer) {
    observer.child.kill("SIGTERM");
    try {
      await observer.exit;
    } catch (error) {
      failure ??= error;
    }
  }
  if (ownsProject) {
    try {
      await collectDiagnostics();
    } catch (error) {
      diagnosticsFailure = error;
      failure ??= error;
    }
    try {
      await cleanupOwnedResources();
    } catch (error) {
      cleanupFailure = error;
      failure ??= error;
    }
  }
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onTerminate);
}

if (interruptedSignal) failure ??= new Error(`migration/restore acceptance interrupted by ${interruptedSignal}`);
const completedAt = new Date();
const result = {
  ...metadata,
  ...(primaryBaseURL ? { core_base_url: primaryBaseURL } : {}),
  status: failure ? "failed" : "passed",
  completed_at: completedAt.toISOString(),
  duration_ms: completedAt.getTime() - startedAt.getTime(),
  ...(failure ? { failure: serializeError(failure) } : {}),
  ...(diagnosticsFailure ? { diagnostics_failure: serializeError(diagnosticsFailure) } : {}),
  ...(cleanupFailure ? { cleanup_failure: serializeError(cleanupFailure) } : {})
};
writeJSON(join(artifacts, "result.json"), result);
if (failure) {
  process.stderr.write(
    `Migration/restore acceptance failed at revision ${revision}.\n` +
      `Expected/actual evidence: ${evidenceLog}\nHTTP exchanges: ${httpLog}\n` +
      `Compose diagnostics: ${join(artifacts, "compose.log")}\nReproduce: ${metadata.reproduction}\n`
  );
  throw failure;
}
process.stdout.write(`Migration/restore acceptance passed in ${result.duration_ms} ms. Evidence: ${artifacts}\n`);

async function preflight() {
  if (Number(process.versions.node.split(".")[0]) < 24) {
    throw new Error(`Node 24 or newer is required; found ${process.version}`);
  }
  for (const id of [entityID, objectID]) assertResourceID(id);
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket)) {
    throw new Error(`generated MinIO bucket violates the published 3-63 character contract: ${bucket}`);
  }
  const orderA = { resource: { id: "semantic", metadata: { version: 1, owner: "atlas" } }, status: "ready" };
  const orderB = { status: "ready", resource: { metadata: { owner: "atlas", version: 1 }, id: "semantic" } };
  if (!isDeepStrictEqual(orderA, orderB)) throw new Error("Node semantic deep comparison preflight failed");

  const schema = JSON.parse(readFileSync(protocolSchemaPath, "utf8"));
  const entityMax = schema.$defs.EntityCreateRequest.properties.entity_id.maxLength;
  const objectMax = schema.$defs.ObjectCreateRequest.properties.object_id.maxLength;
  if (entityMax !== 50 || objectMax !== 50) {
    throw new Error(`published resource ID limits changed: Entity=${entityMax}, Object=${objectMax}`);
  }
  await execute("docker", ["version", "--format", "{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}"], {
    cwd: repositoryRoot,
    logPath: commandLog,
    timeoutMs: 30_000,
    signal: scenarioAbort.signal
  });
  await execute("docker", ["compose", "version"], {
    cwd: repositoryRoot,
    logPath: commandLog,
    timeoutMs: 30_000,
    signal: scenarioAbort.signal
  });
  await execute("docker", [...compose, "config", "--quiet"], {
    cwd: repositoryRoot,
    env: environment,
    logPath: commandLog,
    timeoutMs: 30_000,
    signal: scenarioAbort.signal
  });
  writeJSON(join(artifacts, "preflight.json"), {
    node: process.version,
    semantic_comparison: "node:util isDeepStrictEqual",
    entity_id_max_length: entityMax,
    object_id_max_length: objectMax,
    upload_limit_mb: 100,
    migration_expectation: "contiguous ledger beginning at version 1; no fixed latest version"
  });
}

async function startDependencies() {
  await composeExecute(["up", "--detach", "--wait", "postgres", "minio"], 180_000);
}

async function provisionBucket() {
  await runMinio(
    [
      "set -eu",
      'mc alias set atlas http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null',
      'mc mb --ignore-existing "atlas/$MINIO_BUCKET" >/dev/null',
      'mc anonymous set none "atlas/$MINIO_BUCKET" >/dev/null',
      'mc stat "atlas/$MINIO_BUCKET"'
    ].join("\n"),
    "provision-bucket.log"
  );
}

async function startAPI() {
  await composeExecute(["up", "--detach", "--no-deps", "api"], 120_000);
  const portOutput = await composeCapture(["port", "api", "8000"], 30_000);
  const portMatch = portOutput.trim().match(/127\.0\.0\.1:(\d+)$/u);
  if (!portMatch) throw new Error(`could not parse owned Core port from ${inspect(portOutput.trim())}`);
  const baseURL = `http://127.0.0.1:${portMatch[1]}`;
  await waitForReadiness(baseURL, 90_000);
  writeJSON(join(artifacts, "stack.json"), {
    run_id: runID,
    compose_project: project,
    core_image: image,
    core_base_url: baseURL,
    bucket,
    storage: {
      postgres_volume: `${project}_postgres_data`,
      minio_volume: `${project}_minio_data`
    }
  });
  return baseURL;
}

async function createBaseline() {
  const createdEntity = await requestJSON("create-entity", "/entities", {
    method: "POST",
    body: {
      entity_id: entityID,
      entity_type: "asset",
      alias: "migration-restore-baseline",
      extra: { restore_probe: { enabled: true, sequence: [3, 1, 2] } }
    },
    expectedStatus: 201
  });
  record({
    check: "public Entity create reached the migration-owned Core",
    expected: { entity_id: entityID, alias: "migration-restore-baseline", version_positive: true },
    actual: summarizeEntity(createdEntity),
    passed:
      createdEntity.entity_id === entityID &&
      createdEntity.alias === "migration-restore-baseline" &&
      Number.isInteger(createdEntity.metadata?.version) &&
      createdEntity.metadata.version > 0
  });

  const uploadedObject = await uploadObject(objectBytes, "application/octet-stream", "baseline");
  record({
    check: "public Object upload stored metadata in PostgreSQL and bytes in MinIO",
    expected: {
      object_id: objectID,
      content_type: "application/octet-stream",
      size_bytes: objectBytes.length,
      version_positive: true
    },
    actual: summarizeObject(uploadedObject),
    passed:
      uploadedObject.object_id === objectID &&
      uploadedObject.content_type === "application/octet-stream" &&
      uploadedObject.size_bytes === objectBytes.length &&
      Number.isInteger(uploadedObject.metadata?.version) &&
      uploadedObject.metadata.version > 0
  });

  const entity = await requestJSON("baseline-entity", `/entities/${encodeURIComponent(entityID)}`, {
    expectedStatus: 200
  });
  const object = await requestJSON("baseline-object", `/objects/${encodeURIComponent(objectID)}`, {
    expectedStatus: 200
  });
  const bytes = await downloadObject("baseline-object-bytes");
  record({
    check: "downloaded baseline Object bytes match the uploaded payload",
    expected: { sha256: sha256(objectBytes), bytes: objectBytes.length },
    actual: { sha256: sha256(bytes), bytes: bytes.length },
    passed: bytes.equals(objectBytes)
  });
  const snapshot = { entity, object, object_sha256: sha256(bytes), object_bytes: bytes.length };
  writeJSON(join(artifacts, "baseline-snapshot.json"), snapshot);
  return snapshot;
}

async function verifyBaseline(baseline, phase) {
  const entity = await requestJSON(`${slug(phase)}-entity`, `/entities/${encodeURIComponent(entityID)}`, {
    expectedStatus: 200
  });
  const object = await requestJSON(`${slug(phase)}-object`, `/objects/${encodeURIComponent(objectID)}`, {
    expectedStatus: 200
  });
  const bytes = await downloadObject(`${slug(phase)}-object-bytes`);
  recordDeepEqual(`${phase}: Entity data and metadata match the pre-backup snapshot`, baseline.entity, entity);
  recordDeepEqual(`${phase}: Object data and metadata match the pre-backup snapshot`, baseline.object, object);
  record({
    check: `${phase}: Object bytes match the pre-backup snapshot`,
    expected: { sha256: baseline.object_sha256, bytes: baseline.object_bytes },
    actual: { sha256: sha256(bytes), bytes: bytes.length },
    passed: bytes.length === baseline.object_bytes && sha256(bytes) === baseline.object_sha256
  });
}

async function createPostBackupChanges(baseline) {
  const changedEntity = await requestJSON("post-backup-entity-update", `/entities/${encodeURIComponent(entityID)}`, {
    method: "PATCH",
    headers: { "If-Match": `"v${baseline.entity.metadata.version}"` },
    body: { alias: "migration-restore-post-backup" },
    expectedStatus: 200
  });
  const changedObject = await uploadObject(replacementBytes, "application/octet-stream", "post-backup");
  const changedBytes = await downloadObject("post-backup-object-bytes");
  record({
    check: "post-backup Entity and Object changes establish a meaningful restore boundary",
    expected: {
      entity_version_after: `>${baseline.entity.metadata.version}`,
      object_version_after: `>${baseline.object.metadata.version}`,
      object_sha256_changed: true
    },
    actual: {
      entity_version: changedEntity.metadata.version,
      object_version: changedObject.metadata.version,
      object_sha256: sha256(changedBytes)
    },
    passed:
      changedEntity.metadata.version > baseline.entity.metadata.version &&
      changedObject.metadata.version > baseline.object.metadata.version &&
      changedBytes.equals(replacementBytes) &&
      !changedBytes.equals(objectBytes)
  });
}

async function uploadObject(bytes, contentType, label) {
  const form = new FormData();
  form.set("object_id", objectID);
  form.set("type", "migration_restore_probe");
  form.set("usage_hint", "durability");
  form.set("file", new Blob([bytes], { type: contentType }), `${label}.bin`);
  return requestJSON(`${label}-object-upload`, "/objects/upload", {
    method: "POST",
    body: form,
    expectedStatus: 201
  });
}

async function downloadObject(label) {
  const response = await requestRaw(label, `/objects/${encodeURIComponent(objectID)}/download`, {
    expectedStatus: 200
  });
  return response.body;
}

async function requestJSON(label, path, options = {}) {
  const response = await requestRaw(label, path, options);
  try {
    return JSON.parse(response.body.toString("utf8"));
  } catch (error) {
    throw new Error(`${options.method ?? "GET"} ${path} returned malformed JSON: ${error.message}`);
  }
}

async function requestRaw(label, path, options = {}) {
  scenarioAbort.signal.throwIfAborted();
  const { method = "GET", body, headers = {}, expectedStatus } = options;
  const requestHeaders = { "X-API-Key": credentials.apiKey, "X-Request-ID": randomUUID(), ...headers };
  let requestBody = body;
  if (body !== undefined && !(body instanceof FormData)) {
    requestHeaders["Content-Type"] = "application/json";
    requestBody = JSON.stringify(body);
  }
  const response = await fetch(`${primaryBaseURL}${path}`, {
    method,
    headers: requestHeaders,
    body: requestBody,
    signal: AbortSignal.any([scenarioAbort.signal, AbortSignal.timeout(30_000)])
  });
  const responseBody = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") ?? "";
  const exchange = {
    timestamp: new Date().toISOString(),
    label,
    method,
    path,
    expected_status: expectedStatus,
    actual_status: response.status,
    content_type: contentType,
    body:
      contentType.includes("json") || contentType.startsWith("text/")
        ? responseBody.toString("utf8")
        : { sha256: sha256(responseBody), bytes: responseBody.length }
  };
  appendJSONLine(httpLog, exchange);
  if (response.status !== expectedStatus) {
    const error = new Error(
      `${method} ${path}: expected HTTP ${expectedStatus}, observed ${response.status}: ${responseBody.toString("utf8")}`
    );
    error.httpExchange = exchange;
    throw error;
  }
  return { response, body: responseBody };
}

async function readMigrationLedger(label) {
  const output = await postgresCapture(
    [
      "psql",
      "-At",
      "-F",
      "|",
      "-U",
      "atlas",
      "-d",
      "atlas_core",
      "-c",
      "SELECT version, name, checksum, fingerprint_version, schema_fingerprint FROM atlas_schema_migrations ORDER BY version"
    ],
    60_000
  );
  const ledger = output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [version, name, checksum, fingerprintVersion, schemaFingerprint] = line.split("|");
      return {
        version: Number(version),
        name,
        checksum,
        fingerprint_version: Number(fingerprintVersion),
        schema_fingerprint: schemaFingerprint
      };
    });
  writeJSON(join(artifacts, `migration-ledger-${label}.json`), ledger);
  return ledger;
}

function assertMigrationLedger(ledger, label) {
  let passed = ledger.length > 0;
  for (let index = 0; index < ledger.length; index += 1) {
    const migration = ledger[index];
    passed &&= migration.version === index + 1;
    passed &&= typeof migration.name === "string" && migration.name.length > 0;
    passed &&= /^[a-f0-9]{64}$/u.test(migration.checksum);
    passed &&= Number.isInteger(migration.fingerprint_version) && migration.fingerprint_version > 0;
    passed &&= /^[a-f0-9]{64}$/u.test(migration.schema_fingerprint);
  }
  record({
    check: `${label} is contiguous and carries immutable checksums and fingerprints`,
    expected: { first_version: 1, contiguous: true, checksum_and_fingerprint_sha256: true },
    actual: {
      versions: ledger.map(({ version }) => version),
      latest_name: ledger.at(-1)?.name,
      latest_version: ledger.at(-1)?.version
    },
    passed
  });
}

async function backupPair(expectedLedger) {
  mkdirSync(join(backupDirectory, "minio"), { recursive: true });
  writeJSON(join(backupDirectory, "application.json"), { revision, run_id: runID });
  writeJSON(join(backupDirectory, "schema-migrations.json"), expectedLedger);

  const dump = await postgresCaptureBuffer(
    ["pg_dump", "-U", "atlas", "-d", "atlas_core", "--format=custom", "--no-owner", "--no-privileges"],
    180_000
  );
  const dumpPath = join(backupDirectory, "postgres.dump");
  writeFileSync(dumpPath, dump);
  const contents = await postgresCaptureBuffer(["pg_restore", "--list"], 60_000, dump);
  writeFileSync(join(backupDirectory, "postgres.contents.txt"), contents);

  await runMinio(
    [
      "set -eu",
      'mc alias set atlas http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null',
      'rm -rf "/evidence/backup/minio/$MINIO_BUCKET"',
      'mkdir -p "/evidence/backup/minio/$MINIO_BUCKET"',
      'mc mirror --overwrite "atlas/$MINIO_BUCKET" "/evidence/backup/minio/$MINIO_BUCKET"',
      'mc ls --recursive "atlas/$MINIO_BUCKET"'
    ].join("\n"),
    "minio-backup.log"
  );
  writeFileSync(join(backupDirectory, "minio.complete"), `${bucket}\n`);
  await validateBackupPair();
  record({
    check: "paired backup contains a readable PostgreSQL archive and the matching MinIO bytes",
    expected: { postgres_dump_nonempty: true, minio_file_count: ">=1", bucket },
    actual: {
      postgres_dump_bytes: dump.length,
      postgres_dump_sha256: sha256(dump),
      minio_file_count: filesUnder(join(backupDirectory, "minio", bucket)).length,
      bucket_marker: readFileSync(join(backupDirectory, "minio.complete"), "utf8").trim()
    },
    passed:
      dump.length > 0 &&
      filesUnder(join(backupDirectory, "minio", bucket)).length > 0 &&
      readFileSync(join(backupDirectory, "minio.complete"), "utf8").trim() === bucket
  });
}

async function validateBackupPair() {
  const dumpPath = join(backupDirectory, "postgres.dump");
  const markerPath = join(backupDirectory, "minio.complete");
  const minioPath = join(backupDirectory, "minio", bucket);
  if (!existsSync(dumpPath) || statSync(dumpPath).size === 0) throw new Error("paired restore PostgreSQL dump is absent or empty");
  if (!existsSync(markerPath) || readFileSync(markerPath, "utf8").trim() !== bucket) {
    throw new Error("paired restore MinIO completion marker is absent or names another bucket");
  }
  if (filesUnder(minioPath).length === 0) throw new Error("paired restore MinIO mirror contains no object bytes");
  await postgresCaptureBuffer(["pg_restore", "--list"], 60_000, readFileSync(dumpPath));
}

async function restorePair(label) {
  const started = new Date();
  await validateBackupPair();
  await postgresExecute(["dropdb", "-U", "atlas", "--if-exists", "atlas_core"], 60_000);
  await postgresExecute(["createdb", "-U", "atlas", "atlas_core"], 60_000);
  await postgresExecute(
    ["pg_restore", "-U", "atlas", "-d", "atlas_core", "--exit-on-error", "--no-owner", "--no-privileges"],
    180_000,
    readFileSync(join(backupDirectory, "postgres.dump"))
  );
  await restoreMinioBackup();
  const completed = new Date();
  appendJSONLine(evidenceLog, {
    timestamp: completed.toISOString(),
    check: label,
    expected: { paired_database_and_minio_restore: true },
    actual: { started_at: started.toISOString(), completed_at: completed.toISOString() },
    passed: true
  });
  return { startedAt: started, completedAt: completed };
}

async function restoreMinioBackup() {
  const result = await runMinio(
    [
      "set -eu",
      'mc alias set atlas http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null',
      'mc mb --ignore-existing "atlas/$MINIO_BUCKET" >/dev/null',
      'mc rm --recursive --force "atlas/$MINIO_BUCKET" >/dev/null',
      'mc mirror --overwrite --remove "/evidence/backup/minio/$MINIO_BUCKET" "atlas/$MINIO_BUCKET"',
      'mc diff "/evidence/backup/minio/$MINIO_BUCKET" "atlas/$MINIO_BUCKET"'
    ].join("\n"),
    "minio-restore.log",
    true
  );
  if (result.stdout.trim() !== "") {
    throw new Error(`MinIO restore differs from the paired mirror: ${result.stdout.trim()}`);
  }
}

async function proveIncompleteStorageFailure(baseline) {
  await composeExecute(["stop", "api"], 120_000);
  await runMinio(
    [
      "set -eu",
      'mc alias set atlas http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null',
      'mc rm --recursive --force "atlas/$MINIO_BUCKET" >/dev/null',
      'mc rb "atlas/$MINIO_BUCKET"'
    ].join("\n"),
    "minio-remove-for-incomplete-proof.log"
  );
  await composeExecute(["up", "--detach", "--no-deps", "api"], 120_000);
  await expectAPIExit(
    "incomplete-storage",
    `durable storage bucket \\"${bucket}\\" does not exist; restore the paired MinIO backup before startup`
  );
  await restoreMinioBackup();
  await composeExecute(["start", "api"], 120_000);
  await waitForReadiness(primaryBaseURL, 90_000);
  await verifyBaseline(baseline, "after recovery from incomplete storage rejection");
}

async function proveIncompatibleMigrationFailure(baseline, initialLedger) {
  await composeExecute(["stop", "api"], 120_000);
  await postgresExecute(
    [
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "atlas",
      "-d",
      "atlas_core",
      "-c",
      "UPDATE atlas_schema_migrations SET checksum = repeat('0', 64) WHERE version = (SELECT max(version) FROM atlas_schema_migrations)"
    ],
    60_000
  );
  await composeExecute(["up", "--detach", "--no-deps", "api"], 120_000);
  await expectAPIExit("incompatible-migration-history", "database: invalid schema migration history");
  await restorePair("recovery restore after incompatible migration history proof");
  await composeExecute(["start", "api"], 120_000);
  await waitForReadiness(primaryBaseURL, 90_000);
  await verifyBaseline(baseline, "after incompatible migration history recovery");
  recordDeepEqual(
    "incompatible migration recovery restored the original ledger",
    initialLedger,
    await readMigrationLedger("incompatible-recovery")
  );
}

async function proveSchemaDriftFailure(baseline, initialLedger) {
  await composeExecute(["stop", "api"], 120_000);
  await postgresExecute(
    [
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "atlas",
      "-d",
      "atlas_core",
      "-c",
      "ALTER TABLE entities ADD COLUMN migration_restore_nightly_drift TEXT"
    ],
    60_000
  );
  await composeExecute(["up", "--detach", "--no-deps", "api"], 120_000);
  await expectAPIExit("nightly-schema-drift", "database: schema drift detected");
  await restorePair("nightly recovery restore after schema drift proof");
  await composeExecute(["start", "api"], 120_000);
  await waitForReadiness(primaryBaseURL, 90_000);
  await verifyBaseline(baseline, "after nightly schema drift recovery");
  recordDeepEqual(
    "nightly schema drift recovery restored the original ledger",
    initialLedger,
    await readMigrationLedger("nightly-drift-recovery")
  );
}

async function expectAPIExit(label, expectedLogText) {
  const containerID = await apiContainerID();
  const deadline = Date.now() + 60_000;
  let state;
  while (Date.now() < deadline) {
    scenarioAbort.signal.throwIfAborted();
    const result = await captureAllowFailure(
      "docker",
      ["inspect", "--format", "{{.State.Status}}|{{.State.ExitCode}}", containerID],
      { cwd: repositoryRoot, timeoutMs: 30_000, signal: scenarioAbort.signal }
    );
    state = result.stdout.trim();
    if (result.code === 0 && state.startsWith("exited|")) break;
    await delay(250, scenarioAbort.signal);
  }
  const logs = await composeCapture(["logs", "--no-color", "api"], 30_000);
  writeFileSync(join(artifacts, `${label}-api.log`), logs);
  const [, exitCodeText] = (state ?? "|").split("|");
  const exitCode = Number(exitCodeText);
  record({
    check: `${label} prevents Core from serving with documented diagnostics`,
    expected: { container_state: "exited", exit_code_nonzero: true, log_contains: expectedLogText },
    actual: {
      container_state: state,
      log_contains: logs.includes(expectedLogText),
      log_artifact: join(artifacts, `${label}-api.log`)
    },
    passed: state?.startsWith("exited|") === true && exitCode > 0 && logs.includes(expectedLogText)
  });
}

function startObserver() {
  const logPath = join(artifacts, "observer-process.log");
  mkdirSync(controlDirectory, { recursive: true });
  appendFileSync(commandLog, `$ node ${observerScript}\n`);
  const child = spawn(process.execPath, [observerScript], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      ATLAS_MIGRATION_OBSERVER_CONTROL: controlDirectory,
      ATLAS_ACCEPTANCE_ARTIFACTS: join(artifacts, "observer-artifacts"),
      ATLAS_ACCEPTANCE_RUN_LABEL: `observer-${runUUID.slice(0, 8)}`
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  activeChildren.add(child);
  child.stdout.on("data", (chunk) => {
    appendFileSync(logPath, chunk);
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    appendFileSync(logPath, chunk);
    process.stderr.write(chunk);
  });
  const exit = new Promise((resolvePromise, rejectPromise) => {
    child.on("error", (error) => {
      activeChildren.delete(child);
      rejectPromise(new Error(`failed to start independent acceptance observer: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      activeChildren.delete(child);
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`independent acceptance observer exited ${code ?? signal ?? "without a status"}`));
    });
  });
  void exit.catch(() => {});
  return { child, exit };
}

function assertObserverOverlap(activity, restoreStartedAt, restoreCompletedAt) {
  const operationTimes = Array.isArray(activity.operation_times) ? activity.operation_times : [];
  const restoreStart = restoreStartedAt.getTime();
  const restoreEnd = restoreCompletedAt.getTime();
  const overlapping = operationTimes.filter(({ started_at: startedAt, completed_at: completedAt }) => {
    const operationStart = Date.parse(startedAt);
    const operationEnd = Date.parse(completedAt);
    return operationStart <= restoreEnd && restoreStart <= operationEnd;
  });
  record({
    check: "independent acceptance public operations overlapped the real paired restore interval",
    expected: { overlapping_operations: ">=1", observer_failures: 0 },
    actual: {
      restore_started_at: restoreStartedAt.toISOString(),
      restore_completed_at: restoreCompletedAt.toISOString(),
      operation_count: operationTimes.length,
      overlapping_operations: overlapping.length,
      first_operation: operationTimes[0],
      last_operation: operationTimes.at(-1)
    },
    passed: operationTimes.length > 0 && overlapping.length > 0
  });
}

async function waitForReadiness(baseURL, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastObservation = { status: "not attempted" };
  while (Date.now() < deadline) {
    scenarioAbort.signal.throwIfAborted();
    try {
      const response = await fetch(`${baseURL}/readiness`, {
        signal: AbortSignal.any([scenarioAbort.signal, AbortSignal.timeout(2_000)])
      });
      const body = await response.text();
      lastObservation = { status: response.status, body };
      appendJSONLine(join(artifacts, "readiness.jsonl"), {
        timestamp: new Date().toISOString(),
        ...lastObservation
      });
      if (response.status === 200) return;
    } catch (error) {
      lastObservation = { error: error instanceof Error ? error.message : String(error) };
    }
    await delay(250, scenarioAbort.signal);
  }
  throw new Error(`Core readiness did not return HTTP 200 within ${timeoutMs} ms: ${inspect(lastObservation)}`);
}

async function apiContainerID() {
  return (await composeCapture(["ps", "--quiet", "api"], 30_000)).trim();
}

async function composeExecute(args, timeoutMs, options = {}) {
  return execute("docker", [...compose, ...args], {
    cwd: repositoryRoot,
    env: environment,
    logPath: commandLog,
    timeoutMs,
    signal: scenarioAbort.signal,
    ...options
  });
}

async function composeCapture(args, timeoutMs) {
  return capture("docker", [...compose, ...args], {
    cwd: repositoryRoot,
    env: environment,
    logPath: commandLog,
    timeoutMs,
    signal: scenarioAbort.signal
  });
}

async function postgresExecute(args, timeoutMs, input) {
  return execute(
    "docker",
    [
      ...compose,
      "exec",
      "-T",
      "postgres",
      "/bin/sh",
      "-c",
      'PGPASSWORD="$POSTGRES_PASSWORD" exec "$@"',
      "postgres-command",
      ...args
    ],
    {
      cwd: repositoryRoot,
      env: environment,
      logPath: commandLog,
      timeoutMs,
      signal: scenarioAbort.signal,
      input
    }
  );
}

async function postgresCapture(args, timeoutMs, input) {
  const result = await postgresCaptureBuffer(args, timeoutMs, input);
  return result.toString("utf8");
}

async function postgresCaptureBuffer(args, timeoutMs, input) {
  const commandArgs = [
    ...compose,
    "exec",
    "-T",
    "postgres",
    "/bin/sh",
    "-c",
    'PGPASSWORD="$POSTGRES_PASSWORD" exec "$@"',
    "postgres-command",
    ...args
  ];
  appendFileSync(commandLog, `$ ${renderCommand("docker", commandArgs)}\n`);
  const result = await runProcess(
    "docker",
    commandArgs,
    {
      cwd: repositoryRoot,
      env: environment,
      timeoutMs,
      signal: scenarioAbort.signal,
      input,
      capture: true,
      echo: false
    }
  );
  return result.stdout;
}

async function runMinio(script, artifactName, captureOutput = false) {
  const result = await runProcess(
    "docker",
    [...compose, "run", "--rm", "--no-deps", "--entrypoint", "/bin/sh", "minio-client", "-c", script],
    {
      cwd: repositoryRoot,
      env: environment,
      logPath: join(artifacts, artifactName),
      timeoutMs: 180_000,
      signal: scenarioAbort.signal,
      capture: true,
      echo: !captureOutput
    }
  );
  appendFileSync(commandLog, `$ docker ${compose.join(" ")} run --rm --no-deps minio-client [${artifactName}]\n`);
  return { stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8") };
}

async function collectDiagnostics() {
  const diagnostics = [
    ["ps", ["docker", [...compose, "ps", "--all"]]],
    ["containers", ["docker", ["ps", "--all", "--filter", `label=io.atlas.migration-restore.run=${runID}`]]],
    ["volumes", ["docker", ["volume", "ls", "--filter", `label=io.atlas.migration-restore.run=${runID}`]]],
    ["networks", ["docker", ["network", "ls", "--filter", `label=io.atlas.migration-restore.run=${runID}`]]]
  ];
  const failures = [];
  for (const [label, [command, args]] of diagnostics) {
    const result = await captureAllowFailure(command, args, {
      cwd: repositoryRoot,
      env: environment,
      timeoutMs: 30_000
    });
    writeFileSync(
      join(artifacts, `docker-${label}.log`),
      Buffer.concat([result.stdout, result.stderr])
    );
    if (result.code !== 0) failures.push(`${label}: exit ${result.code}`);
  }
  const logs = await captureAllowFailure("docker", [...compose, "logs", "--no-color"], {
    cwd: repositoryRoot,
    env: environment,
    timeoutMs: 60_000
  });
  writeFileSync(join(artifacts, "compose.log"), Buffer.concat([logs.stdout, logs.stderr]));
  if (logs.code !== 0) failures.push(`logs: exit ${logs.code}`);
  if (failures.length > 0) throw new Error(`pre-teardown diagnostics failed: ${failures.join(", ")}`);
}

async function cleanupOwnedResources() {
  const cleanupProblems = [];
  const down = await captureAllowFailure(
    "docker",
    [...compose, "down", "--volumes", "--remove-orphans"],
    { cwd: repositoryRoot, env: environment, timeoutMs: 120_000 }
  );
  writeFileSync(join(artifacts, "cleanup-down.log"), Buffer.concat([down.stdout, down.stderr]));
  if (down.code !== 0) cleanupProblems.push(`Compose down exited ${down.code}`);

  const imageBefore = await captureAllowFailure("docker", ["image", "inspect", image], {
    cwd: repositoryRoot,
    timeoutMs: 30_000
  });
  writeFileSync(
    join(artifacts, "cleanup-image-inspect-before.log"),
    Buffer.concat([imageBefore.stdout, imageBefore.stderr])
  );
  let imageRemoval;
  if (imageBefore.code === 0 || !isMissingDockerImage(imageBefore)) {
    if (imageBefore.code !== 0) cleanupProblems.push(`owned image inspection exited ${imageBefore.code}`);
    imageRemoval = await captureAllowFailure("docker", ["image", "rm", image], {
      cwd: repositoryRoot,
      timeoutMs: 120_000
    });
  } else {
    imageRemoval = { code: 0, stdout: Buffer.from("owned image was not created\n"), stderr: Buffer.alloc(0) };
  }
  writeFileSync(
    join(artifacts, "cleanup-image.log"),
    Buffer.concat([imageRemoval.stdout, imageRemoval.stderr])
  );
  if (imageRemoval.code !== 0) cleanupProblems.push(`owned image removal exited ${imageRemoval.code}`);

  const ownershipChecks = [
    ["containers", ["ps", "--all", "--quiet", "--filter", `label=io.atlas.migration-restore.run=${runID}`]],
    ["volumes", ["volume", "ls", "--quiet", "--filter", `label=io.atlas.migration-restore.run=${runID}`]],
    ["networks", ["network", "ls", "--quiet", "--filter", `label=io.atlas.migration-restore.run=${runID}`]]
  ];
  const cleanupVerification = {};
  for (const [kind, args] of ownershipChecks) {
    const result = await captureAllowFailure("docker", args, { cwd: repositoryRoot, timeoutMs: 30_000 });
    cleanupVerification[kind] = { exit_code: result.code, remaining: result.stdout.toString("utf8").trim() };
    if (result.code !== 0 || result.stdout.toString("utf8").trim() !== "") {
      cleanupProblems.push(`${kind} cleanup verification failed`);
    }
  }
  const imageCheck = await captureAllowFailure("docker", ["image", "inspect", image], {
    cwd: repositoryRoot,
    timeoutMs: 30_000
  });
  const imageRemoved = imageCheck.code !== 0 && isMissingDockerImage(imageCheck);
  cleanupVerification.image = { inspect_exit_code: imageCheck.code, removed: imageRemoved };
  if (!imageRemoved) cleanupProblems.push("owned Core image cleanup verification failed");
  writeJSON(join(artifacts, "cleanup-verification.json"), cleanupVerification);
  if (cleanupProblems.length > 0) throw new Error(cleanupProblems.join("; "));
}

function execute(command, args, options = {}) {
  return runProcess(command, args, { ...options, capture: false });
}

async function capture(command, args, options = {}) {
  const result = await runProcess(command, args, { ...options, capture: true, echo: false });
  return result.stdout.toString("utf8");
}

async function captureAllowFailure(command, args, options = {}) {
  return runProcess(command, args, { ...options, capture: true, echo: false, allowFailure: true });
}

function runProcess(command, args, options = {}) {
  const {
    cwd,
    env,
    input,
    logPath,
    timeoutMs = 30_000,
    signal,
    capture: shouldCapture = false,
    echo = true,
    allowFailure = false
  } = options;
  if (logPath) {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `$ ${renderCommand(command, args)}\n`);
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    activeChildren.add(child);
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const append = (target, stream, chunk) => {
      target.push(Buffer.from(chunk));
      if (logPath) appendFileSync(logPath, chunk);
      if (echo) stream.write(chunk);
    };
    child.stdout.on("data", (chunk) => append(stdout, process.stdout, chunk));
    child.stderr.on("data", (chunk) => append(stderr, process.stderr, chunk));
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input);

    const terminate = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      activeChildren.delete(child);
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    child.on("error", (error) => finish(new Error(`failed to run ${renderCommand(command, args)}: ${error.message}`)));
    child.on("close", (code, closeSignal) => {
      const result = {
        code: code ?? (closeSignal ? 128 : 1),
        signal: closeSignal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr)
      };
      if (timedOut) {
        finish(new Error(`${renderCommand(command, args)} exceeded ${timeoutMs} ms`));
        return;
      }
      if (aborted) {
        finish(signal?.reason instanceof Error ? signal.reason : new Error(`${renderCommand(command, args)} aborted`));
        return;
      }
      if (result.code !== 0 && !allowFailure) {
        const output = [
          result.stdout.length > 0 ? `stdout:\n${result.stdout.toString("utf8").trim()}` : "",
          result.stderr.length > 0 ? `stderr:\n${result.stderr.toString("utf8").trim()}` : ""
        ]
          .filter(Boolean)
          .join("\n");
        finish(
          new Error(
            `${renderCommand(command, args)} exited ${result.code}${output.length > 0 ? `:\n${output}` : ""}`
          )
        );
        return;
      }
      finish(undefined, shouldCapture || allowFailure ? result : undefined);
    });
  });
}

function renderCommand(command, args) {
  return [command, ...args].map((value) => (/^[a-zA-Z0-9_./:@=-]+$/u.test(value) ? value : JSON.stringify(value))).join(" ");
}

function record(entry) {
  const value = { timestamp: new Date().toISOString(), ...entry };
  appendJSONLine(evidenceLog, value);
  if (value.passed === false) {
    const error = new Error(
      `${value.check}: expected ${inspect(value.expected, { depth: 8 })}, observed ${inspect(value.actual, { depth: 8 })}`
    );
    error.acceptanceEvidence = value;
    throw error;
  }
  return value;
}

function recordDeepEqual(check, expected, actual) {
  record({ check, expected, actual, passed: isDeepStrictEqual(actual, expected) });
}

async function waitForJSON(path, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    signal.throwIfAborted();
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await delay(100, signal);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function delay(milliseconds, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(finish, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      rejectPromise(signal.reason);
    };
    function finish() {
      signal.removeEventListener("abort", onAbort);
      resolvePromise();
    }
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function assertResourceID(id) {
  if (id.length > 50 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(id)) {
    throw new Error(`generated resource ID violates the published 50-character contract: ${id}`);
  }
}

function summarizeEntity(entity) {
  return {
    entity_id: entity.entity_id,
    alias: entity.alias,
    version: entity.metadata?.version,
    created_at: entity.metadata?.created_at,
    updated_at: entity.metadata?.updated_at
  };
}

function summarizeObject(object) {
  return {
    object_id: object.object_id,
    type: object.type,
    content_type: object.content_type,
    size_bytes: object.size_bytes,
    bucket: object.bucket,
    path: object.path,
    version: object.metadata?.version
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function filesUnder(path) {
  if (!existsSync(path)) return [];
  const files = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

function isMissingDockerImage(result) {
  return result.stderr.toString("utf8").toLowerCase().includes("no such image");
}

function slug(value) {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
}

function artifactDirectory(uuid) {
  const configuredRoot = process.env.ATLAS_ACCEPTANCE_ARTIFACTS;
  const root = configuredRoot
    ? resolve(repositoryRoot, configuredRoot)
    : join(repositoryRoot, ".atlas", "acceptance");
  const timestamp = new Date().toISOString().replaceAll(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  const path = join(root, "migration-restore", `${timestamp}-${uuid}`);
  mkdirSync(path, { recursive: true });
  return path;
}

function createCredentials() {
  const apiKeyHex = randomBytes(32).toString("hex");
  const apiKeyGroups = [];
  for (let index = 0; index < apiKeyHex.length; index += 2) apiKeyGroups.push(apiKeyHex.slice(index, index + 2));
  return {
    apiKey: `atlas_ak_${apiKeyGroups.join("-")}`,
    postgresPassword: randomBytes(24).toString("base64url"),
    minioPassword: randomBytes(24).toString("hex"),
    adminPassword: randomBytes(32).toString("base64url")
  };
}

function parseMode(argumentsList) {
  if (argumentsList.length === 0) return "required";
  if (argumentsList.length === 1 && argumentsList[0] === "--nightly") return "nightly";
  throw new Error("usage: node tests/acceptance/migration-restore/run.mjs [--nightly]");
}

function appendJSONLine(path, value) {
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}

function writeJSON(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function serializeError(error) {
  if (!(error instanceof Error)) return { message: String(error) };
  return {
    name: error.name,
    message: error.message,
    ...(error.acceptanceEvidence ? { evidence: error.acceptanceEvidence } : {}),
    ...(error.httpExchange ? { http_exchange: error.httpExchange } : {})
  };
}
