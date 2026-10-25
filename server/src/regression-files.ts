import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname } from "node:path";
import { safeRunDirectory } from "./review-evidence.js";

export async function regressionLogDigest(path: string): Promise<string | null> {
  try {
    if (!(await safeRunDirectory(dirname(path)))) return null;
    if (!(await lstat(path)).isFile()) return null;
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) return null;
      const digest = createHash("sha256");
      for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
      return digest.digest("hex");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
