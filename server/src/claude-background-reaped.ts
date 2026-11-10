// claude 内置**后台子代理**（Agent）、**后台工作流**（Workflow）与**后台 Bash**（`run_in_background`）
// 随回合收尾被收走时，在任务时间线上如实留一笔。内置 Monitor 那一档见 claude-monitor-reaped.ts，口径照抬。
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
// 内置 Monitor 有 PreToolUse hook 改道成 ash 哨兵兜底，这几种没有（它们不是「等」的工具，
// 拦不得）。2026-11-06 起单飞回合结尾会等后台子代理 / 工作流跑完再收台（`waiting()`，见
// executors/claude.ts 的 `singleRunFromResident`），它们只在等超时、被停止、ash 重启接管这类
// 场合才会被收走；后台 Bash 照旧不等，事前在每回合提醒里说一句（run-prompts.ts 的
// `BACKGROUND_WAIT_WARNING`）。事后一律在这里如实记账。
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
// `CLAUDE_MONITOR_ENDED_REASON`），所以**只按证据归档**，拿不准就说拿不准。证据（终态通知、
// 停止回执）谁先到、到没到齐都不一定，所以账上只存证据、结论每次现算，后到的随时能改判：
//
// - 来源明说是进程退出收走的（孤儿补报那两句原话）→ 被收走，排在一切推断之前。
// - 有一次 TaskStop / KillShell 指名了它、**且回执成功**→ 智能体自己停的（通知早到、晚到、
//   没到都一样）。请求发了、回执还在路上 → 原因不明，回执到了再改判。
//   只发了请求不算：回执带 `is_error`（权限拒绝、目标不存在）就当它没停成，按下面几条定。
//   指名的是**发请求那一刻的那条命**：子代理被 SendMessage 续上后 task_id 不变，旧请求的
//   回执哪怕晚到，也只结算旧的那条命。终态通知只在**还没了结**的命里认：它自带的 `tool_use_id`
//   只说明是哪次调用起的，不说明是哪一条命——续上的那条命沿用最初那次 Agent 调用的
//   `tool_use_id`（2026-11-10 任务 tLDCWCOJ0cuO 实测：两次 task_started、两条完成通知全是同一个
//   id。按它在全部命里取第一条，第二条完成通知就落到早已了结的旧命上，新命永远等不到终态，
//   单飞回合收尾一直「等后台」）。候选不止一条时**不猜**（通知到达的先后不等于结束的先后）：
//   先挂着，等别的证据把范围缩到一条命，或者每条命都等到了通知；分档取决于是哪条命的（停止
//   回执只给了其中一些）那几笔记「原因不明」，不断言是谁被收走。
// - 没人请求停它、通知落在回合 `result` 之后、下一段助手输出之前 → 被收走：那个空档里
//   唯一在动的是 CLI 收台（内置 Monitor 那边实测的行序）。
// - 流结束时还没有终态、也没人请求停它 → 被收走（进程都没了）。
// - 其余（回合进行中停了，又没有任何人请求过）→ **原因不明**，照样记进时间线，不丢。
//
// 常驻进程（团队调度台）里后台任务跨回合活着、在空档里 `completed` 也是真跑完，照常算；
// 下一回合一开始，上一回合已经了结的那些先把该说的写进时间线、再清出账本，不会因为清账把
// 还没说出去的那一笔丢掉。时间线那句话说的是「这次智能体进程里起的」：跨回合活着的旧任务
// 也在数里，说成「本轮」就错了。
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

export type BackgroundKind = "agent" | "workflow" | "bash";

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

/** 终态通知里分档要用的事实。 */
interface Note {
  stopped: boolean;
  /** 来源明说是进程退出收走的。 */
  sessionEnded: boolean;
  /** 落在回合 `result` 之后。 */
  idle: boolean;
}

/**
 * 一条命。只存证据，不存结论：停止回执和终态通知谁先到、到没到齐都不一定，结论每次按手上
 * 全部证据现算（`verdict`），后到的证据随时能改判。
 */
interface Tracked {
  taskId: string;
  kind: BackgroundKind;
  /** 发起这一条命的那次调用——同一个 task_id 被续上时，靠它分清是哪一条命的事件。 */
  toolUseId: string;
  /** 发起它的那次调用已经返回、而它当时还没结束。 */
  background: boolean;
  /** 它的终态通知。没有 = 还没等到。 */
  note?: Note;
  /** 整组一起落地时：这条通知其实是这几条命里不知哪一条的（见 `absorb`）。 */
  peers?: Tracked[];
  /** 有一次指名这条命的停止调用回执成功了。 */
  stopOk?: boolean;
}

