import { desc, eq, sql } from "drizzle-orm";
import { isAbsolute, resolve } from "node:path";
import type { AgentEvent } from "@ash/shared";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { sessions, sessionTurns, taskWrites } from "./db/schema.js";

// 「这个任务往哪里写过东西」的写入端。执行器当场报出 `writes` 事件（executors/tool-writes.ts），
// 这里按任务落库；读取端是生成物面板的并发裁决（task-artifact-footprint.ts）。
//
// **挂在总线上，不挂在某一条执行链里**：单飞、讨论、团队调度台三条链都把执行器事件原样广播
// 出去，在这里接一次就全覆盖了，下一条新执行链不用记得补（同一个办法见 uploads.ts 的
// watchAgentUploads）。事件本身只给这里用，`/events` 出口不往前端推。

let watching = false;

export function watchTaskWrites(): void {
  if (watching) return;
  watching = true;
  bus.subscribe((event) => {
    if (event.type !== "agent.event" || event.event.kind !== "writes") return;
    void recordTaskWrites(event.taskId, event.sessionId, event.event).catch((error) => {
      console.warn("[ash] 记录任务写过的位置失败，忽略:", error);
    });
  });
}

/**
 * 相对路径的兜底基准：这条会话**眼下这一回合**的工作目录（回合表里最近开始的那一回合），
 * 没有回合记录才退回会话行上的 cwd。
 *
 * 正常情况下执行器已经按起进程时的 cwd 展开好了（executors/tool-writes.ts），走到这里的只有
 * 拿不到那个 cwd 的情形。**不缓存**：同一条会话续聊时可以换工作目录，按会话 id 记住当初那个
 * 目录，会把新目录里写的东西一直记到旧目录头上（复审第 1 轮 #3）。
 */
async function currentCwd(sessionId: string): Promise<string | null> {
  const turn = (await db.select({ cwd: sessionTurns.cwd }).from(sessionTurns)
    .where(eq(sessionTurns.sessionId, sessionId)).orderBy(desc(sessionTurns.startedAt)).limit(1)).at(0);
  if (turn?.cwd?.trim()) return turn.cwd.trim();
  const row = (await db.select({ cwd: sessions.cwd }).from(sessions).where(eq(sessions.id, sessionId))).at(0);
  return row?.cwd?.trim() || null;
}

export async function recordTaskWrites(
  taskId: string,
  sessionId: string,
  event: Extract<AgentEvent, { kind: "writes" }>,
  at = new Date().toISOString(),
): Promise<void> {
  const absolute: string[] = [];
  for (const raw of event.paths) {
    if (isAbsolute(raw)) {
      absolute.push(resolve(raw));
      continue;
    }
    // 相对路径又查不到会话目录：无从知道它指哪儿，不记——记错比不记更糟（会把别处的
    // 产物判给它）。
    const cwd = await currentCwd(sessionId);
    if (cwd) absolute.push(resolve(cwd, raw));
  }
  const weak = event.cwd ? 1 : 0;
  for (const path of new Set(absolute)) {
    await db.insert(taskWrites)
      .values({ taskId, path, weak, firstAt: at, lastAt: at })
      .onConflictDoUpdate({
        target: [taskWrites.taskId, taskWrites.path, taskWrites.weak],
        set: { lastAt: sql`excluded.last_at` },
      });
  }
}
