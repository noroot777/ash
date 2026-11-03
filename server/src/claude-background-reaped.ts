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
// ── 怎么认「是谁停的」────────────────────────────────────────────────────────
//
// `stopped` 本身不说是谁停的（CLI 那边 TaskStop 和收台共用这个词，见 shared 的
// `CLAUDE_MONITOR_ENDED_REASON`），所以**只按证据归档**，拿不准就说拿不准：
//
// - 来源明说是进程退出收走的（孤儿补报那两句原话）→ 被收走，排在一切推断之前。
// - 有一次 TaskStop / KillShell 指名了它、**且回执成功**→ 智能体自己停的（不管通知早到晚到）。
//   只发了请求不算：回执带 `is_error`（权限拒绝、目标不存在）就当它没停成，按下面几条定。
//   指名的是**发请求那一刻的那条命**：子代理被 SendMessage 续上后 task_id 不变，旧请求的
//   回执哪怕晚到，也只结算旧的那条命。
// - 没人请求停它、通知落在回合 `result` 之后、下一段助手输出之前 → 被收走：那个空档里
//   唯一在动的是 CLI 收台（内置 Monitor 那边实测的行序）。
// - 流结束时还没有终态 → 被收走（进程都没了）。
// - 其余（回合进行中停了，又没有任何人请求过）→ **原因不明**，照样记进时间线，不丢。
//
// 常驻进程（团队调度台）里后台任务跨回合活着、在空档里 `completed` 也是真跑完，照常算；
// 下一回合一开始，上一回合已经了结的那些先把该说的写进时间线、再清出账本，「本轮」不混进
// 旧回合，也不会因为清账把还没说出去的那一笔丢掉。
//
// ── 观测不到的档位（降级）──────────────────────────────────────────────────
//
// - **接管回来的流**（ash 重启后 detached 续读）从已消费位置之后读起，那之前的
//   `task_started` 不会重放 → 那些任务这里看不见，不记账（宁可少说，不编）。
// - **记账是尽力而为**：回合边界 / 流结束时写时间线，失败重试一次，仍失败只留日志 —— 事实只在
//   这个进程的内存里，没有恢复账本（内置 Monitor 那套有，是因为它的投影本来就落库）。
// - **其它执行器**（codex 等）没有这套结构化的后台任务事件，事后这一笔不做；事前那句警告
//   也只发 claude（见 run-prompts.ts 的 `backgroundWaitFor`）。
import { desc, eq } from "drizzle-orm";
import { claudeMonitorStatus } from "@ash/shared/monitor-claude";
import { isTaskRevoked } from "./claude-monitor-revoked.js";
import { db, dbClient } from "./db/index.js";
import { sessions } from "./db/schema.js";
import { appendTaskTimeline } from "./task-timeline.js";

export type BackgroundKind = "agent" | "bash";

/** 一种后台任务这一轮的结局分档。各档互斥，`total` 是它们之和。 */
export interface BackgroundTally {
  total: number;
  /** 自己结束的（completed / failed / 超时）。 */
  finished: number;
  /** 智能体自己停掉的（有指名它的 TaskStop / KillShell 为证）。 */
  stopped: number;
  /** 回合结束时还在跑、随进程一并收走的。 */
  reaped: number;
  /** 回合中途停了，没人请求过、来源也没说为什么。 */
  unknown: number;
}

type Outcome = Exclude<keyof BackgroundTally, "total">;

interface Tracked {
  kind: BackgroundKind;
  toolUseId: string;
  /** 发起它的那次调用已经返回、而它当时还没结束。 */
  background: boolean;
  end: Outcome | null;
  /** 有一次指名这条命的停止调用回执成功了。 */
  stopOk?: boolean;
  /**
   * 停止通知先到、指名它的那次停止调用还没回执时，回执的 tool_use_id。回执成功才改判成
   * 「被它自己停掉」；失败或一直没有回执，就维持按其它证据定的那一档。
   */
  stopCall?: string;
}

const KIND_LABEL: Record<BackgroundKind, string> = { agent: "后台子代理", bash: "后台 Bash" };

/** 能停掉后台任务的工具。入参里指名目标的字段：`task_id`，旧名 `shell_id`。 */
const STOP_TOOLS = new Set(["TaskStop", "KillShell", "KillBash"]);

/**
 * 来源**明说**是进程退出收走的那两句（claude 实测原文：后台 Bash / Monitor 一句，后台子代理
 * 一句）。一般出现在下一代进程里，那时这里已不在账上；同一条流里真见到了也照认，而且排在
 * 一切推断之前。
 */
const SESSION_ENDED_RE = /orphaned by a previous claude code process exit|didn't finish before the previous session ended/i;

/**
 * 一条 claude 会话上的后台任务账本。每个 stream 一个实例，跟 `ClaudeMonitorTrace` 喂同样
 * 三样东西（tool_use、tool_result、system 事件）。账本本身纯内存、同步；落库只在回合边界
 * （常驻进程）和流结束两处。
 */
