// claude 内置**后台子代理**（Agent）与**后台 Bash**（`run_in_background`）随回合收尾被收走时，
// 在任务时间线上如实留一笔。内置 Monitor 那一档见 claude-monitor-reaped.ts，口径照抬。
//
// ── 为什么要留这一笔 ─────────────────────────────────────────────────────────
//
// 跟内置 Monitor 是同一个坑：它们的进程寄生在智能体自己的进程树里，回合一结束 CLI 收台，
// 它们跟着没了；完成通知只注回那条随之结束的会话，从来不会唤醒任务。2026-11-03 的事故
// （任务 Yx0fsyjeZC3X）：执行者派了一个后台子代理去查证，然后结束回合「等它回来」，
// 空等两轮（其中一轮 1.09M token），用户去戳才发现。run 文件原始行序：
//
// ```
// assistant tool_use Agent(...)                                       ← 派出子代理
// system    task_started task_type=local_agent task_id=ac31…          ← 起来了
// user      tool_result "Async agent launched successfully…"          ← 调用返回，它还在跑
// result    success                                                   ← 回合结束，本文件到此为止
// ---- 下一个 run 文件（下一代进程）----
// system    task_notification task_id=ac31… status=stopped
//           summary "Background agent \"…\" didn't finish before the previous session ended"
// ```
//
// 内置 Monitor 有 PreToolUse hook 改道成 ash 哨兵兜底，这两种没有（它们不是「等」的工具，
// 拦不得），所以只能事前在每回合提醒里说一句（turn-prompt.ts 的 `backgroundWait`），事后
// 在这里如实记账。
//
// ── 怎么认「后台」──────────────────────────────────────────────────────────
//
// `task_started` 不只后台任务发：耗时稍长的**同步** Bash 也发（同一个事故任务里 30 多条
// `local_bash`，几乎全是同步的），它们在自己的 tool_result 之前就收到 `completed`。所以判据
// 是语义上的那一条：**发起它的那次调用已经返回了，它还没结束**——活得比调用久，才叫后台。
// 不看 `run_in_background` 入参（子代理默认就是后台的，入参里根本没有这个字段），也不看
// 回执文案。
//
// ── 怎么认「被收走」────────────────────────────────────────────────────────
//
// 流结束时还没有终态的 → 被收走（进程都没了）。另有一种：CLI 收台时自己补发 `stopped`，
// 它落在回合的 `result` **之后**、下一段助手输出之前（内置 Monitor 那边实测的行序）——那
// 也是被收走，不是智能体自己 TaskStop 的（那一下必然发生在某次助手输出之后、`result` 之前）。
// 常驻进程（团队调度台）里后台任务跨回合活着、在空档里 `completed` 也是真跑完，照常算。
//
// ── 观测不到的档位（降级）──────────────────────────────────────────────────
//
// - **接管回来的流**（ash 重启后 detached 续读）从已消费位置之后读起，那之前的
//   `task_started` 不会重放 → 那些任务这里看不见，不记账（宁可少说，不编）。事前警告兜底。
// - **其它执行器**（codex 等）没有这套结构化的后台任务事件，不做；同样只有事前警告。
import { desc, eq } from "drizzle-orm";
import { claudeMonitorStatus } from "@ash/shared/monitor-claude";
import { isTaskRevoked } from "./claude-monitor-revoked.js";
import { db, dbClient } from "./db/index.js";
import { sessions } from "./db/schema.js";
import { appendTaskTimeline } from "./task-timeline.js";

export type BackgroundKind = "agent" | "bash";

/** 一种后台任务这一轮的结局分档。三档互斥，`total` 是三者之和。 */
export interface BackgroundTally {
  total: number;
  /** 自己结束的（completed / failed / 超时）。 */
  finished: number;
  /** 回合还在进行时被智能体自己停掉的。 */
  stopped: number;
  /** 回合结束时还在跑、随进程一并收走的。 */
  reaped: number;
}

interface Tracked {
  kind: BackgroundKind;
  toolUseId: string;
  /** 发起它的那次调用已经返回、而它当时还没结束。 */
  background: boolean;
  end: "finished" | "stopped" | "reaped" | null;
}

const KIND_LABEL: Record<BackgroundKind, string> = { agent: "后台子代理", bash: "后台 Bash" };

/**
 * 一条 claude 会话上的后台任务账本。每个 stream 一个实例，跟 `ClaudeMonitorTrace` 喂同样
 * 三样东西（tool_use、tool_result、system 事件）。纯内存、同步，只有 `finish` 落库。
 */
export class ClaudeBackgroundTrace {
  /** tool_use_id → 工具名。内置 Monitor 起的 `local_bash` 归 claude-monitor-reaped.ts 管。 */
  private tools = new Map<string, string>();
  /** 已经收到 tool_result 的调用。 */
  private returned = new Set<string>();
  private tasks = new Map<string, Tracked>();
  /** 回合 `result` 之后、下一段助手输出之前（见文件头「被收走」）。 */
  private idle = false;
  private cliSessionId: string;

  constructor(cliSessionId?: string) {
    this.cliSessionId = cliSessionId ?? "";
  }

  toolUse(name: unknown, toolUseId: unknown): void {
    if (typeof name === "string" && typeof toolUseId === "string" && toolUseId) this.tools.set(toolUseId, name);
  }

