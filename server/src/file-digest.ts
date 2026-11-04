import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";

// 一个文件**内容**的指纹。写入端在工具写完的那一刻记下它（executors/tool-writes.ts），读取端拿
// 磁盘上现在这份重算一遍去比（task-artifact-direct.ts）：两边一样，就是「现在这份正是它亲手写下的
// 那一版」——不靠时间、不靠目录远近。
//
// 两边必须是同一个算法，所以收在一处。超过上限的不算：写文件工具写出来的产物是网页、SVG 这种
// 小文件，大到几十兆的是命令渲染出来的，本来就不走这条路。

const MAX_DIGEST_BYTES = 32 * 1024 * 1024;

const digestOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** 同步版：执行器解析流时用（当场冻住，不让后来的改动混进来）。读不了、不是文件、太大都是 null。 */
export function fileDigestSync(path: string): string | null {
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > MAX_DIGEST_BYTES) return null;
    return digestOf(readFileSync(path));
  } catch {
    return null;
  }
}

export async function fileDigest(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_DIGEST_BYTES) return null;
    return digestOf(await readFile(path));
  } catch {
    return null;
  }
}