export class ClaudeBackgroundTrace {
  /** tool_use_id → 工具名。内置 Monitor 起的 `local_bash` 归 claude-monitor-reaped.ts 管。 */
  private tools = new Map<string, string>();
  /** 已经收到 tool_result 的调用。 */
  private returned = new Set<string>();
  /**
   * 还没回执的停止调用：tool_use_id → 发请求那一刻它指名的那几条命（对象本身，不是 task_id，
   * 见文件头「是谁停的」）。**请求不等于停成了。**
   */
  private stopCalls = new Map<string, Tracked[]>();
  /** 当前这一条命。 */
  private tasks = new Map<string, Tracked>();
  /** 同一个 task_id 再起一次之前的那几条命（SendMessage 把停掉的子代理续上）——各算各的。 */
  private earlier: Tracked[] = [];
  /** 回合 `result` 之后、下一段助手输出之前（见文件头「是谁停的」）。 */
  private idle = false;
  /** 时间线写入串成一条链：回合边界那次和流结束那次不能乱序，`finish` 要等它写完。 */
  private writes: Promise<void> = Promise.resolve();
  private cliSessionId: string;

  constructor(cliSessionId?: string) {
    this.cliSessionId = cliSessionId ?? "";
  }

  toolUse(name: unknown, toolUseId: unknown, input?: unknown): void {
    if (typeof name !== "string" || typeof toolUseId !== "string" || !toolUseId) return;
    this.tools.set(toolUseId, name);
    if (!STOP_TOOLS.has(name) || !input || typeof input !== "object") return;
    const { task_id: taskId, shell_id: shellId } = input as Record<string, unknown>;
    const targets = [taskId, shellId]
      .map((id) => typeof id === "string" ? this.tasks.get(id) : undefined)
      .filter((task): task is Tracked => !!task && !task.end);
    if (targets.length) this.stopCalls.set(toolUseId, targets);
  }

  /** `isError` 是 tool_result 块上的 `is_error`：停止调用被拒（权限、目标不存在）就是它。 */
  toolResult(toolUseId: unknown, isError = false): void {
    if (typeof toolUseId !== "string" || !toolUseId) return;
    this.returned.add(toolUseId);
    for (const task of this.tasks.values()) {
      if (task.toolUseId === toolUseId && !task.end) task.background = true;
    }
    const targets = this.stopCalls.get(toolUseId);
    if (!targets) return;
    this.stopCalls.delete(toolUseId);
    for (const task of targets) {
      if (!isError) task.stopOk = true;
      if (task.stopCall !== toolUseId) continue;
      task.stopCall = undefined;
      if (!isError) task.end = "stopped";
    }
  }

  event(ev: any): void {
    if (!ev || typeof ev !== "object") return;
    if (ev.type === "result") { this.idle = true; return; }
    // 只认主智能体的输出：后台子代理自己的 assistant 事件（带 parent_tool_use_id）在空档里
    // 照样会来，那不是「新的一回合开始了」。
    if (ev.type === "assistant") {
      if (!ev.parent_tool_use_id && this.idle) this.nextTurn();
      return;
    }
    if (ev.type !== "system") return;
    if (!this.cliSessionId && typeof ev.session_id === "string") this.cliSessionId = ev.session_id;
    const taskId = typeof ev.task_id === "string" ? ev.task_id : "";
    if (!taskId) return;
    if (ev.subtype === "task_started") {
      const toolUseId = typeof ev.tool_use_id === "string" ? ev.tool_use_id : "";
      const kind = kindOf(ev.task_type, this.tools.get(toolUseId));
      if (!kind) return;
      const prior = this.tasks.get(taskId);
      if (prior) this.earlier.push(prior);
      this.tasks.set(taskId, { kind, toolUseId, background: !!toolUseId && this.returned.has(toolUseId), end: null });
      return;
    }
    if (ev.subtype !== "task_notification") return;
    const task = this.tasks.get(taskId);
    if (!task || task.end) return;
    const status = claudeMonitorStatus(ev.status);
    if (status === "running") return;
    if (status !== "stopped") { task.end = "finished"; return; }
    // 证据从硬到软：来源明说 > 停止调用回执成功 > 「result 之后没人请求」> 不明。
    if (SESSION_ENDED_RE.test(String(ev.summary ?? ""))) { task.end = "reaped"; return; }
    if (task.stopOk) { task.end = "stopped"; return; }
    task.end = this.idle ? "reaped" : "unknown";
    // 停止调用已发、回执还没到：先按上面那档记，回执成功再改判（见 `toolResult`）。
    for (const [callId, targets] of this.stopCalls) if (targets.includes(task)) task.stopCall = callId;
  }

