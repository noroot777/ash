import type { AgentEvent } from "@ash/shared";

// 工具调用「写到了哪里」——从执行器原生事件的**结构化参数**里取，不从展示用的 detail 里抠：
// detail 被截到 1500 字，claude 的 Write 连同整段文件内容一起序列化，截完就不是合法 JSON 了
// （实测一个任务 14 次 Write 里 13 条拆不开）。取出来的事实只走 `writes` 事件，去处见
// server/src/task-writes.ts。
//
// 只认**写文件、改文件的工具**和**命令的工作目录**两样。shell 命令写到哪儿从命令文本里分析
// 不可靠（重定向、脚本里的路径、`-o` 参数五花八门），不猜。

/** claude 的写文件/改文件工具 → 目标路径所在的入参字段。 */
const CLAUDE_WRITE_TOOLS: Record<string, string> = {
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

const cleanPaths = (values: unknown[]): string[] =>
  [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim() !== ""))];

/** claude 一次 tool_use 写到的文件；不是写文件工具就是 null。 */
export function claudeToolWrites(name: unknown, input: unknown): AgentEvent | null {
  const field = typeof name === "string" ? CLAUDE_WRITE_TOOLS[name] : undefined;
  if (!field || !input || typeof input !== "object") return null;
  const paths = cleanPaths([(input as Record<string, unknown>)[field]]);
  return paths.length ? { kind: "writes", paths } : null;
}

/**
 * codex 一次改文件动作写到的文件。两种协议形状都认：app-server 的 `fileChange.changes`、
 * `codex exec --json` 的 `file_change.changes`（`[{ path, kind }]`），以及老版本单个 `path`。
 * 改名的那一条另带 `move_path`/`movePath`，目标也算写过。
 */
export function codexChangeWrites(item: unknown): AgentEvent | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  const changes = Array.isArray(record.changes) ? record.changes : [];
  const paths = cleanPaths([
    record.path,
    ...changes.flatMap((change) => {
      if (!change || typeof change !== "object") return [];
      const entry = change as Record<string, unknown>;
      const kind = entry.kind && typeof entry.kind === "object" ? entry.kind as Record<string, unknown> : {};
      return [entry.path, entry.move_path, entry.movePath, kind.move_path, kind.movePath];
    }),
  ]);
  return paths.length ? { kind: "writes", paths } : null;
}

/** codex 一条命令的工作目录（弱证据）。协议没带就是 null。 */
export function codexCommandCwd(item: unknown): AgentEvent | null {
  const cwd = item && typeof item === "object" ? (item as Record<string, unknown>).cwd : undefined;
  const paths = cleanPaths([cwd]);
  return paths.length ? { kind: "writes", paths, cwd: true } : null;
}
