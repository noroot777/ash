import type { ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { AgentEvent } from "@ash/shared";
import { cleanupAfterRun, redactSecrets, spawnAgent } from "./spawn.js";
import { findArchivedRollout, findRollout } from "./codex-rollout.js";
import { pruneArchivedCodexDesktopThreads } from "./codex-desktop-catalog.js";

export const CODEX_ARCHIVE_TIMEOUT_MS = 5_000;

export type CodexArchiveProcess = {
  bin: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  startProcess?: () => ChildProcess;
};

/** 异常退出后的归档只操作持久会话，不 resume、不启动模型回合或 MCP 工具。 */
export async function archiveCodexThread(opts: CodexArchiveProcess, threadId: string): Promise<void> {
  const archivedIds = await updateCodexThreadArchive(opts, threadId, "thread/archive");
  await pruneArchivedCodexDesktopThreads([threadId, ...archivedIds], opts.env?.CODEX_HOME);
}

export async function unarchiveCodexThread(opts: CodexArchiveProcess, threadId: string): Promise<void> {
  await updateCodexThreadArchive(opts, threadId, "thread/unarchive");
}

export function codexArchiveNotice(error: unknown): AgentEvent {
  const detail = redactSecrets(error instanceof Error ? error.message : String(error));
  return { kind: "system", level: "notice", at: new Date().toISOString(),
    text: `Codex 会话自动归档未完成，桌面端可能仍显示此会话；执行结果与续跑记录保留。${detail}` };
}

/** exec 新建的会话本来就不在桌面默认列表；从 app-server/TUI 转来的会话仍保留原 source。 */
async function visibleInDesktop(threadId: string, configDir?: string): Promise<boolean> {
  const file = await findRollout(threadId, configDir);
  if (!file) return false;
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let count = 0;
  try {
    for await (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (row.type === "session_meta") return ["cli", "vscode"].includes(row.payload?.source);
      } catch { /* 容忍空行与文件头噪声 */ }
      if (++count >= 32) break;
    }
  } catch { /* 旧版/缺失 rollout 保持原 exec 行为 */ }
  finally { lines.close(); stream.destroy(); }
  return false;
}

/** 单轮 exec 在 done 前收尾；常驻 exec 在整个会话关闭后收尾，中间回合仍可直接 resume。 */
export async function* archiveVisibleCodexSession(
  events: AsyncIterable<AgentEvent>, opts: CodexArchiveProcess, initialThreadId = "",
  cleanup?: () => Promise<void>,
): AsyncIterable<AgentEvent> {
  let threadId = initialThreadId;
  let done: Extract<AgentEvent, { kind: "done" }> | undefined;
  for await (const event of events) {
    if (event.kind === "session") threadId = event.cliSessionId;
    if (event.kind === "done") done = event;
    else yield event;
  }
  try {
    if (threadId && await visibleInDesktop(threadId, opts.env?.CODEX_HOME)) {
      await cleanup?.();
      if (!(await findArchivedRollout(threadId, opts.env?.CODEX_HOME))) await archiveCodexThread(opts, threadId);
      else await pruneArchivedCodexDesktopThreads([threadId], opts.env?.CODEX_HOME);
    }
  } catch (error) { yield codexArchiveNotice(error); }
  if (done) yield done;
}

async function updateCodexThreadArchive(
  opts: CodexArchiveProcess, threadId: string, method: "thread/archive" | "thread/unarchive",
): Promise<string[]> {
  const action = method === "thread/archive" ? "归档" : "恢复归档";
  const child = opts.startProcess?.()
    ?? spawnAgent(opts.cwd, opts.bin, opts.args, "", opts.env, { keepStdin: true });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let requestId = 0;
  let closed = false;
  const archivedIds = new Set<string>();
  const rejectAll = (error: Error) => {
    closed = true;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  const request = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
    if (closed || !child.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
      reject(new Error(`Codex ${action}连接已关闭`)); return;
    }
    const id = ++requestId;
    pending.set(id, { resolve, reject });
    try {
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (error) rejectAll(error);
      });
    } catch (error) { rejectAll(error instanceof Error ? error : new Error(String(error))); }
  });
  const lines = createInterface({ input: child.stdout! });
  lines.on("line", (line) => {
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method === "thread/archived" && typeof message.params?.threadId === "string") {
      archivedIds.add(message.params.threadId);
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(String(message.error.message ?? `Codex ${action}失败`)));
    else waiter.resolve(message.result);
  });
  child.stderr?.resume();
  child.stdin?.on?.("error", rejectAll);
  child.on("error", rejectAll);
  child.on("exit", () => rejectAll(new Error(`Codex ${action}进程已退出`)));
  child.on("close", () => rejectAll(new Error(`Codex ${action}连接已关闭`)));
  const timer = setTimeout(() => rejectAll(new Error(`Codex 会话${action}超时`)), CODEX_ARCHIVE_TIMEOUT_MS);
  try {
    await request("initialize", {
      clientInfo: { name: "ash", title: "ash", version: "0.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    child.stdin?.write(`${JSON.stringify({ method: "initialized" })}\n`);
    await request(method, { threadId });
    return [...archivedIds];
  } finally {
    clearTimeout(timer);
    lines.close();
    child.stdin?.end();
    await cleanupAfterRun(child);
  }
}
