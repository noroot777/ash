import { isAbsolute, resolve } from "node:path";
import type { AgentEvent } from "@ash/shared";
import { kindOf } from "../artifact-kind.js";
import { contentDigest } from "../file-digest.js";

// 工具调用「写到了哪里」——从执行器原生事件的**结构化参数**里取，不从展示用的 detail 里抠：
// detail 被截到 1500 字，claude 的 Write 连同整段文件内容一起序列化，截完就不是合法 JSON 了
// （实测一个任务 14 次 Write 里 13 条拆不开）。取出来的事实只走 `writes` 事件，去处见
// server/src/task-writes.ts。
//
// 只认**写文件、改文件的工具**和**命令的工作目录**两样。shell 命令写到哪儿从命令文本里分析
// 不可靠（重定向、脚本里的路径、`-o` 参数五花八门），不猜。
//
// **只认写成了的**：工具入参只证明「试图写」。一次报错的 Edit（目标不存在、旧串对不上）什么都
// 没改，却会被当成「这个任务在那儿写过东西」，把旁边别的任务的真产物判走。所以 claude 要等到
// 对应的 tool_result 没报错才放出来（`ClaudeWriteLedger`），codex 只认 `completed` 的改文件项。
//
// **内容指纹只从这次操作自己带的内容算**（`digests`，只给产物那几类文件）。这是生成物面板唯一不靠
// 推断的归属证据：磁盘上现在这份跟它亲手写下的一模一样，就是它的（task-artifact-direct.ts）。
// 所以指纹必须证明的是「这次操作写下了什么」，不是「收到消息时这条路径上有什么」——写完到这条
// 消息被解析之间隔着进程间管道和事件排队，别人完全可以在那中间把文件覆盖掉；当时去读磁盘，就会
// 把别人的版本记成自己亲手写下的（审查 TgRjUOJWF1Ci 第 1 轮 #1，同步读、提前读都补不上）。
// 能从操作本身推出写完后全文的才给指纹：
//   - claude Write：入参就是全文；
//   - claude Edit / MultiEdit：回执（`tool_use_result`）带着工具自己读到的改之前的原文，按这次的
//     替换推一遍；
//   - codex 新建文件（app-server 的 `add`）：`diff` 就是全文。
// 推不出来的（codex 改已有文件只给 diff、`codex exec` 什么内容都不给、NotebookEdit、回执缺字段）
// 只报路径，不给指纹——那就只是「写过」，升不成确定。推错了也只会对不上磁盘、落成候选。

