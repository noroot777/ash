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
//   ④ 第 4 轮：反过来栽了一次 —— 拿「这条会话现在有活进程」当「起它的那一代还活着」。
//      `sessions.agent_pid`/`agent_started_at` **每回合被下一轮覆盖**，所以上一轮的进程早
//      死了、同一 CLI 会话的新进程还在跑时，历史投影会被判成「正在盯着」（实测
//      reusedSession：previousSourceAlive=false、currentSourceAlive=true，卡片 running）。
//
// 所以判据分两层，**按证据强度排序**：
//   - **代次**（强）：投影行自己记下的 `source_pid`/`source_pid_started_at` —— 起它的那一代
//     进程。比得上就是活的，比不上就是死的，不再往下问。
//   - **会话 / 任务**（弱）：代次不明的老行才走这一层。方向仍是「不知道就别判死」。
//
// 这两层不能倒过来用：代次是「谁起的它」，会话只是「这条流现在有没有人在跑」。
import { and, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { sessions } from "./db/schema.js";
import { isSameProcess } from "./proc.js";

/** 判死活要用到的那几列。代次两列优先，缺了才回退会话/任务。 */
export type MonitorOrigin = {
  cliSessionId: string | null;
  taskId: string;
  /** 起它的那一代 agent 进程。null = 代次不明（历史回填时 sessions 那两列已被覆盖）。 */
  sourcePid?: number | null;
  sourcePidStartedAt?: string | null;
};

export type LivenessProbe = {
  /** 起这条投影的那个 agent 进程还在不在。判据分层见文件头。 */
  sourceAlive(origin: MonitorOrigin): Promise<boolean>;
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
    async sourceAlive({ cliSessionId, taskId, sourcePid, sourcePidStartedAt }) {
      // ① 代次。记下了就只认它——这是「起它的那一代进程」的直接证据，比「这条会话现在有没有
      //    活进程」强得多（后者在 resume/下一回合之后说的已经是另一代人了）。
      //    0 是个明确结论而不是缺省值：历史重建判明「它那一代 run 之后又起过新的 run」。
      if (sourcePid === 0) return false;
      if (sourcePid) return isSameProcess(sourcePid, sourcePidStartedAt ?? null);
      // ② 代次不明的老行：**有会话凭据就信凭据，不往任务那一层回退。** 一个任务可能有好几条
      //    claude 会话：A 的 agent 已结束、B 还在跑时，A 名下的投影确实该判死。回退到「任务里
      //    还有活着的 agent」会把 A 的投影留成僵尸卡——那是第 1 轮那个毛病换了个入口。
      if (cliSessionId) return sessionLive(cliSessionId);
      // ③ 连会话都没记的存量行才兜底按任务反查（见文件头 ②：不知道 ≠ 已经死了）。
      return taskLive(taskId);
    },
  };
}
