import { describe, expect, it } from "vitest";
import {
  type DockerImageCommand,
  pullImageReceipt,
  verifyContainerImage,
  verifyLocalImage
} from "../src/image-receipts.js";

const image = "ghcr.io/the-drunken-coder/atlas-reference@sha256:" + "a".repeat(64);
const taggedDockerHubImage = "postgres:15@sha256:" + "a".repeat(64);
const bundledMinioImage =
  "minio/minio:RELEASE.2024-01-31T20-20-33Z@sha256:4092433a77e510826874b36f369696df43407a763d7f901a61d74e83e6fd95bc";
const platformDigest = "sha256:" + "b".repeat(64);
const localImageID = "sha256:" + "c".repeat(64);

describe("Docker image receipts", () => {
  it("records the selected platform manifest and local image identity", async () => {
    const platformReference = `${image.slice(0, image.lastIndexOf("@"))}@${platformDigest}`;
    const docker = fakeDocker({
      [`manifest\u0000inspect\u0000${image}`]: JSON.stringify({
        manifests: [
          { digest: platformDigest, platform: { os: "linux", architecture: "arm64", variant: "v8" } },
          { digest: "sha256:" + "d".repeat(64), platform: { os: "linux", architecture: "amd64" } }
        ]
      }),
      [`image\u0000inspect\u0000--format\u0000{{json .}}\u0000${image}`]: JSON.stringify({
        Id: localImageID,
        Os: "linux",
        Architecture: "arm64",
        RepoDigests: [image]
      }),
      [`manifest\u0000inspect\u0000${platformReference}`]: JSON.stringify({
        schemaVersion: 2,
        config: { digest: localImageID }
      })
    });

    await expect(pullImageReceipt(docker.run, image, "arm64")).resolves.toEqual({
      image_index: image,
      platform_manifest_sha256: platformDigest,
      local_image_id: localImageID
    });
    expect(docker.calls).toEqual([
      ["pull", "--platform", "linux/arm64", image],
      ["manifest", "inspect", image],
      ["image", "inspect", "--format", "{{json .}}", image],
      ["manifest", "inspect", platformReference]
    ]);
  });

  it("rejects an index with no unambiguous manifest for the selected architecture", async () => {
    const docker = fakeDocker({
      [`manifest\u0000inspect\u0000${image}`]: JSON.stringify({
        manifests: [{ digest: platformDigest, platform: { os: "linux", architecture: "amd64" } }]
      })
    });

    await expect(pullImageReceipt(docker.run, image, "arm64")).rejects.toThrow(/no unambiguous linux\/arm64 manifest/);
    expect(docker.calls).toEqual([
      ["pull", "--platform", "linux/arm64", image],
      ["manifest", "inspect", image]
    ]);
  });

  it("accepts Docker's tag-free canonical Docker Hub RepoDigest for a tagged image", async () => {
    const platformReference = `postgres@${platformDigest}`;
    const docker = fakeDocker({
      [`manifest\u0000inspect\u0000${taggedDockerHubImage}`]: JSON.stringify({
        manifests: [{ digest: platformDigest, platform: { os: "linux", architecture: "amd64" } }]
      }),
      [`image\u0000inspect\u0000--format\u0000{{json .}}\u0000${taggedDockerHubImage}`]: JSON.stringify({
        Id: localImageID,
        Os: "linux",
        Architecture: "amd64",
        RepoDigests: [
          `docker.io/library/postgres@${taggedDockerHubImage.slice(taggedDockerHubImage.lastIndexOf("@") + 1)}`
        ]
      }),
      [`manifest\u0000inspect\u0000${platformReference}`]: JSON.stringify({
        schemaVersion: 2,
        config: { digest: localImageID }
      })
    });

    await expect(pullImageReceipt(docker.run, taggedDockerHubImage, "amd64")).resolves.toEqual({
      image_index: taggedDockerHubImage,
      platform_manifest_sha256: platformDigest,
      local_image_id: localImageID
    });
    expect(docker.calls.at(-1)).toEqual(["manifest", "inspect", platformReference]);
  });

  it("strips a tag without stripping a registry host port", async () => {
    const taggedImage = "registry.example:5000/team/postgres:15@sha256:" + "a".repeat(64);
    const platformReference = "registry.example:5000/team/postgres@" + platformDigest;
    const docker = fakeDocker({
      [`manifest\u0000inspect\u0000${taggedImage}`]: JSON.stringify({
        manifests: [{ digest: platformDigest, platform: { os: "linux", architecture: "amd64" } }]
      }),
      [`image\u0000inspect\u0000--format\u0000{{json .}}\u0000${taggedImage}`]: JSON.stringify({
        Id: localImageID,
        Os: "linux",
        Architecture: "amd64",
        RepoDigests: ["registry.example:5000/team/postgres@sha256:" + "a".repeat(64)]
      }),
      [`manifest\u0000inspect\u0000${platformReference}`]: JSON.stringify({
        schemaVersion: 2,
        config: { digest: localImageID }
      })
    });

    await expect(pullImageReceipt(docker.run, taggedImage, "amd64")).resolves.toMatchObject({
      image_index: taggedImage,
      platform_manifest_sha256: platformDigest,
      local_image_id: localImageID
    });
    expect(docker.calls.at(-1)).toEqual(["manifest", "inspect", platformReference]);
  });

  it("accepts the bundled MinIO image with its uppercase release tag", async () => {
    const platformReference = "minio/minio@" + bundledMinioImage.slice(bundledMinioImage.lastIndexOf("@") + 1);
    const docker = fakeDocker({
      [`manifest\u0000inspect\u0000${bundledMinioImage}`]: JSON.stringify({
        schemaVersion: 2,
        config: { digest: localImageID }
      }),
      [`image\u0000inspect\u0000--format\u0000{{json .}}\u0000${bundledMinioImage}`]: JSON.stringify({
        Id: localImageID,
        Os: "linux",
        Architecture: "amd64",
        RepoDigests: ["docker.io/minio/minio@" + bundledMinioImage.slice(bundledMinioImage.lastIndexOf("@") + 1)]
      }),
      [`manifest\u0000inspect\u0000${platformReference}`]: JSON.stringify({
        schemaVersion: 2,
        config: { digest: localImageID }
      })
    });

    await expect(pullImageReceipt(docker.run, bundledMinioImage, "amd64")).resolves.toEqual({
      image_index: bundledMinioImage,
      platform_manifest_sha256: bundledMinioImage.slice(bundledMinioImage.lastIndexOf("@") + 1),
      local_image_id: localImageID
    });
  });

  it("rejects when the selected platform manifest does not match the unpacked local image", async () => {
    const platformReference = `${image.slice(0, image.lastIndexOf("@"))}@${platformDigest}`;
    const docker = fakeDocker({
      [`manifest\u0000inspect\u0000${image}`]: JSON.stringify({
        manifests: [{ digest: platformDigest, platform: { os: "linux", architecture: "arm64", variant: "v8" } }]
      }),
      [`image\u0000inspect\u0000--format\u0000{{json .}}\u0000${image}`]: JSON.stringify({
        Id: localImageID,
        Os: "linux",
        Architecture: "arm64",
        RepoDigests: [image]
      }),
      [`manifest\u0000inspect\u0000${platformReference}`]: JSON.stringify({
        schemaVersion: 2,
        config: { digest: "sha256:" + "e".repeat(64) }
      })
    });

    await expect(pullImageReceipt(docker.run, image, "arm64")).rejects.toThrow(/configuration does not match/);
  });

  it("rejects when Docker unpacks a different local platform than requested", async () => {
    const docker = fakeDocker({
      [`manifest\u0000inspect\u0000${image}`]: JSON.stringify({
        manifests: [{ digest: platformDigest, platform: { os: "linux", architecture: "arm64", variant: "v8" } }]
      }),
      [`image\u0000inspect\u0000--format\u0000{{json .}}\u0000${image}`]: JSON.stringify({
        Id: localImageID,
        Os: "linux",
        Architecture: "amd64",
        RepoDigests: [image]
      })
    });

    await expect(pullImageReceipt(docker.run, image, "arm64")).rejects.toThrow(/expected platform and digest/);
  });

  it("rejects a retained image after local Docker replacement", async () => {
    const replacementID = "sha256:" + "f".repeat(64);
    const docker = fakeDocker({
      [`image\u0000inspect\u0000--format\u0000{{json .}}\u0000${image}`]: JSON.stringify({
        Id: replacementID,
        RepoDigests: [image]
      })
    });

    await expect(
      verifyLocalImage(docker.run, {
        image_index: image,
        platform_manifest_sha256: platformDigest,
        local_image_id: localImageID
      })
    ).rejects.toThrow(/missing or changed/);
  });

  it("still requires the retained digest when Docker reports a canonical alias", async () => {
    const docker = fakeDocker({
      [`image\u0000inspect\u0000--format\u0000{{json .}}\u0000${taggedDockerHubImage}`]: JSON.stringify({
        Id: localImageID,
        RepoDigests: ["docker.io/library/postgres@sha256:" + "d".repeat(64)]
      })
    });

    await expect(
      verifyLocalImage(docker.run, {
        image_index: taggedDockerHubImage,
        platform_manifest_sha256: platformDigest,
        local_image_id: localImageID
      })
    ).rejects.toThrow(/missing or changed/);
  });

  it("requires a container to use both the retained reference and local identity", async () => {
    const taggedImage = "postgres:15@sha256:" + "a".repeat(64);
    const docker = fakeDocker({
      [`container\u0000inspect\u0000--format\u0000{{json .}}\u0000atlas-reference`]: JSON.stringify({
        Config: { Image: taggedImage },
        Image: localImageID
      })
    });

    await expect(
      verifyContainerImage(docker.run, "atlas-reference", {
        image_index: taggedImage,
        platform_manifest_sha256: platformDigest,
        local_image_id: localImageID
      })
    ).resolves.toBeUndefined();
  });
});

function fakeDocker(responses: Record<string, string>): {
  run: DockerImageCommand;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args) => {
      calls.push(args);
      return { status: 0, stdout: responses[args.join("\u0000")] ?? "", stderr: "" };
    }
  };
}
