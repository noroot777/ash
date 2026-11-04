import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

// 一份**内容**的指纹。写入端拿**这次操作自己写下的内容**算（executors/tool-writes.ts——工具入参里的
// 全文、回执里改之前的原文加上这次的替换），读取端拿磁盘上现在这份重算一遍去比
// （task-artifact-direct.ts）：两边一样，就是「现在这份正是它亲手写下的那一版」——不靠时间、
// 不靠目录远近。
//
// 写入端**绝不读磁盘**：收到「写成了」的消息时磁盘上那份可能已经被别人覆盖了，拿那时读到的内容
// 当指纹，就是把别人的版本记成自己写下的（审查 TgRjUOJWF1Ci 第 1 轮 #1）。
//
// 两边必须是同一个算法，所以收在一处。超过上限的不算：写文件工具写出来的产物是网页、SVG 这种
// 小文件，大到几十兆的是命令渲染出来的，本来就不走这条路。

const MAX_DIGEST_BYTES = 32 * 1024 * 1024;

const digestOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** 一段要写进文件的文本的指纹（按 UTF-8 落盘算）。太大就是 null。 */
export function contentDigest(text: string): string | null {
  const bytes = Buffer.from(text, "utf8");
  return bytes.length > MAX_DIGEST_BYTES ? null : digestOf(bytes);
}

/** 磁盘上一个文件现在的指纹。读不了、不是文件、太大都是 null。 */
export async function fileDigest(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_DIGEST_BYTES) return null;
    return digestOf(await readFile(path));
  } catch {
    return null;
  }
}
