// claude CLI 内置 `Monitor` 工具的**只读投影**：把它认出来，记进 `monitors` 表。
//
// ── 为什么要有这份东西 ──────────────────────────────────────────────────────
//
// 「哨兵」这个词在 ash 里有两个所指，而用户看不出区别：
//
// - ash 的哨兵（MCP `start_monitor`）：进程由 ash server 起，全功能。
// - claude 自带的 `Monitor` 工具：进程在 agent 自己的进程树里，ash 原本一无所知。
//
// claude 的提示词会主动把长等待引导到它自己那个 `Monitor` 上（Bash 里的长 `sleep` 直接
// 被拦，拦截文案就写着「use Monitor with an until-loop」），所以 claude 执行器几乎必然
// 用内置的那个。2026-10-14 实测的任务挂了 12 个内置 Monitor、ash 一个都没记上，面板上
// 写着「这个任务上还没有哨兵」——而 agent 在对话里反复说「等 Monitor 通知」。用户对不上
// 账，只能得出「这功能坏了」。
//
// 所以这里把它认出来、记一笔。**只读**：停不掉（`TaskStop` 是 claude 进程内的工具）、
// 没有日志文件（输出进了 agent 自己的会话）、agent 进程一死它就跟着没。能力边界写在
// shared/src/monitor.ts 的文件头，界面必须如实说明，否则这份投影就从「对上账」变成了
// 新的误导。
//
// ── 认人的那条链 ────────────────────────────────────────────────────────────
//
// claude 的 stream-json 里，后台任务的生命周期是结构化事件（不用去正则匹配工具回执文本）：
//
//   system/task_started     { task_id, tool_use_id, description, task_type: "local_bash" }
//   system/task_notification{ task_id, tool_use_id, status, summary }
//   system/task_updated     { task_id, patch }
//
// 但 `local_bash` 既包含内置 Monitor，也包含普通的后台 Bash（`run_in_background`）——
// 实测那个任务里 76 条 task_started，只有 12 条来自 Monitor，另外 64 条是普通后台 Bash。
// 区分唯一可靠的办法是 `tool_use_id` 回指到发起它的那个 tool_use 块的**工具名**。
// 所以这里要先攒 `tool_use_id → Monitor 的入参`，`task_started` 到了才认得出来。
//
// 按 `description` 之类的内容去猜一律不行：两种后台任务的 description 长得一模一样。
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import {
  claudeMonitorStatus, CLAUDE_MONITOR_ENDED_REASON, monitorStatusCorrectable,
  parseMonitorStartReceipt, type MonitorLifetime,
} from "@ash/shared/monitor";
import { bus } from "./bus.js";
import { createLivenessProbe } from "./claude-monitor-liveness.js";
import { db, dbClient } from "./db/index.js";
import { monitors, sessions } from "./db/schema.js";
import { id, now } from "./util.js";

/** 一个内置 Monitor 的入参，从它的 tool_use 块上摘下来。 */
export type MonitorCall = { command: string; description: string };

export const monitorStr = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const str = monitorStr;

/**
 * 从 `Monitor` 工具的入参里取命令与说明。
 *
 * `ws` 那种（WebSocket 源）没有 `command`，用 url 顶上去——否则面板上会出现一张命令为空
 * 的卡，而「它在盯什么」正是这张卡唯一要回答的问题。
 */
export function parseMonitorInput(input: unknown): MonitorCall | null {
  let parsed: unknown = input;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const fields = parsed as Record<string, unknown>;
  const ws = fields.ws && typeof fields.ws === "object" ? fields.ws as Record<string, unknown> : null;
  const command = str(fields.command) || (ws ? `ws: ${str(ws.url)}` : "");
  if (!command) return null;
  const description = str(fields.description) || command;
  // **入参里的 `timeout_ms` 一律不取**。那是「我们请求了多久」，不是「来源给了多久」：
  // claude 自己会钳（实测本机 2.1.283 的归一化函数有 30 分钟和 10 分钟两个分支），还有
  // 不设会话内超时的 persistent 模式。生效期限只认起手回执里那句 `expires in …`，它在
  // `task_started` **之后**才到，所以投影先落 `unknown`，拿到回执再升级（见 toolResult）。
  return { command, description };
}

/**
 * cli 会话 id → ash 的任务 id、工作目录，以及**当代** agent 进程身份。
 *
 * 带上 pid 是因为 `sessions` 那两列每回合都被下一轮覆盖：投影必须在落库那一刻把「起它的
 * 是哪一代」抄下来，事后再问 `sessions` 问到的已经是别人了（见 monitors.source_pid 的说明）。
 */