  /**
   * 新回合开始（只有常驻进程走得到）：先把上一回合**已了结**那些该说的说出去，再清出账本；
   * 还在跑的留着，它们仍可能在本代进程里被收走。清账前不结算，常驻调度台上「原因不明」的
   * 那一笔就再也没有投递入口了（流的 finally 要等到进程退出）。
   *
   * 调用索引同时回收已经配对完的那些（有回执、也不是还活着的后台任务的发起调用），否则随常驻
   * 进程的全程调用量无界增长。**没回执的一个不动**：跨回合活着的子代理还在发调用，主回合
   * 开始不等于它们配对完了——清掉了，内置 Monitor 的 `local_bash` 就会被认成普通后台 Bash。
   */
  private nextTurn(): void {
    this.idle = false;
    const settled = [...this.earlier, ...this.tasks.values()].filter((task) => task.end);
    this.report(backgroundReapedNotice(tallyOf(settled)));
    this.earlier = this.earlier.filter((task) => !task.end);
    for (const [id, task] of this.tasks) if (task.end) this.tasks.delete(id);
    const live = new Set([...this.earlier, ...this.tasks.values()].map((task) => task.toolUseId));
    for (const id of this.returned) {
      if (live.has(id)) continue;
      this.returned.delete(id);
      this.tools.delete(id);
    }
  }

  /** 这一轮的后台任务分档。只数真正活过发起调用的那些。 */
  tally(): Partial<Record<BackgroundKind, BackgroundTally>> {
    return tallyOf([...this.earlier, ...this.tasks.values()]);
  }

  /**
   * 流结束那一刻调用（`executors/claude-stream.ts` 的 finally）。有被收走或停因不明的才记一条；
   * 全都在回合里正常结束的，是后台命令的正当用法，不去打扰。不抛；尽力而为（见文件头）。
   */
  async finish(): Promise<void> {
    this.report(backgroundReapedNotice(this.tally()));
    this.tasks.clear();
    this.earlier = [];
    await this.writes;
  }

  private report(notice: string): void {
    if (!notice) return;
    this.writes = this.writes.then(() => this.write(notice));
  }

  private async write(notice: string): Promise<void> {
    if (!this.cliSessionId) return;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (dbClient.closed) return;
      try {
        const home = (await db
          .select({ id: sessions.id, taskId: sessions.taskId })
          .from(sessions)
          .where(eq(sessions.cliSessionId, this.cliSessionId))
          .orderBy(desc(sessions.startedAt))).at(0);
        if (!home || isTaskRevoked(home.taskId)) return;
        if (await appendTaskTimeline(home.taskId, notice, { sessionId: home.id })) return;
      } catch (e) {
        if (attempt === 2) console.warn(`[ash] 后台任务收尾记账失败（session=${this.cliSessionId}）:`, e);
      }
      if (attempt === 1) await new Promise((r) => setTimeout(r, 200));
    }
    console.warn(`[ash] 后台任务收尾记账没写进时间线（session=${this.cliSessionId}），这条说明丢了`);
  }
}

function tallyOf(list: Iterable<Tracked>): Partial<Record<BackgroundKind, BackgroundTally>> {
  const out: Partial<Record<BackgroundKind, BackgroundTally>> = {};
  for (const task of list) {
    if (!task.background) continue;
    const entry = out[task.kind] ??= { total: 0, finished: 0, stopped: 0, reaped: 0, unknown: 0 };
    entry.total += 1;
    entry[task.end ?? "reaped"] += 1;
  }
  return out;
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
 * 时间线上那句话。没有被收走、也没有停因不明的，就不说（返回空串）。
 *
 * 分档照抬内置 Monitor 那句的教训（第 4 轮审查 N1）：自己跑完的、智能体停掉的、被收走的、
 * 说不清的，各说各的；结论对所有档一样——通知只注回智能体自己的会话，任务不会被唤醒。
 */
export function backgroundReapedNotice(tally: Partial<Record<BackgroundKind, BackgroundTally>>): string {
  const kinds = (Object.keys(KIND_LABEL) as BackgroundKind[]).filter((k) => tally[k]?.total);
  const reaped = kinds.some((k) => tally[k]!.reaped > 0);
  if (!reaped && !kinds.some((k) => tally[k]!.unknown > 0)) return "";
  const parts = kinds.map((k) => {
    const { total, finished, stopped, reaped: gone, unknown } = tally[k]!;
    if (gone === total) return `${total} 个${KIND_LABEL[k]}，回合结束时${total > 1 ? "全都" : ""}还在跑`;
    const buckets = [
      finished ? `${finished} 个自己结束了` : "",
      stopped ? `${stopped} 个被它自己停掉` : "",
      unknown ? `${unknown} 个中途停了、原因不明` : "",
      gone ? `${gone} 个回合结束时还在跑` : "",
    ].filter(Boolean);
    return `${total} 个${KIND_LABEL[k]}（${buckets.join("、")}）`;
  });
  return `本轮智能体起了 ${parts.join("；")}。`
    + (reaped ? "还在跑的那些已随智能体进程一并收走——" : "")
    + `它们的完成通知只注回智能体自己的会话，从来不会唤醒任务。`
    + `要跨回合等一件事，得用 ash 的哨兵（start_monitor）并用 pause_task 收尾这一轮。`;
}