const KIND_LABEL: Record<BackgroundKind, string> = { agent: "后台子代理", workflow: "后台工作流", bash: "后台 Bash" };

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
  /** 认不出是哪条命、先挂着的终态通知，按通知自报的身份（task_id + 可选的 tool_use_id）归堆。 */
  private loose = new Map<string, { taskId: string; toolUseId: string; notes: Note[] }>();
  /** 回合 `result` 之后、下一段助手输出之前（见文件头「是谁停的」）。 */
  private idle = false;
  /** 时间线写入串成一条链：回合边界那次和流结束那次不能乱序，`finish` 要等它写完。 */
  private writes: Promise<void> = Promise.resolve();
  private cliSessionId: string;
  /** 重放已消费的那段输出时只重建账本：那几笔该说的上一个 ash 进程说过了（见 executors/claude-recovery.ts）。 */
  quiet = false;

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
      .filter((task): task is Tracked => !!task);
    if (targets.length) this.stopCalls.set(toolUseId, targets);
  }

  /** `isError` 是 tool_result 块上的 `is_error`：停止调用被拒（权限、目标不存在）就是它。 */
  toolResult(toolUseId: unknown, isError = false): void {
    if (typeof toolUseId !== "string" || !toolUseId) return;
    this.returned.add(toolUseId);
    for (const task of this.runs()) {
      if (task.toolUseId === toolUseId && !task.note && !task.stopOk) task.background = true;
    }
    const targets = this.stopCalls.get(toolUseId);
    if (!targets) return;
    this.stopCalls.delete(toolUseId);
    if (!isError) for (const task of targets) task.stopOk = true;
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
      this.tasks.set(taskId, {
        taskId, kind, toolUseId, background: !!toolUseId && this.returned.has(toolUseId),
      });
      return;
    }
    if (ev.subtype !== "task_notification") return;
    const status = claudeMonitorStatus(ev.status);
    if (status === "running") return;
    const note: Note = {
      stopped: status === "stopped", sessionEnded: SESSION_ENDED_RE.test(String(ev.summary ?? "")), idle: this.idle,
    };
    // 只在还没了结的命里认（见文件头「是谁停的」）：带着 `tool_use_id` 就缩到那次调用起的命，
    // 账上没有哪条命出自那次调用的（id 口径对不上）按没带算。剩一条就是它，不止一条先挂着。
    const raw = typeof ev.tool_use_id === "string" ? ev.tool_use_id : "";
    const toolUseId = raw && this.runs().some((t) => t.taskId === taskId && t.toolUseId === raw) ? raw : "";
    const open = this.open(taskId, toolUseId);
    const key = `${taskId}\n${toolUseId}`;
    if (open.length > 1) {
      const pile = this.loose.get(key) ?? { taskId, toolUseId, notes: [] as Note[] };
      pile.notes.push(note);
      this.loose.set(key, pile);
    } else if (open.length === 1) {
      open[0].note = note;
    }
    this.absorb(key);
  }

  /** 挂着的通知能落地了就落：范围缩到一条命，或者每条命都等到了通知。 */
  private absorb(key: string): void {
    const pile = this.loose.get(key);
    if (!pile) return;
    const { notes } = pile;
    const open = this.open(pile.taskId, pile.toolUseId);
    if (open.length > 1 && notes.length < open.length) return;
    if (open.length === 1) open[0].note = notes[0];
    else open.forEach((task, i) => { task.note = notes[i]; task.peers = open; });
    this.loose.delete(key);
  }

  /**
   * 一条终态（`note` 缺省 = 没等到通知）落在 `group` 这几条命里的某一条上，该算哪一档。证据
   * 从硬到软：完成 > 来源明说收走 > 停止回执成功 > 「没人请求，result 之后停的 / 没等到」算
   * 收走 > 不明。group 不止一条（认不出是谁）时，按哪条都一样的才下结论：停止回执全都成功
   * 或全都没有；混着的，或者有停止请求的回执还在路上，记「原因不明」。
   */
  private verdict(note: Note | undefined, group: Tracked[]): Outcome {
    if (note && !note.stopped) return "finished";
    if (note?.sessionEnded) return "reaped";
    if (group.every((task) => task.stopOk)) return "stopped";
    if (group.some((task) => task.stopOk || this.asked(task))) return "unknown";
    return !note || note.idle ? "reaped" : "unknown";
  }

  private outcomeOf(task: Tracked): Outcome {
    return this.verdict(task.note, task.peers ?? [task]);
  }

  /** 有指名它的停止调用还没回执。 */
  private asked(task: Tracked): boolean {
    for (const targets of this.stopCalls.values()) if (targets.includes(task)) return true;
    return false;
  }

  /** 还没等到终态的那几条命；`toolUseId` 非空就只要那次调用起的。 */
  private open(taskId: string, toolUseId = ""): Tracked[] {
    return this.runs().filter((task) => task.taskId === taskId && !task.note && (!toolUseId || task.toolUseId === toolUseId));
  }

  /**
   * 新回合开始（只有常驻进程走得到）：先把上一回合**已了结**那些该说的说出去，再清出账本；
   * 还在跑的留着，它们仍可能在本代进程里被收走。「已了结」= 等到了终态通知、且没有停止回执
   * 还在路上（回执随时能改判，清出去就改不了了）；只有停止回执、没等到通知的也留着，迟到的
   * 无身份通知还得靠它把范围缩到正确的那条命。清账前不结算，常驻调度台上「原因不明」的
   * 那一笔就再也没有投递入口了（流的 finally 要等到进程退出）。
   *
   * 调用索引同时回收已经配对完的那些（有回执、也不是还活着的后台任务的发起调用），否则随常驻
   * 进程的全程调用量无界增长。**没回执的一个不动**：跨回合活着的子代理还在发调用，主回合
   * 开始不等于它们配对完了——清掉了，内置 Monitor 的 `local_bash` 就会被认成普通后台 Bash。
   */
  private nextTurn(): void {
    this.idle = false;
    const settled = new Set(this.runs()
      .filter((task) => task.note && !(task.peers ?? [task]).some((peer) => this.asked(peer))));
    this.report(backgroundReapedNotice(tallyOf([...settled].map((task) => [task, this.outcomeOf(task)]))));
    this.earlier = this.earlier.filter((task) => !settled.has(task));
    for (const [id, task] of this.tasks) if (settled.has(task)) this.tasks.delete(id);
    const live = new Set(this.runs().map((task) => task.toolUseId));
    for (const id of this.returned) {
      if (live.has(id)) continue;
      this.returned.delete(id);
      this.tools.delete(id);
    }
  }

  private runs(): Tracked[] {
    return [...this.earlier, ...this.tasks.values()];
  }

  /**
   * 此刻还没了结的后台子代理 / 后台工作流各有几个。单飞回合收尾时据此决定**先不收台**
   * （见 executors/claude.ts 的 `singleRunFromResident`）：它们是有终点的活，跑完 CLI 会拿完成
   * 通知自己开下一回合 —— `claude -p` 自己就是这么等的（2026-11-06 实测）。后台 Bash 不算：
   * 开发服务器一类压根不会自己结束，为它留着进程就是无限期挂住。
   */
  waiting(): { agent: number; workflow: number } {
    const open = this.runs().filter((task) => task.background && !task.note && !task.stopOk);
    return {
      agent: open.filter((task) => task.kind === "agent").length,
      workflow: open.filter((task) => task.kind === "workflow").length,
    };
  }

  /**
   * 后台任务分档。只数真正活过发起调用的那些。还挂着的通知不落到哪一条命上，整组按「认不出
   * 是谁」算：等到的那几条按各自的通知，没等到的那几条按「没等到」。
   */
  tally(): Partial<Record<BackgroundKind, BackgroundTally>> {
    const outcomes = new Map(this.runs().map((task) => [task, this.outcomeOf(task)] as const));
    for (const { taskId, toolUseId, notes } of this.loose.values()) {
      const open = this.open(taskId, toolUseId);
      open.forEach((task, i) => outcomes.set(task, this.verdict(notes[i], open)));
    }
    return tallyOf(outcomes);
  }

  /**
   * 流结束那一刻调用（`executors/claude-stream.ts` 的 finally）。有被收走或停因不明的才记一条；
   * 全都在回合里正常结束的，是后台命令的正当用法，不去打扰。不抛；尽力而为（见文件头）。
   */
  async finish(): Promise<void> {
    this.report(backgroundReapedNotice(this.tally()));
    this.tasks.clear();
    this.earlier = [];
    this.loose.clear();
    await this.writes;
  }

  private report(notice: string): void {
    if (!notice || this.quiet) return;
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

function tallyOf(list: Iterable<readonly [Tracked, Outcome]>): Partial<Record<BackgroundKind, BackgroundTally>> {
  const out: Partial<Record<BackgroundKind, BackgroundTally>> = {};
  for (const [task, outcome] of list) {
    if (!task.background) continue;
    const entry = out[task.kind] ??= { total: 0, finished: 0, stopped: 0, reaped: 0, unknown: 0 };
    entry.total += 1;
    entry[outcome] += 1;
  }
  return out;
}

/**
 * `local_agent` 是子代理；`local_workflow` 是 Workflow 工具起的整个工作流（里面的子智能体
 * 共用这一个 task_id，不单独起 task）；`local_bash` 除去内置 Monitor 起的就是后台 Bash。
 * 别的类型没见过，不猜。
 */
function kindOf(taskType: unknown, tool: string | undefined): BackgroundKind | null {
  if (taskType === "local_agent") return "agent";
  if (taskType === "local_workflow") return "workflow";
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
  return `这次智能体进程里起了 ${parts.join("；")}。`
    + (reaped ? "还在跑的那些已随智能体进程一并收走——" : "")
    + `它们的完成通知只注回智能体自己的会话，从来不会唤醒任务。`
    + `要跨回合等一件事，得用 ash 的哨兵（start_monitor）并用 pause_task 收尾这一轮。`;
}