async function locateSession(cliSessionId: string): Promise<
  { taskId: string; cwd: string; pid: number | null; pidStartedAt: string | null } | null
> {
  if (!cliSessionId || dbClient.closed) return null;
  const row = (await db
    .select({
      taskId: sessions.taskId, cwd: sessions.cwd,
      pid: sessions.agentPid, pidStartedAt: sessions.agentStartedAt,
    })
    .from(sessions)
    .where(eq(sessions.cliSessionId, cliSessionId))).at(0);
  return row
    ? { taskId: row.taskId, cwd: row.cwd ?? "", pid: row.pid ?? null, pidStartedAt: row.pidStartedAt ?? null }
    : null;
}

/**
 * 一条 claude 会话上的内置 Monitor 账本。**每个 stream 一个实例**（`tool_use_id` 只在
 * 一条会话内唯一）。
 *
 * 写库一律 fire-and-forget 并吞掉异常：这是一份旁路投影，记账失败绝不能把 agent 的事件
 * 流带崩——那会让一个本来好好的回合因为「界面上少显示一张卡」而整个失败。
 */
export class ClaudeMonitorTrace {
  /** tool_use_id → 那次 Monitor 调用的入参。等它的 task_started 来认领。 */
  private pending = new Map<string, MonitorCall>();
  /**
   * 认领过的 claude 后台任务 id。**同步**记，`task_started` 一到就进来。
   *
   * 不能拿下面那个 `rows` 当准入判据：它是在 `open()` 里落库之后才写的，而 `open()` 排在
   * 队列里跑。命令瞬间结束时（`until` 的条件一上来就满足），`task_notification` 紧跟着
   * `task_started` 到达，那一刻 `rows` 还是空的 → 终态被当成「不是我的」丢掉 → 这条投影
   * 一直挂着 running，最后被 `finishAll` 收成 lost。接线回归实测到的就是这个（期望
   * exited，实际 lost）。
   */
  private claimed = new Set<string>();
  /**
   * 查过库、确认**不是**本任务投影的后台任务 id（普通后台 Bash 之类）。
   *
   * `claimed` 只是快路径：命中就处理，**不命中不能直接丢**——回填可能刚刚往库里补了一行
   * （GET 触发，不经过这个实例），或者上一轮留下的行这一轮还没认回来。原来不命中就 return，
   * 于是「先认领空名单、后回填插入、再来真 completed」这条顺序下通知被丢光，EOF 最后把它
   * 收成 lost 而不是来源报的 exited（第 4 轮审查实测 lateBackfill）。
   *
   * 改成不命中时查一次库裁决。这一列记住「查过且确实不是我们的」，所以每个 id 最多查一次
   * ——实测一个长任务里 76 条 task_started 有 64 条是普通后台 Bash，不能每条都查。
   */
  private foreign = new Set<string>();
  /** claude 的后台任务 id → ash 这边那一行的主键。只在队列里读写。 */
  private rows = new Map<string, string>();
  /**
   * tool_use_id → claude 的后台任务 id。
   *
   * 起手回执（`Monitor started (… expires in 20m …)`）是一条 **tool_result**，只带
   * `tool_use_id`；而投影是按后台任务 id 记的。实测到达顺序是
   * tool_use → task_started → tool_result，所以 `task_started` 到的时候把这对关系记下来，
   * 回执到了才找得到该更新哪一行。
   */
  private byToolUse = new Map<string, string>();
  /** 串行化写库：同一个后台任务的 started/notification 可能紧挨着到。 */
  private chain: Promise<unknown> = Promise.resolve();
  private cliSessionId = "";
  /**
   * 本会话遗留的投影有没有认回来。
   *
   * **agent 进程活得过 ash 重启**（detached），重启后 `reattachRunningTasks` 把它接回来、
   * 新建一个 parser，于是也新建一个本类的实例——而上一轮认领的那些投影只存在于上一个进程
   * 的内存里。不认回来的话，来源侧后续的 `task_notification` 会因为「没认领过」被直接丢掉，
   * 卡片永远停在旧状态；开机清扫再把它们当成死的标掉，用户看到的是「任务还在跑、哨兵说
   * 进程已不在」（第 1 轮审查用真实 detached 接管复现）。
   *
   * 三态：null = 还没开始；Promise = 正在认；"done" = 认完了，此后 `claimed` 就是权威。
   */
  private reclaim: Promise<void> | "done" | null = null;

