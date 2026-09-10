export type ImageReceipt = {
  image_index: string;
  platform_manifest_sha256: string;
  local_image_id: string;
};

export type DockerImageCommand = (args: string[]) => Promise<{ status: number; stdout: string; stderr: string }>;

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const repositoryPattern = /^[a-z0-9][a-z0-9./:_-]*$/u;
const tagPattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u;

export function parseImageReceipt(value: unknown): ImageReceipt {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "image_index,local_image_id,platform_manifest_sha256" ||
    typeof value.image_index !== "string" ||
    !isImageReference(value.image_index) ||
    typeof value.platform_manifest_sha256 !== "string" ||
    !digestPattern.test(value.platform_manifest_sha256) ||
    typeof value.local_image_id !== "string" ||
    !digestPattern.test(value.local_image_id)
  ) {
    throw new Error("Invalid retained Docker image receipt.");
  }
  return {
    image_index: value.image_index,
    platform_manifest_sha256: value.platform_manifest_sha256,
    local_image_id: value.local_image_id
  };
}

/** Docker verifies the requested digest on pull; retain the resolved platform and local identities. */
export async function pullImageReceipt(
  run: DockerImageCommand,
  image: string,
  architecture: "arm64" | "amd64"
): Promise<ImageReceipt> {
  if (!isImageReference(image)) throw new Error("Only immutable image digests can be selected.");
  await checked(run, ["pull", "--platform", `linux/${architecture}`, image]);
  const manifest = parseObject(await checked(run, ["manifest", "inspect", image]));
  let platformDigest = imageDigest(image);
  if (Array.isArray(manifest.manifests)) {
    const platforms = manifest.manifests.filter(
      (entry): entry is Record<string, unknown> =>
        isRecord(entry) &&
        isRecord(entry.platform) &&
        entry.platform.os === "linux" &&
        entry.platform.architecture === architecture &&
        (architecture !== "arm64" || entry.platform.variant === undefined || entry.platform.variant === "v8")
    );
    const match = platforms[0];
    if (platforms.length !== 1 || typeof match?.digest !== "string" || !digestPattern.test(match.digest)) {
      throw new Error(`Image ${image} has no unambiguous linux/${architecture} manifest.`);
    }
    platformDigest = match.digest;
  } else if (manifest.schemaVersion !== 2 || !isRecord(manifest.config)) {
    throw new Error(`Image ${image} has an invalid distribution manifest.`);
  }
  const inspected = parseObject(await checked(run, ["image", "inspect", "--format", "{{json .}}", image]));
  if (
    typeof inspected.Id !== "string" ||
    !digestPattern.test(inspected.Id) ||
    inspected.Os !== "linux" ||
    inspected.Architecture !== architecture ||
    !Array.isArray(inspected.RepoDigests) ||
    !hasMatchingRepoDigest(inspected.RepoDigests, image)
  ) {
    throw new Error(`Docker did not resolve the selected ${image} to the expected platform and digest.`);
  }
  // The selected platform manifest must refer to the local configuration Docker actually unpacked.
  const platform = parseObject(
    await checked(run, ["manifest", "inspect", `${imageRepository(image)}@${platformDigest}`])
  );
  if (!isRecord(platform.config) || platform.config.digest !== inspected.Id) {
    throw new Error(`Image ${image} local configuration does not match its selected platform manifest.`);
  }
  return { image_index: image, platform_manifest_sha256: platformDigest, local_image_id: inspected.Id };
}

export async function verifyLocalImage(run: DockerImageCommand, receipt: ImageReceipt): Promise<void> {
  const inspected = parseObject(
    await checked(run, ["image", "inspect", "--format", "{{json .}}", receipt.image_index])
  );
  if (
    inspected.Id !== receipt.local_image_id ||
    !Array.isArray(inspected.RepoDigests) ||
    !hasMatchingRepoDigest(inspected.RepoDigests, receipt.image_index)
  ) {
    throw new Error(
      `Retained image ${receipt.image_index} is missing or changed. Run atlas-core start --repair-images.`
    );
  }
}

export async function verifyContainerImage(
  run: DockerImageCommand,
  container: string,
  receipt: ImageReceipt
): Promise<void> {
  const inspected = parseObject(await checked(run, ["container", "inspect", "--format", "{{json .}}", container]));
  if (
    !isRecord(inspected.Config) ||
    inspected.Config.Image !== receipt.image_index ||
    inspected.Image !== receipt.local_image_id
  ) {
    throw new Error(`Container ${container} does not use its retained image identity.`);
  }
}

async function checked(run: DockerImageCommand, args: string[]): Promise<string> {
  const result = await run(args);
  if (result.status !== 0) throw new Error(`Docker ${args[0]} failed: ${result.stderr.trim() || "no diagnostic"}`);
  return result.stdout;
}

function parseObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error("Docker returned an invalid image record.");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasMatchingRepoDigest(repoDigests: unknown[], image: string): boolean {
  const expectedDigest = imageDigest(image);
  const expectedRepositories = repositoryAliases(imageRepository(image));
  return repoDigests.some(
    (candidate) =>
      typeof candidate === "string" &&
      isImageReference(candidate) &&
      imageDigest(candidate) === expectedDigest &&
      expectedRepositories.has(imageRepository(candidate))
  );
}

function imageDigest(image: string): string {
  return image.slice(image.lastIndexOf("@") + 1);
}

function isImageReference(image: string): boolean {
  const at = image.lastIndexOf("@");
  if (at <= 0 || image.indexOf("@") !== at) return false;
  const reference = image.slice(0, at);
  const lastSlash = reference.lastIndexOf("/");
  const lastColon = reference.lastIndexOf(":");
  const repository = lastColon > lastSlash ? reference.slice(0, lastColon) : reference;
  const tag = lastColon > lastSlash ? reference.slice(lastColon + 1) : undefined;
  return (
    repositoryPattern.test(repository) &&
    (tag === undefined || tagPattern.test(tag)) &&
    digestPattern.test(image.slice(at + 1))
  );
}

/** Return the repository without a tag, preserving a registry port. */
function imageRepository(image: string): string {
  const reference = image.slice(0, image.lastIndexOf("@"));
  const lastSlash = reference.lastIndexOf("/");
  const lastColon = reference.lastIndexOf(":");
  return lastColon > lastSlash ? reference.slice(0, lastColon) : reference;
}

/** Docker Hub has several equivalent spellings in RepoDigests output. */
function repositoryAliases(repository: string): Set<string> {
  const aliases = new Set([repository]);
  const hubPrefix = repository.startsWith("docker.io/")
    ? "docker.io/"
    : repository.startsWith("index.docker.io/")
      ? "index.docker.io/"
      : undefined;
  const hubRepository = hubPrefix ? repository.slice(hubPrefix.length) : repository;
  const firstComponent = hubRepository.split("/", 1)[0] ?? "";
  const explicitRegistry =
    firstComponent.includes(".") || firstComponent.includes(":") || firstComponent === "localhost";
  if (!hubPrefix && explicitRegistry) return aliases;

  aliases.add(`docker.io/${hubRepository}`);
  aliases.add(`index.docker.io/${hubRepository}`);
  if (hubRepository.startsWith("library/")) {
    aliases.add(hubRepository.slice("library/".length));
  } else if (!hubRepository.includes("/")) {
    aliases.add(`library/${hubRepository}`);
    aliases.add(`docker.io/library/${hubRepository}`);
    aliases.add(`index.docker.io/library/${hubRepository}`);
  }
  return aliases;
}
