import { desc, eq, sql } from "drizzle-orm";
import { isAbsolute, resolve } from "node:path";
import type { AgentEvent } from "@ash/shared";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { sessions, sessionTurns, taskWrites } from "./db/schema.js";
import { pathLens } from "./task-artifact-paths.js";

// 「这个任务往哪里写过东西」的写入端。执行器当场报出 `writes` 事件（executors/tool-writes.ts），
// 这里按任务落库；读取端是生成物面板（task-artifact-direct.ts）。
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
  // 落库存**归一后的路径**（软链解开）：读取端按真实路径比，同一个目录从两个入口写进来、从两个
  // 入口去看，认出来的必须是同一份（XPvT3Fdm8bi5 第 2 轮 #3）。指纹按执行器报上来的那个写法对。
  const lens = pathLens();
  const rows = new Map<string, string | null>();
  for (const raw of event.paths) {
    let absolute = raw;
    if (!isAbsolute(raw)) {
      // 相对路径又查不到会话目录：无从知道它指哪儿，不记——记错比不记更糟（会把别处的
      // 产物判给它）。
      const cwd = await currentCwd(sessionId);
      if (!cwd) continue;
      absolute = resolve(cwd, raw);
    }
    rows.set(await lens.canonical(absolute), event.digests?.[raw] ?? null);
  }
  const weak = event.cwd ? 1 : 0;
  for (const [path, digest] of rows) {
    await db.insert(taskWrites)
      .values({ taskId, path, weak, firstAt: at, lastAt: at, digest })
      .onConflictDoUpdate({
        target: [taskWrites.taskId, taskWrites.path, taskWrites.weak],
        // 两次记录可能乱序落库（每一条都要先查目录、解软链）：时刻两端各取极值，内容指纹只认
        // **更晚那一次**写下的——它才对应现在磁盘上该有的那一版；更晚那次推不出内容（没有指纹）时
        // 也照样清掉旧的，旧的已经不是它最后写下的样子。时刻都是同一种 ISO 写法，按字典序比就是
        // 按时间比。
        set: {
          firstAt: sql`min(${taskWrites.firstAt}, excluded.first_at)`,
          lastAt: sql`max(${taskWrites.lastAt}, excluded.last_at)`,
          digest: sql`case when excluded.last_at >= ${taskWrites.lastAt} then excluded.digest else ${taskWrites.digest} end`,
        },
      });
  }
}