  /**
   * @param cliSessionId 这条流属于哪条 CLI 会话。**接管路径必须传**：真实接管是从已消费的
   * offset 之后接着读的，`init` 早在上一轮就消费掉了，不会再来一次。靠「等下一条 system
   * 事件来设身份」会一直等不到，于是认领不发生、`finishAll` 收不到那些行，进程结束后卡片
   * 永远停在 running（第 2 轮审查用真实 detached 接管复现；我上一轮的回归每次都重发 init，
   * 恰好把这条路盖住了）。
   */
  constructor(cliSessionId?: string) {
    if (cliSessionId) {
      this.cliSessionId = cliSessionId;
      this.startReclaim();
    }
  }

  private queue(job: () => Promise<void>): void {
    this.chain = this.chain.then(job, job).catch((e) => this.warn("记账失败", e));
  }

  /**
   * 旁路诊断。**限频**（同一条会话最多报 3 次）：这是一份投影，坏了不该把 agent 的事件流
   * 刷屏，但也不能像原来那样整段吞掉——磁盘满、权限、会话映射不上的时候，用户只看到一个
   * 空面板，日志里一个字都没有，没法查。带上会话身份才找得到是谁。
   */
  private warned = 0;
  private warn(what: string, detail: unknown): void {
    if (this.warned >= 3) return;
    this.warned += 1;
    console.warn(`[ash] 内置 Monitor 投影${what}（session=${this.cliSessionId || "未知"}）:`, detail);
  }

  /** 每个 tool_use 块都喂进来；只有 `Monitor` 会被记下。 */
  toolUse(name: unknown, input: unknown, toolUseId: unknown): void {
    if (str(name) !== "Monitor") return;
    const callId = str(toolUseId);
    const call = parseMonitorInput(input);
    if (!callId || !call) return;
    this.pending.set(callId, call);
  }

  /**
   * 起手回执（tool_result）。**来源侧唯一说出生效期限的地方**。
   *
   * 为什么不用 `Monitor` 入参里的 `timeout_ms`：那是请求值。claude 自己会钳（本机
   * 2.1.283 的归一化函数实测有 30 分钟 / 10 分钟两个分支），还有不设会话内超时的
   * persistent 模式。拿请求值当生效值，卡片上那句「盯到 X」在被钳的会话里就是编的
   * （第 2 轮审查实测：请求 1 小时、bounded 分支实际只给 30 或 10 分钟）。
   */
  toolResult(toolUseId: unknown, content: unknown): void {
    const callId = str(toolUseId);
    const nativeId = callId ? this.byToolUse.get(callId) : undefined;
    if (!nativeId) return;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((b: any) => (b && typeof b === "object" && typeof b.text === "string" ? b.text : "")).join("\n")
        : "";
    if (!text) return;
    const receipt = parseMonitorStartReceipt(text);
    if (receipt.lifetime === "unknown") return; // 认不出来就保持「未知」，别编一个
    this.byToolUse.delete(callId);
    this.queue(() => this.applyReceipt(nativeId, receipt.lifetime, receipt.ms));
  }

  /** 每条 stream-json 事件都喂进来。 */
  event(ev: any): void {
    if (!ev || ev.type !== "system") return;
    if (ev.session_id && !this.cliSessionId) this.cliSessionId = str(ev.session_id);
    // 每条 system 事件都试一次：构造时没给身份的要在这里补上，上一次认领失败的要在这里重试
    // （`startReclaim` 自身幂等，已完成或正在跑时直接返回）。
    if (this.cliSessionId) this.startReclaim();
    const taskId = str(ev.task_id);
    switch (ev.subtype) {
      case "task_started": {
        // 只认 Monitor 起的。普通后台 Bash（`run_in_background`）同样是 local_bash，
        // 把它们一起记进来会让哨兵面板变成一份「这个任务跑过的所有后台命令」流水账
        // ——实测 76 条里有 64 条是它们。
        const call = this.pending.get(str(ev.tool_use_id));
        if (!call || !taskId) return;
        this.pending.delete(str(ev.tool_use_id));
        if (str(ev.tool_use_id)) this.byToolUse.set(str(ev.tool_use_id), taskId);
        // 同步认领，再排队落库：准入与落库之间隔着一个 await，中间到达的终态必须认得出来。
        this.claimed.add(taskId);
        this.queue(() => this.open(taskId, call));
        return;
      }
      case "task_notification": {
        // 只管我们认领过的那些；别的后台任务的通知一概不碰。判据用同步的 `claimed`
        // 而不是 `rows`——理由见 `claimed` 的注释。排进同一条队列，落库顺序天然在 open 之后。
        //
        // **认领还没完成时不能直接丢**：接管回来的那一刻，上一轮的投影还在 DB 里躺着、
        // 还没读进 `claimed`，而来源侧的终态可能正好这时候到。这种情况下乐观排队，由
        // `close` 在队列里查一次库来裁决（认领完成之后 `claimed` 就是权威，不再查）。
        if (!taskId || this.foreign.has(taskId)) return;
        // 不在 `claimed` 里也要排队：权威是库，不是这一个实例的内存名单（见 `foreign`）。
        // `close` 里的 `locateRow` 查不到就把它记进 `foreign`，下次直接短路。
        this.queue(() => this.close(taskId, claudeMonitorStatus(ev.status), str(ev.summary)));
        return;
      }
      default:
    }
  }

