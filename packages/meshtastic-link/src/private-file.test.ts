import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readPrivateFile } from "./private-file.js";

describe("private credential files", () => {
  it("accepts only private regular files owned by the service user", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-link-private-file-"));
    const credential = join(directory, "join.key");
    await writeFile(credential, Buffer.alloc(32, 7), { mode: 0o600 });
    await expect(readPrivateFile(credential, "join key")).resolves.toEqual(Buffer.alloc(32, 7));

    await chmod(credential, 0o640);
    await expect(readPrivateFile(credential, "join key")).rejects.toThrow("group or other permissions");

    await chmod(credential, 0o600);
    const link = join(directory, "join-link.key");
    await symlink(credential, link);
    await expect(readPrivateFile(link, "join key")).rejects.toThrow("symbolic link");
    await expect(readPrivateFile(directory, "join key")).rejects.toThrow("regular file");
  });
});
