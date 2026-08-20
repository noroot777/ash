// 任务接力——上传附件迁移。
//
// attachmentsPrompt 会把上传文件(data/uploads)的**绝对路径**写进任务正文和回复
// 回合的消息,这些路径随后进入 CLI 会话 JSONL 和 run 产物。接力后那是**源机**的
// 路径,对端 agent 照着 Read 只会得到「文件不存在」。这里负责:
//   导出侧 collectUploads —— 从任务文本与文本载荷里扫出被引用的附件并打包;
//   导入侧 writeUploads + uploadRewritePairs/applyUploadRewrites —— 附件落到本机
//   uploads 目录,把所有文本(任务字段 + 文本类文件载荷)里的旧路径改写成新路径。
//
// 转义形态:路径出现在 JSON 文本(.jsonl)里时反斜杠是转义过的(D:\\a\\b),只扫/只改
// 原始形态会漏掉 Windows 源机的所有会话文件引用。所以原始、转义两种形态都扫,改写
// 对按「原始→原始、转义→转义」配对,JSON 文件改完仍是合法 JSON。
import { existsSync, mkdirSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { MAX_FILE_BYTES, MB } from "./handoff-types.js";
import type { HandoffUploadPayload } from "./handoff-types.js";
import { UPLOADS_DIR } from "./paths.js";

export const MAX_UPLOADS = 100;

/** 一段文本在 JSON 字符串里的形态(去掉包裹引号)。POSIX 路径没有需转义字符,原样返回。 */
export const jsonEscaped = (s: string): string => JSON.stringify(s).slice(1, -1);

// 上传文件名由 id()+sanitizeName 生成,字符集固定;路径末段凡是超出这个字符集的
// 都不是我们写的附件名,扫描就地截断。
const NAME_CHARS = /^[A-Za-z0-9._-]+/;
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/** 从一段文本里扫出被引用的上传文件名(只认 uploads 目录直下)。 */
export function scanUploadNames(text: string, uploadsDir: string = UPLOADS_DIR): Set<string> {
  const names = new Set<string>();
  // POSIX 下两种形态相同,Set 去重后只扫一遍。
  for (const prefix of new Set([uploadsDir + sep, jsonEscaped(uploadsDir + sep)])) {
    let idx = 0;
    while ((idx = text.indexOf(prefix, idx)) !== -1) {
      idx += prefix.length;
      const match = NAME_CHARS.exec(text.slice(idx, idx + 512));
      if (match) names.add(match[0]);
    }
  }
  return names;
}

/** 导出侧:收集被引用且本机真实存在的附件。dryRun(preflight)只盘点,不读内容。 */
export async function collectUploads(
  texts: string[],
  notes: string[],
  dryRun: boolean,
): Promise<HandoffUploadPayload[]> {
  const names = new Set<string>();
  for (const t of texts) for (const n of scanUploadNames(t)) names.add(n);
  const out: HandoffUploadPayload[] = [];
  for (const name of names) {
    if (out.length >= MAX_UPLOADS) {
      notes.push(`上传附件超过 ${MAX_UPLOADS} 个,余下的不迁移(对端按旧路径读不到)`);
      break;
    }
    const abs = join(UPLOADS_DIR, name);
    if (!existsSync(abs)) {
      notes.push(`上传附件 ${name} 在本机已不存在,跳过`);
      continue;
    }
    const size = statSync(abs).size;
    if (size > MAX_FILE_BYTES) {
      notes.push(`上传附件 ${name} ${Math.round(size / MB)}MB 超限,跳过`);
      continue;
    }
    out.push({ name, sourcePath: abs, dataBase64: dryRun ? "" : (await readFile(abs)).toString("base64") });
  }
  return out;
}

/** 导入侧:附件落到本机 uploads 目录,返回**真正写盘成功**的载荷——路径改写只认这批, 写失败的旧路径原样留着(好歹能看出引用的是什么)。 */
export async function writeUploads(
  uploads: HandoffUploadPayload[],
  notes: string[],
): Promise<HandoffUploadPayload[]> {
  const written: HandoffUploadPayload[] = [];
  for (const u of uploads) {
    // "." 与 ".." 也满足字符集正则,必须单独拒绝。
    if (!SAFE_NAME.test(u.name) || u.name === "." || u.name === "..") {
      notes.push(`上传附件名非法,跳过:${u.name}`);
      continue;
    }
    const data = Buffer.from(u.dataBase64, "base64");
    if (data.byteLength > MAX_FILE_BYTES) {
      notes.push(`上传附件 ${u.name} 解码后超限,跳过`);
      continue;
    }
    mkdirSync(UPLOADS_DIR, { recursive: true });
    await writeFile(join(UPLOADS_DIR, u.name), data);
    written.push(u);
  }
  return written;
}

/** 改写对:源机旧路径(原始/转义两种形态)→ 本机新路径。长的先换,防前缀互吞。 */
export function uploadRewritePairs(written: HandoffUploadPayload[]): { from: string; to: string }[] {
  const pairs: { from: string; to: string }[] = [];
  for (const u of written) {
    const to = join(UPLOADS_DIR, u.name);
    for (const [from, target] of [
      [u.sourcePath, to],
      [jsonEscaped(u.sourcePath), jsonEscaped(to)],
    ] as const) {
      if (from && from !== target) pairs.push({ from, to: target });
    }
  }
  return pairs.sort((a, b) => b.from.length - a.from.length);
}

export function applyUploadRewrites(text: string, pairs: { from: string; to: string }[]): string {
  let out = text;
  for (const p of pairs) out = out.replaceAll(p.from, p.to);
  return out;
}

// 只有文本类文件才做路径扫描/改写——二进制(截图等)碰一下就废。
const TEXT_EXT = new Set([".md", ".txt", ".json", ".jsonl", ".trace"]);

export function isTextRel(rel: string): boolean {
  const dot = rel.lastIndexOf(".");
  return dot !== -1 && TEXT_EXT.has(rel.slice(dot).toLowerCase());
}