  /**
   * 把本会话上一轮留下的、还挂着 `running` 的投影认回来。
   *
   * 排进同一条队列的队首，所以它一定跑在后续 open/close 之前；`claimed` 在它跑完之后才
   * 成为权威判据（见 `reclaim` 与 task_notification 分支的说明）。
   */
  private startReclaim(): void {
    if (this.reclaim !== null) return;
    const cliSessionId = this.cliSessionId;
    const job = (async () => {
      if (dbClient.closed || !cliSessionId) return;
      // **`lost` 也要认回来。** 那是 ash 推断的死亡，可能判错了（agent 活得过 ash 重启），
      // 来源侧后续照常报完成。只认 running 的话，这些行连 `close` 都到不了，而 `close` 里
      // 那条「lost 让位于来源事实」的规则就永远用不上（第 4 轮审查实测 lostReclaim）。
      const rows = await db
        .select({ id: monitors.id, nativeId: monitors.nativeId })
        .from(monitors)
        .where(and(
          eq(monitors.kind, "claude"),
          inArray(monitors.status, ["running", "lost"]),
          eq(monitors.cliSessionId, cliSessionId),
          isNotNull(monitors.nativeId),
        ));
      for (const row of rows) {
        if (!row.nativeId) continue;
        this.rows.set(row.nativeId, row.id);
        this.claimed.add(row.nativeId);
      }
    })();
    // 防 unhandled rejection：真正的处理在下面的 queue 里（`await job` 能照常拿到失败），
    // 但 handler 要等队列轮到它才 attach，中间那一拍足够 Node 报一条 unhandled。
    job.catch(() => {});
    this.reclaim = job;
    this.queue(async () => {
      try {
        await job;
        this.reclaim = "done";
      } catch (e) {
        // **认领失败不能变成权威空账本。** 原来这里 catch 掉就标 done，于是一次 SQLITE_BUSY
        // 之后，来源侧后续每一条有效通知都因为「claimed 里没有它」被永久丢弃（第 2 轮审查
        // 注入一次读失败即复现）。留在未完成态：下一条事件会再试一次，期间 close 走查库那
        // 条路自己裁决，一条都不会丢。
        this.reclaim = null;
        this.warn("认领上一轮的投影失败，下一条事件会重试", e);
      }
    });
  }

  /** 按 (taskId, nativeId) 把投影行找出来。内存里没有就查库——接管回来的那些只在库里。 */
  private async locateRow(taskId: string, nativeId: string): Promise<string | null> {
    const cached = this.rows.get(nativeId);
    if (cached) return cached;
    const row = (await db
      .select({ id: monitors.id })
      .from(monitors)
      .where(and(eq(monitors.taskId, taskId), eq(monitors.nativeId, nativeId), eq(monitors.kind, "claude")))).at(0);
    if (row) this.rows.set(nativeId, row.id);
    return row?.id ?? null;
  }

