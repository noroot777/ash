import { isAbsolute, resolve } from "node:path";
import type { AgentEvent } from "@ash/shared";

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

/**
 * claude 的写文件调用要配上结果才算数：`tool_use` 先记下，`tool_result` 没报错才放出来。
 * 主会话与子智能体共用一本（调用 id 全局唯一）。
 */
export class ClaudeWriteLedger {
  private pending = new Map<string, AgentEvent>();

  /** `base`：这条流所属进程的工作目录（相对路径按它展开）。 */
  constructor(private readonly base?: string) {}

  toolUse(name: unknown, input: unknown, id: unknown): void {
    const writes = claudeToolWrites(name, input, this.base);
    if (!writes || typeof id !== "string" || !id) return;
    if (this.pending.size >= MAX_PENDING_WRITES) this.pending.delete(this.pending.keys().next().value!);
    this.pending.set(id, writes);
  }

  toolResult(id: unknown, isError: boolean): AgentEvent | null {
    if (typeof id !== "string") return null;
    const writes = this.pending.get(id);
    this.pending.delete(id);
    return writes && !isError ? writes : null;
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
  const paths = cleanPaths([
    record.path,
    ...changes.flatMap((change) => {
      if (!change || typeof change !== "object") return [];
      const entry = change as Record<string, unknown>;
      const kind = entry.kind && typeof entry.kind === "object" ? entry.kind as Record<string, unknown> : {};
      return [entry.path, entry.move_path, entry.movePath, kind.move_path, kind.movePath];
    }),
  ], base);
  return paths.length ? { kind: "writes", paths } : null;
}

/** codex 一条命令的工作目录（弱证据）。协议没带、或者命令被拒绝没跑，就是 null。 */
export function codexCommandCwd(item: unknown, base?: string): AgentEvent | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  if (["declined", "inprogress", ""].includes(codexStatus(record))) return null;
  const paths = cleanPaths([record.cwd], base);
  if (!paths.length) return null;
  // 命令是做完才报的；跑了多久（app-server 带 `durationMs`）要交出去，记录端据此把「从什么时候起
  // 在这儿干活」往回拨——一条跑十分钟的渲染命令，它的产物早在报出来之前就落盘了。
  const took = Number(record.durationMs ?? record.duration_ms);
  return Number.isFinite(took) && took > 0
    ? { kind: "writes", paths, cwd: true, tookMs: took }
    : { kind: "writes", paths, cwd: true };
}
