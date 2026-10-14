// 「起这个内置 Monitor 的 agent 进程还活着吗」——投影侧唯一可靠的死活判据。
//
// claude 投影没有自己的 pid（进程在 agent 的进程树里，`reattachMonitors` 按 kind 整批跳过
// 它们），所以判它是不是还在盯着，只能去问**它所属的那条 agent 会话**。这件事有两个调用点：
//
// - 开机清扫（`loseDeadClaudeMonitors`）：ash 重启了，重新判一次谁还活着。
// - 历史回填（`claude-monitor-backfill`）：历史文件里没读到终态，是「那一轮早就没了」还是
//   「它现在还在盯着」？两者的卡片写法完全相反。
//
// 判据只有一份，是因为第 1、2、3 轮审查在这一点上连着栽了三次，每次都是**同一个错**换个
// 地方犯：拿「我手上没有它的凭据」当「它已经死了」。
//   ① 第 1 轮：开机无条件把 running 投影标 lost —— 可 agent 活得过 ash 重启（detached），
//      于是「任务还在输出、哨兵却说进程已不在」。
//   ② 第 2 轮：`cli_session_id` 为空的存量行直接判死 —— 实测 sourceAlive=true 却被标 lost。
//   ③ 第 3 轮：回填对没读到终态的一律写 lost —— 实测来源还活着，卡片却写「早已结束」。
//
// 所以这里的默认方向是**不知道就别判死**：拿不到凭据时退一步按任务反查，整个任务都没有活着
// 的 claude agent 了，才算确实没了。
import { and, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { sessions } from "./db/schema.js";
import { isSameProcess } from "./proc.js";

export type LivenessProbe = {
  /** 这条投影的来源 agent 进程还在不在。`cliSessionId` 缺失时按任务兜底。 */
  sourceAlive(cliSessionId: string | null, taskId: string): Promise<boolean>;
};

/**
 * 建一个一次性的存活探针。
 *
 * **按会话/任务缓存**：一条会话上常挂着好几个投影（实测那个任务 12 个），同一个问题不该查
 * 12 次库。缓存的生命周期就是这一次清扫/回填——探针用完就扔，不会把陈旧答案带到下一轮。
 */
export function createLivenessProbe(): LivenessProbe {
  const anyLive = (rows: { pid: number | null; startedAt: string | null }[]): boolean =>
    rows.some((r) => !!r.pid && isSameProcess(r.pid, r.startedAt ?? null));

  const bySession = new Map<string, boolean>();
  const byTask = new Map<string, boolean>();

  const sessionLive = async (cliSessionId: string): Promise<boolean> => {
    const cached = bySession.get(cliSessionId);
    if (cached !== undefined) return cached;
    const rows = await db
      .select({ pid: sessions.agentPid, startedAt: sessions.agentStartedAt })
      .from(sessions)
      .where(eq(sessions.cliSessionId, cliSessionId));
    const live = anyLive(rows);
    bySession.set(cliSessionId, live);
    return live;
  };

  const taskLive = async (taskId: string): Promise<boolean> => {
    const cached = byTask.get(taskId);
    if (cached !== undefined) return cached;
    const rows = await db
      .select({ pid: sessions.agentPid, startedAt: sessions.agentStartedAt })
      .from(sessions)
      .where(and(eq(sessions.taskId, taskId), eq(sessions.agentType, "claude")));
    const live = anyLive(rows);
    byTask.set(taskId, live);
    return live;
  };

  return {
    async sourceAlive(cliSessionId, taskId) {
      // **有凭据就信凭据，不往任务那一层回退。** 一个任务可能有好几条 claude 会话：会话 A
      // 的 agent 已经结束、会话 B 还在跑时，A 名下的投影确实该判死。回退到「任务里还有活着
      // 的 agent」会把 A 的投影留成僵尸「正在盯着」卡——那正是第 1 轮要修的毛病换了个入口。
      if (cliSessionId) return sessionLive(cliSessionId);
      // 没有凭据才兜底按任务反查（见文件头 ②：不知道 ≠ 已经死了）。
      return taskLive(taskId);
    },
  };
}
