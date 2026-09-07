import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";

export async function readPrivateFile(path: string, label: string): Promise<Buffer> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`${label} is missing, unreadable, or a symbolic link at ${path}`, { cause: error });
  }
  try {
    const details = await handle.stat();
    const currentUser = process.getuid?.();
    if (!details.isFile()) throw new Error(`${label} must be a regular file at ${path}`);
    if (currentUser !== undefined && details.uid !== currentUser) {
      throw new Error(`${label} must be owned by the service user at ${path}`);
    }
    if ((details.mode & 0o077) !== 0) throw new Error(`${label} must not grant group or other permissions at ${path}`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