  private async open(nativeId: string, call: MonitorCall): Promise<void> {
    const found = await locateSession(this.cliSessionId);
    if (!found) {
      // 认不出会话就落不了库。安静跳过是对的（不能因此拖垮事件流），但要留下线索——
      // 否则用户看到的是「agent 说挂上了，面板永远空着」，而日志里什么都没有。
      this.warn("找不到对应的 ash 会话，这条没有记上", `native=${nativeId}`);
      return;
    }
    // 同一个 native_id 重复开（流被重放、resume 后 CLI 重发）就不再插一行。唯一索引
    // monitors_native 是最后一道，这里先查一次省掉一次必然失败的插入。
    const existing = (await db
      .select({ id: monitors.id })
      .from(monitors)
      .where(and(eq(monitors.taskId, found.taskId), eq(monitors.nativeId, nativeId)))).at(0);
    if (existing) {
      this.rows.set(nativeId, existing.id);
      return;
    }
    const rowId = id();
    const startedAt = now();
    await db.insert(monitors).values({
      id: rowId,
      taskId: found.taskId,
      command: call.command,
      description: call.description,
      cwd: found.cwd,
      status: "running",
      pid: null,
      pidStartedAt: null,
      // 没有日志文件：它的输出进了 agent 自己的会话。`readMonitorTail` 按 kind 短路，
      // 永远不会拿这个空串去读盘。
      logPath: "",
      offset: 0,
      events: 0,
      exitCode: null,
      startedAt,
      // 占位：此刻还不知道来源给了多久（回执在 task_started 之后才到）。`sourceLifetime`
      // 标着 unknown，`toTaskMonitor` 据此根本不会把这一列吐出去。
      expiresAt: startedAt,
      endedAt: null,
      endedReason: null,
      ownerUserId: null,
      kind: "claude",
      nativeId,
      cliSessionId: this.cliSessionId || null,
      sourceLifetime: "unknown",
      lifetimeEvidence: null, // 回执还没到；拿到了由 applyReceipt 写成 'receipt'
      // 起它的就是当下这一代 agent 进程。抄在行上，之后判死活才不会把下一回合的新进程
      // 当成它（第 4 轮审查实测 reusedSession）。
      sourcePid: found.pid,
      sourcePidStartedAt: found.pidStartedAt,
    });
    this.rows.set(nativeId, rowId);
    bus.publish({ type: "task.monitors", taskId: found.taskId });
  }

  /** 把来源回执落到那一行上：期限从「未知」升级成有限期或持续。 */
  private async applyReceipt(nativeId: string, lifetime: MonitorLifetime, ms: number | null): Promise<void> {
    const found = await locateSession(this.cliSessionId);
    if (!found) return;
    const rowId = await this.locateRow(found.taskId, nativeId);
    if (!rowId) return;
    const row = (await db.select().from(monitors).where(eq(monitors.id, rowId))).at(0);
    if (!row || !monitorStatusCorrectable(row.status)) return;
    await db.update(monitors).set({
      sourceLifetime: lifetime,
      // 期限是**回执**说的，这才是它可信的理由。旧版本推算出来的那些行这一列是 NULL，
      // 迁移据此纠正（见 shared/monitor.ts 的 MONITOR_LIFETIME_EVIDENCE）。
      lifetimeEvidence: "receipt",
      // 有限期才改到期时刻；持续监听没有到期时刻可言，那一列留着当占位。
      // （persistent 的回执本来就不带 ms，所以 `lifetime` 这一半此刻是冗余的——留着是因为
      //  它表达的才是判据本身；真正把假期限挡在对外契约之外的是 toTaskMonitor 那一道。）
      ...(lifetime === "bounded" && ms !== null
        ? { expiresAt: new Date(Date.parse(row.startedAt) + ms).toISOString() }
        : {}),
    }).where(eq(monitors.id, rowId));
    bus.publish({ type: "task.monitors", taskId: row.taskId });
  }

  private async close(nativeId: string, status: string, summary: string): Promise<void> {
    const found = await locateSession(this.cliSessionId);
    if (!found) return;
    const rowId = await this.locateRow(found.taskId, nativeId);
    if (!rowId) {
      // 库里也没有 = 这条后台任务不是 Monitor 起的（普通后台 Bash 占多数）。记下来，
      // 它后续的事件就不必再查库了。
      this.foreign.add(nativeId);
      return;
    }
    const row = (await db.select().from(monitors).where(eq(monitors.id, rowId))).at(0);
    // `lost` 也要让路：那是 ash 推断的，来源侧后到的真终态是事实（见 monitorStatusCorrectable）。
    if (!row || !monitorStatusCorrectable(row.status)) return;
    await db.update(monitors).set({
      status,
      endedAt: now(),
      endedReason: summary || CLAUDE_MONITOR_ENDED_REASON[status as keyof typeof CLAUDE_MONITOR_ENDED_REASON] || null,
    }).where(eq(monitors.id, rowId));
    bus.publish({ type: "task.monitors", taskId: row.taskId });
  }