  toolResult(toolUseId: unknown): void {
    if (typeof toolUseId !== "string" || !toolUseId) return;
    this.returned.add(toolUseId);
    for (const task of this.tasks.values()) {
      if (task.toolUseId === toolUseId && !task.end) task.background = true;
    }
  }

  event(ev: any): void {
    if (!ev || typeof ev !== "object") return;
    if (ev.type === "result") { this.idle = true; return; }
    // 只认主智能体的输出：后台子代理自己的 assistant 事件（带 parent_tool_use_id）在空档里
    // 照样会来，那不是「新的一回合开始了」。
    if (ev.type === "assistant") { if (!ev.parent_tool_use_id) this.idle = false; return; }
    if (ev.type !== "system") return;
    if (!this.cliSessionId && typeof ev.session_id === "string") this.cliSessionId = ev.session_id;
    const taskId = typeof ev.task_id === "string" ? ev.task_id : "";
    if (!taskId) return;
    if (ev.subtype === "task_started") {
      const toolUseId = typeof ev.tool_use_id === "string" ? ev.tool_use_id : "";
      const kind = kindOf(ev.task_type, this.tools.get(toolUseId));
      if (!kind) return;
      // 同一个 task_id 可以再起一次（SendMessage 把停掉的子代理续上），按新的一条命算。
      this.tasks.set(taskId, { kind, toolUseId, background: !!toolUseId && this.returned.has(toolUseId), end: null });
      return;
    }
    if (ev.subtype !== "task_notification") return;
    const task = this.tasks.get(taskId);
    if (!task || task.end) return;
    const status = claudeMonitorStatus(ev.status);
    if (status === "running") return;
    task.end = status !== "stopped" ? "finished" : this.idle ? "reaped" : "stopped";
  }

  /** 这一轮的后台任务分档。只数真正活过发起调用的那些。 */
  tally(): Partial<Record<BackgroundKind, BackgroundTally>> {
    const out: Partial<Record<BackgroundKind, BackgroundTally>> = {};
    for (const task of this.tasks.values()) {
      if (!task.background) continue;
      const entry = out[task.kind] ??= { total: 0, finished: 0, stopped: 0, reaped: 0 };
      entry.total += 1;
      entry[task.end ?? "reaped"] += 1;
    }
    return out;
  }

  /**
   * 流结束那一刻调用（`executors/claude-stream.ts` 的 finally）。有被收走的才记一条；
   * 全都在回合里正常结束的，是后台命令的正当用法，不去打扰。不抛。
   */
  async finish(): Promise<void> {
    const notice = backgroundReapedNotice(this.tally());
    this.tasks.clear();
    if (!notice || !this.cliSessionId || dbClient.closed) return;
    try {
      const home = (await db
        .select({ id: sessions.id, taskId: sessions.taskId })
        .from(sessions)
        .where(eq(sessions.cliSessionId, this.cliSessionId))
        .orderBy(desc(sessions.startedAt))).at(0);
      if (!home || isTaskRevoked(home.taskId)) return;
      await appendTaskTimeline(home.taskId, notice, { sessionId: home.id });
    } catch (e) {
      console.warn(`[ash] 后台任务收尾记账失败（session=${this.cliSessionId}）:`, e);
    }
  }
}

/**
 * `local_agent` 是子代理；`local_bash` 除去内置 Monitor 起的就是后台 Bash。别的类型没见过，
 * 不猜。
 */
function kindOf(taskType: unknown, tool: string | undefined): BackgroundKind | null {
  if (taskType === "local_agent") return "agent";
  if (taskType === "local_bash" && tool !== "Monitor") return "bash";
  return null;
}

/**
 * 时间线上那句话。一个都没被收走就不说（返回空串）。
 *
 * 分档照抬内置 Monitor 那句的教训（第 4 轮审查 N1）：自己跑完的和被收走的不能说成同一件
 * 事；结论对所有档一样——通知只注回智能体自己的会话，任务不会被唤醒。
 */
export function backgroundReapedNotice(tally: Partial<Record<BackgroundKind, BackgroundTally>>): string {
  const kinds = (Object.keys(KIND_LABEL) as BackgroundKind[]).filter((k) => tally[k]?.total);
  if (!kinds.some((k) => tally[k]!.reaped > 0)) return "";
  const parts = kinds.map((k) => {
    const { total, finished, stopped, reaped } = tally[k]!;
    if (reaped === total) return `${total} 个${KIND_LABEL[k]}，回合结束时${total > 1 ? "全都" : ""}还在跑`;
    const buckets = [
      finished ? `${finished} 个自己结束了` : "",
      stopped ? `${stopped} 个被它自己停掉` : "",
      reaped ? `${reaped} 个回合结束时还在跑` : "",
    ].filter(Boolean);
    return `${total} 个${KIND_LABEL[k]}（${buckets.join("、")}）`;
  });
  return `本轮智能体起了 ${parts.join("；")}。还在跑的那些已随智能体进程一并收走——`
    + `它们的完成通知只注回智能体自己的会话，从来不会唤醒任务。`
    + `要跨回合等一件事，得用 ash 的哨兵（start_monitor）并用 pause_task 收尾这一轮。`;
}
