import { eq, sql } from "drizzle-orm";
import { isAbsolute, resolve } from "node:path";
import type { AgentEvent } from "@ash/shared";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { sessions, taskWrites } from "./db/schema.js";

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

/** 会话工作目录：相对路径按它展开。一条会话的 cwd 在跑的过程中不变，缓存住省得每步查库。 */
const sessionCwds = new Map<string, string | null>();

async function sessionCwd(sessionId: string): Promise<string | null> {
  if (sessionCwds.has(sessionId)) return sessionCwds.get(sessionId)!;
  const row = (await db.select({ cwd: sessions.cwd }).from(sessions).where(eq(sessions.id, sessionId))).at(0);
  const cwd = row?.cwd?.trim() || null;
  if (sessionCwds.size > 500) sessionCwds.clear();
  sessionCwds.set(sessionId, cwd);
  return cwd;
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
    const cwd = await sessionCwd(sessionId);
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
