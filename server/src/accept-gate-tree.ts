import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

async function walkTree(path: string, hash: ReturnType<typeof createHash>, ancestors: Set<string>, destination?: string,
  filter?: (path: string) => boolean): Promise<boolean> {
  if (filter && !filter(path)) return false;
  let canonical: string;
  try { canonical = await realpath(path); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if ((code === "ENOENT" || code === "ELOOP") && (await lstat(path)).isSymbolicLink()) return false;
    throw error;
  }
  if (ancestors.has(canonical)) return false;
  const info = await stat(path);
  if (info.isFile()) {
    hash.update(`file:${info.mode & 0o111}:`);
    if (destination) {
      await copyFile(path, destination);
      await chmod(destination, info.mode);
    }
    for await (const chunk of createReadStream(destination ?? path)) hash.update(chunk);
  } else if (info.isDirectory()) {
    if (destination) await mkdir(destination, { recursive: true });
    hash.update("directory:");
    const next = new Set(ancestors).add(canonical);
    for (const name of (await readdir(path)).sort()) {
      const childHash = createHash("sha256");
      if (await walkTree(join(path, name), childHash, next, destination ? join(destination, name) : undefined, filter)) {
        hash.update(JSON.stringify(name)).update(childHash.digest());
      }
    }
  } else throw new Error(`测试输入不是普通文件或目录：${path}`);
  hash.update("\0");
  return true;
}

export async function gateTreeDigest(path: string, destination?: string, filter?: (path: string) => boolean): Promise<string | null> {
  const hash = createHash("sha256");
  return await walkTree(path, hash, new Set(), destination, filter) ? hash.digest("hex") : null;
}