/** claude 的写文件/改文件工具 → 目标路径所在的入参字段。 */
const CLAUDE_WRITE_TOOLS: Record<string, string> = {
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

// **相对路径在这里就按这一趟实际的工作目录展开**（`base` = 起进程时的 cwd）。到了记录端只剩
// 会话 id，而同一条会话续聊时可以换工作目录——拿会话当初的目录去展开，会把新目录里写的东西
// 记到旧目录头上（复审第 1 轮 #3）。`base` 拿不到（或者不是绝对路径，比如接管进程时的 "."）
// 才把相对路径原样交出去，由记录端按当时那一回合的目录兜底。
const cleanPaths = (values: unknown[], base?: string): string[] => {
  const anchor = base && isAbsolute(base) ? base : null;
  return [...new Set(values
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .map((value) => (anchor && !isAbsolute(value) ? resolve(anchor, value) : value)))];
};

/** claude 一次 tool_use 写到的文件；不是写文件工具就是 null。 */
export function claudeToolWrites(name: unknown, input: unknown, base?: string): AgentEvent | null {
  const field = typeof name === "string" ? CLAUDE_WRITE_TOOLS[name] : undefined;
  if (!field || !input || typeof input !== "object") return null;
  const paths = cleanPaths([(input as Record<string, unknown>)[field]], base);
  return paths.length ? { kind: "writes", paths } : null;
}

/** 一次调用的入参里最多攒这么多条等结果——中途被打断、永远等不到结果的那些不能无限堆。 */
const MAX_PENDING_WRITES = 256;

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const recordOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? value as Record<string, unknown> : {};

/** 在 `original` 上做一次替换；旧串找不到就推不出来。 */
function replaced(original: string, oldText: string, newText: string, all: boolean): string | null {
  if (!oldText) return original === "" ? newText : null;
  if (all) return original.includes(oldText) ? original.split(oldText).join(newText) : null;
  const at = original.indexOf(oldText);
  return at < 0 ? null : original.slice(0, at) + newText + original.slice(at + oldText.length);
}

/**
 * claude 一次写文件调用**写完之后的全文**：只从入参和回执里推，不读磁盘（见文件顶部）。回执里
 * 的字段优先——那是工具实际用的（它会规整引号之类），入参只是模型请求的。
 */
function claudeWrittenText(name: string, input: Record<string, unknown>, result: Record<string, unknown>): string | null {
  if (name === "Write") return text(input.content) ?? text(result.content);
  const original = text(result.originalFile) ?? text(result.originalFileContents);
  if (original === null) return null;
  if (name === "Edit") {
    const oldText = text(result.oldString) ?? text(input.old_string);
    const newText = text(result.newString) ?? text(input.new_string);
    if (oldText === null || newText === null) return null;
    return replaced(original, oldText, newText, (result.replaceAll ?? input.replace_all) === true);
  }
  if (name === "MultiEdit") {
    const edits = Array.isArray(result.edits) ? result.edits : Array.isArray(input.edits) ? input.edits : null;
    let current: string | null = edits ? original : null;
    for (const edit of edits ?? []) {
      const entry = recordOf(edit);
      const oldText = text(entry.old_string) ?? text(entry.oldString);
      const newText = text(entry.new_string) ?? text(entry.newString);
      if (current === null || oldText === null || newText === null) return null;
      current = replaced(current, oldText, newText, (entry.replace_all ?? entry.replaceAll) === true);
    }
    return current;
  }
  return null;
}

/** 给一份写入补上指纹（只给绝对路径、产物那几类）。 */
const withDigest = (writes: Extract<AgentEvent, { kind: "writes" }>, path: string, written: string | null): AgentEvent => {
  const digest = written !== null && isAbsolute(path) && kindOf(path) ? contentDigest(written) : null;
  return digest ? { ...writes, digests: { [path]: digest } } : writes;
};

/**
 * 一条 claude 消息上的 `tool_use_result`（工具自己的结构化回执）——只在这条消息只装着一个工具结果
 * 时才认：装着好几个时它对应哪个说不清，宁可不用（不用只是少给一个指纹）。
 */
export function soleReceipt(message: { tool_use_result?: unknown; message?: { content?: unknown } }): unknown {
  const blocks = Array.isArray(message.message?.content) ? message.message.content : [];
  return blocks.filter((block) => recordOf(block).type === "tool_result").length === 1 ? message.tool_use_result : undefined;
}

/**
 * claude 的写文件调用要配上结果才算数：`tool_use` 先记下，`tool_result` 没报错才放出来。
 * 主会话与子智能体共用一本（调用 id 全局唯一）。
 */
export class ClaudeWriteLedger {
  private pending = new Map<string, { name: string; input: Record<string, unknown>; writes: Extract<AgentEvent, { kind: "writes" }> }>();

  /** `base`：这条流所属进程的工作目录（相对路径按它展开）。 */
  constructor(private readonly base?: string) {}

  toolUse(name: unknown, input: unknown, id: unknown): void {
    const writes = claudeToolWrites(name, input, this.base);
    if (!writes || writes.kind !== "writes" || typeof id !== "string" || !id) return;
    if (this.pending.size >= MAX_PENDING_WRITES) this.pending.delete(this.pending.keys().next().value!);
    this.pending.set(id, { name: name as string, input: recordOf(input), writes });
  }

  /** `result`：这条工具结果的结构化回执（`soleReceipt`），没有就不传。 */
  toolResult(id: unknown, isError: boolean, result?: unknown): AgentEvent | null {
    if (typeof id !== "string") return null;
    const call = this.pending.get(id);
    this.pending.delete(id);
    if (!call || isError) return null;
    const path = call.writes.paths[0]!;
    const receipt = recordOf(result);
    // 回执说的不是这个文件（对不上号）就不用它。
    const target = text(receipt.filePath);
    const usable = !target || resolve(this.base && isAbsolute(this.base) ? this.base : "/", target) === path ? receipt : {};
    return withDigest(call.writes, path, claudeWrittenText(call.name, call.input, usable));
  }
}

/**
 * codex 的条目这一次到底做成了没有。改文件只认 `completed`（`failed`/`declined`/还在进行都不算）；
 * 命令被拒绝（`declined`）就压根没在那个目录跑过，失败的命令照样在那儿跑过。
 */
const codexStatus = (item: Record<string, unknown>) =>
  typeof item.status === "string" ? item.status.replace(/[_ -]/g, "").toLowerCase() : "";

/**
 * codex 一次改文件动作写到的文件——**只认已完成的**。两种协议形状都认：app-server 的 `fileChange.changes`、
 * `codex exec --json` 的 `file_change.changes`（`[{ path, kind }]`），以及老版本单个 `path`。
 * 改名的那一条另带 `move_path`/`movePath`，目标也算写过。
 */
export function codexChangeWrites(item: unknown, base?: string): AgentEvent | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  if (codexStatus(record) !== "completed") return null;
  const changes = Array.isArray(record.changes) ? record.changes : [];
  const digests: Record<string, string> = {};
  const paths = cleanPaths([
    record.path,
    ...changes.flatMap((change) => {
      if (!change || typeof change !== "object") return [];
      const entry = change as Record<string, unknown>;
      const kind = entry.kind && typeof entry.kind === "object" ? entry.kind as Record<string, unknown> : {};
      const moved = entry.move_path ?? entry.movePath ?? kind.move_path ?? kind.movePath;
      // 新建文件的 diff 就是全文（app-server 协议）；改已有文件的 diff 推不出全文，不给指纹。
      const created = (entry.kind === "add" || kind.type === "add") && !moved;
      const [path] = cleanPaths([entry.path], base);
      const content = text(entry.diff);
      if (created && path && content !== null && isAbsolute(path) && kindOf(path)) {
        const digest = contentDigest(content);
        if (digest) digests[path] = digest;
      }
      return [entry.path, entry.move_path, entry.movePath, kind.move_path, kind.movePath];
    }),
  ], base);
  if (!paths.length) return null;
  return Object.keys(digests).length ? { kind: "writes", paths, digests } : { kind: "writes", paths };
}

/** codex 一条命令的工作目录（弱证据）。协议没带、或者命令被拒绝没跑，就是 null。 */
export function codexCommandCwd(item: unknown, base?: string): AgentEvent | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  if (["declined", "inprogress", ""].includes(codexStatus(record))) return null;
  const paths = cleanPaths([record.cwd], base);
  return paths.length ? { kind: "writes", paths, cwd: true } : null;
}