  /**
   * agent 进程结束了：把这条会话名下还挂着 `running` 的投影全部落 `lost`。
   *
   * 不收这个尾的话，面板上会永远留着几张「正在盯着」的卡，而那些进程早就随 agent 一起
   * 没了——这正是 ash 哨兵当初要解决的问题，不该在投影这一侧原样复刻一遍。
   *
   * 注意这跟 `reattachMonitors` 的分工：那边只认 `kind='ash'`（有 pid 可以验），claude 的
   * 投影没有 pid，唯一可靠的死亡信号就是「它所属的 agent 进程结束了」，也就是这里。
   */
  finishAll(): void {
    this.pending.clear();
    this.claimed.clear();
    this.byToolUse.clear();
    const cliSessionId = this.cliSessionId;
    // **排队之后再查**：还排在队列里的 open/close 都没跑完，提前取会拿到一份残缺名单。
    this.queue(async () => {
      if (dbClient.closed) return;
      this.rows.clear();
      // **按持久归属查，不按内存账本。** 内存里只有本实例亲手认领过的那些；接管回来却
      // 一直没触发认领的行（真实接管不重放 init）永远不在这张名单里，于是进程都结束了
      // 卡片还写着「正在盯着」，要等下一次开机清扫才可能纠正（第 2 轮审查实测）。
      // 会话身份是这条流的持久归属，拿它查才查得全。
      if (!cliSessionId) return;
      const live = await db
        .select({ id: monitors.id, taskId: monitors.taskId })
        .from(monitors)
        .where(and(
          eq(monitors.kind, "claude"),
          eq(monitors.status, "running"),
          eq(monitors.cliSessionId, cliSessionId),
        ));
      if (!live.length) return;
      await db.update(monitors).set({
        status: "lost",
        endedAt: now(),
        endedReason: CLAUDE_MONITOR_ENDED_REASON.lost ?? null,
      }).where(and(inArray(monitors.id, live.map((r) => r.id)), eq(monitors.status, "running")));
      for (const taskId of new Set(live.map((r) => r.taskId))) bus.publish({ type: "task.monitors", taskId });
    });
  }
}

/**
 * 开机收拾上一个 server 留下的 claude 投影 —— **只收来源进程确实已经不在的那些**。
 *
 * 这些行没有 pid，`reattachMonitors` 按 `kind` 把它们整批跳过了（它只认 ash 自己起的
 * 进程），所以必须有人来管；但判据不能是「本进程的账本里没有它」—— **agent 活得过 ash
 * 重启**（detached，见 executors/detached.ts），无条件标 lost 会让用户看到「任务还在输出、
 * 哨兵却说进程已不在」。判据本体和它栽过的三次跟头都在 `claude-monitor-liveness.ts`，
 * 那边是回填与这里共用的唯一一份。
 *
 * 与 `finishAll()` 的分工：那边管「agent 进程正常结束」的常规路径，这边只兜「ash 自己重启
 * 了，得重新判一次谁还活着」。
 */
export async function loseDeadClaudeMonitors(): Promise<{ kept: number; lost: number }> {
  if (dbClient.closed) return { kept: 0, lost: 0 };
  const rows = await db
    .select({
      id: monitors.id,
      taskId: monitors.taskId,
      cliSessionId: monitors.cliSessionId,
      sourcePid: monitors.sourcePid,
      sourcePidStartedAt: monitors.sourcePidStartedAt,
    })
    .from(monitors)
    .where(and(eq(monitors.kind, "claude"), eq(monitors.status, "running")));
  if (!rows.length) return { kept: 0, lost: 0 };

  // 存活判据只有一份，住在 claude-monitor-liveness.ts——回填那边问的是同一个问题
  // （「历史里没读到终态，是早就没了还是现在还在盯着」），两处必须给出同一个答案。
  const probe = createLivenessProbe();

  const dead: { id: string; taskId: string }[] = [];
  let kept = 0;
  for (const row of rows) {
    const live = await probe.sourceAlive(row);
    if (live) kept += 1;
    else dead.push({ id: row.id, taskId: row.taskId });
  }
  if (dead.length) {
    await db.update(monitors).set({
      status: "lost",
      endedAt: now(),
      endedReason: "起它的那个智能体进程已经不在了（ash 重启后确认）",
    }).where(and(
      inArray(monitors.id, dead.map((r) => r.id)),
      eq(monitors.status, "running"),
    ));
    for (const taskId of new Set(dead.map((r) => r.taskId))) bus.publish({ type: "task.monitors", taskId });
  }
  return { kept, lost: dead.length };
}
