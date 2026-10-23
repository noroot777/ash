import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname } from "node:path";
import { safeRunDirectory } from "./review-evidence.js";

export async function regressionLogDigest(path: string): Promise<string | null> {
  try {
    if (!(await safeRunDirectory(dirname(path)))) return null;
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
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
