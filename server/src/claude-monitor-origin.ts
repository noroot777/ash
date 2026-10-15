// 一条 claude 流的**来源身份**：起这条流上那些内置 Monitor 的，是哪一代 agent 进程、
// 哪一个 run 文件。
//
// ── 为什么它必须是「绑定」而不是「查询」 ────────────────────────────────────────
//
// `sessions.agent_pid` / `agent_started_at` / `agent_out_path` 记的是**这条会话当下那一代**
// 进程，每个回合都被下一轮整组覆盖（见 orchestrator 里那句「这一轮的解绑线索必须整组刷新」）。
// 而实时投影的写库是排队的 —— 事件消费完到真正落库之间隔着整条队列（前面积压多久就晚
// 多久，实测注入 2.2 秒的前序 job 就偏 2205ms）。于是「落库那一刻去问 sessions」拿到的
// 可能是**下一代**人的凭据：
//
//   上一轮结束 → 很快继续运行同一个任务 → 旧流的 open 这时才落库 → 它给上一轮的监听写上
//   新一代的 pid 和新一代的 run 文件 → 死活裁决看到「这一行的 run 就是最新的、它的 pid 真
//   活着」，于是把早就结束的旧卡续命成「正在盯着」，刷新和反复回填都不自愈
//   （TH0EwDCQoipl 第 1 轮审查 F1 用真实两代进程 + 生产服务 + 真页面实测）。
//
// 所以来源身份在**流开始那一刻**定下来，之后落库、收尾、历史纠正全用同一份：
//
// - 生产路径（`executors/claude-stream.ts`）：直接从这条流自己的 child 上取 —— 这条 stdout
//   就是那个进程写的，那组落盘路径就是它的 run 文件，跟库里任何一行当下的值无关。
// - 没有 child 可问时（直接 new 出来的 Trace）：**构造那一刻**查一次会话并冻住。那一刻还在
//   本代人手里；晚到落库那一刻就已经是另一代了。
//
// 两种都拿不到就按「没有凭据」落库（NULL），由 `claude-monitor-liveness.ts` 退回会话/任务
// 那一层 —— 不猜一个会随时间漂的值。
import { eq } from "drizzle-orm";
import { db, dbClient } from "./db/index.js";
import { sessions } from "./db/schema.js";
import { inspectProcess } from "./proc.js";

/** 一条流的来源身份。**一经绑定不再改**（见文件头）。 */
export type MonitorRunOrigin = {
  /** 起它的那一代 agent 进程。null = 没有凭据。 */
  pid: number | null;
  /** 那个进程的启动时刻（pid 会被复用，判死活必须两样一起比，见 proc.ts）。 */
  pidStartedAt: string | null;
  /** 那一代写的 run 文件（绝对路径）。"" = 这条流没有落盘文件（Windows / 常驻会话）。 */
  runPath: string;
};

export const UNKNOWN_RUN_ORIGIN: MonitorRunOrigin = { pid: null, pidStartedAt: null, runPath: "" };

/** 这份凭据有没有内容。两样都空 = 调用方其实没给（合成的失败 child、第三方 parser）。 */
export const hasRunOrigin = (origin: MonitorRunOrigin | null | undefined): boolean =>
  !!origin && !!(origin.pid || origin.runPath);

/**
 * 从这条流自己的 child 上取来源身份。
 *
 * `ashPaths` 是 detached 形态自带的那组落盘路径（`executors/detached.ts`：out/err/rc，
 * 其中 out 就是 `sessions.agent_out_path` 这一轮的值），非 detached（Windows、常驻调度台）
 * 没有这一组，那就只剩 pid —— 而那种会话 `sessions.agent_out_path` 本来也是 NULL，两边说的
 * 是同一件事。
 *
 * 启动时刻**在这里就读**（进程刚起来、必然还在），不留到落库那一刻：那时它可能已经退出，
 * `inspectProcess` 返回 null，代次凭据就只剩一个会被复用的 pid。
 */
export function runOriginOfChild(
  child: { pid?: number | null; ashPaths?: { out?: string } } | null | undefined,
): MonitorRunOrigin {
  const pid = child?.pid ?? null;
  return {
    pid,
    pidStartedAt: pid ? inspectProcess(pid)?.startedAt ?? null : null,
    runPath: child?.ashPaths?.out ?? "",
  };
}

/** 一条会话行上那一代的凭据。**只许在流开始那一刻抄**（见文件头）。 */
export const runOriginOfSession = (
  home: { pid: number | null; pidStartedAt: string | null; outPath: string },
): MonitorRunOrigin => ({ pid: home.pid, pidStartedAt: home.pidStartedAt, runPath: home.outPath });

/** 这条 CLI 会话落在哪个 ash 任务上，以及（**只给绑定层**）它当下那一代的凭据。 */
export type SessionHome = {
  taskId: string;
  cwd: string;
  pid: number | null;
  pidStartedAt: string | null;
  outPath: string;
};

/**
 * cli 会话 id → ash 的任务 id、工作目录，以及**当代** agent 进程身份。
 *
 * `taskId`/`cwd` 随时问都对（会话行的归属不变），**后三列只有来源绑定层那一次能用**：它们
 * 每回合被下一轮覆盖，拿落库那一刻的值当「起它的是哪一代」就是文件头说的那个 F1。
 */
export async function locateSession(cliSessionId: string): Promise<SessionHome | null> {
  if (!cliSessionId || dbClient.closed) return null;
  const row = (await db
    .select({
      taskId: sessions.taskId, cwd: sessions.cwd,
      pid: sessions.agentPid, pidStartedAt: sessions.agentStartedAt,
      outPath: sessions.agentOutPath,
    })
    .from(sessions)
    .where(eq(sessions.cliSessionId, cliSessionId))).at(0);
  return row
    ? {
      taskId: row.taskId, cwd: row.cwd ?? "", pid: row.pid ?? null,
      pidStartedAt: row.pidStartedAt ?? null, outPath: row.outPath ?? "",
    }
    : null;
}
