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
  claudeMonitorStatus, CLAUDE_MONITOR_ENDED_REASON, MONITOR_DEFAULT_TIMEOUT_MS, sourceMonitorTimeout,
} from "@ash/shared/monitor";
import { bus } from "./bus.js";
import { db, dbClient } from "./db/index.js";
import { monitors, sessions } from "./db/schema.js";
import { isSameProcess } from "./proc.js";
import { id, now } from "./util.js";

/** 一个内置 Monitor 的入参，从它的 tool_use 块上摘下来。 */
type MonitorCall = { command: string; description: string; timeoutMs: number; timeoutReported: boolean };

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/**
 * 从 `Monitor` 工具的入参里取命令与说明。
 *
 * `ws` 那种（WebSocket 源）没有 `command`，用 url 顶上去——否则面板上会出现一张命令为空
 * 的卡，而「它在盯什么」正是这张卡唯一要回答的问题。
 */
function parseMonitorInput(input: unknown): MonitorCall | null {
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
  // **用来源侧报的原值**，不要套 ash 的创建区间（`normalizeMonitorTimeout`）。那一个是
  // 「ash 自己起哨兵允许多久」的策略，这里要转述的是「claude 说它要盯多久」的事实；拿策略
  // 去钳事实，卡片上就会出现一个与来源不符的到期时刻（claude 盯 5 秒、ash 写成 60 秒后）。
  // 来源没报就退回缺省，并记下来——那是「我们不知道」，不是「它就是这么久」。
  const reported = sourceMonitorTimeout(fields.timeout_ms);
  return { command, description, timeoutMs: reported ?? MONITOR_DEFAULT_TIMEOUT_MS, timeoutReported: reported !== null };
}

/** cli 会话 id → ash 的任务 id + 工作目录。 */
async function locateSession(cliSessionId: string): Promise<{ taskId: string; cwd: string } | null> {
  if (!cliSessionId || dbClient.closed) return null;
  const row = (await db
    .select({ taskId: sessions.taskId, cwd: sessions.cwd })
    .from(sessions)
    .where(eq(sessions.cliSessionId, cliSessionId))).at(0);
  return row ? { taskId: row.taskId, cwd: row.cwd ?? "" } : null;
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
  /** claude 的后台任务 id → ash 这边那一行的主键。只在队列里读写。 */
  private rows = new Map<string, string>();
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

  /** 每条 stream-json 事件都喂进来。 */
  event(ev: any): void {
    if (!ev || ev.type !== "system") return;
    if (ev.session_id && !this.cliSessionId) {
      this.cliSessionId = str(ev.session_id);
      this.startReclaim();
    }
    const taskId = str(ev.task_id);
    switch (ev.subtype) {
      case "task_started": {
        // 只认 Monitor 起的。普通后台 Bash（`run_in_background`）同样是 local_bash，
        // 把它们一起记进来会让哨兵面板变成一份「这个任务跑过的所有后台命令」流水账
        // ——实测 76 条里有 64 条是它们。
        const call = this.pending.get(str(ev.tool_use_id));
        if (!call || !taskId) return;
        this.pending.delete(str(ev.tool_use_id));
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
        if (!taskId) return;
        if (this.reclaim === "done" && !this.claimed.has(taskId)) return;
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
      const rows = await db
        .select({ id: monitors.id, nativeId: monitors.nativeId })
        .from(monitors)
        .where(and(
          eq(monitors.kind, "claude"),
          eq(monitors.status, "running"),
          eq(monitors.cliSessionId, cliSessionId),
          isNotNull(monitors.nativeId),
        ));
      for (const row of rows) {
        if (!row.nativeId) continue;
        this.rows.set(row.nativeId, row.id);
        this.claimed.add(row.nativeId);
      }
    })().catch(() => {});
    this.reclaim = job;
    this.queue(async () => {
      await job;
      this.reclaim = "done";
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
      expiresAt: new Date(Date.parse(startedAt) + call.timeoutMs).toISOString(),
      endedAt: null,
      endedReason: null,
      ownerUserId: null,
      kind: "claude",
      nativeId,
      cliSessionId: this.cliSessionId || null,
    });
    this.rows.set(nativeId, rowId);
    bus.publish({ type: "task.monitors", taskId: found.taskId });
  }

  private async close(nativeId: string, status: string, summary: string): Promise<void> {
    const found = await locateSession(this.cliSessionId);
    if (!found) return;
    const rowId = await this.locateRow(found.taskId, nativeId);
    if (!rowId) return;
    const row = (await db.select().from(monitors).where(eq(monitors.id, rowId))).at(0);
    if (!row || row.status !== "running") return;
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
    // **排队之后再取 `rows`**：同步取的话，还排在队列里的 open/close 都没跑完，取到的是
    // 一份残缺名单——刚起的那几条投影会被漏在 running 上，成了永远不会收尾的僵尸卡。
    this.queue(async () => {
      if (dbClient.closed) return;
      const ids = [...this.rows.values()];
      this.rows.clear();
      if (!ids.length) return;
      const live = await db
        .select({ id: monitors.id, taskId: monitors.taskId })
        .from(monitors)
        .where(and(inArray(monitors.id, ids), eq(monitors.status, "running")));
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
 * 进程），所以必须有人来管；但判据不能是「本进程的账本里没有它」。
 *
 * **agent 活得过 ash 重启**（detached，见 executors/detached.ts）：ash 起来之后
 * `reattachRunningTasks` 把它接回来，任务继续跑、Monitor 继续盯。无条件把 running 的投影
 * 标成 lost，用户看到的就是「任务还在输出、哨兵却说进程已不在」，而且来源侧后来真的报完成
 * 时也不会改回来——第 1 轮审查用真实 detached 接管 + 真实子进程复现了这一幕。
 *
 * 所以判据改成**来源进程的死活**，与 ash 哨兵那边同构（那边比 pid + 启动时刻，这边比它
 * 所属会话的 agent 进程）：
 * - 会话还在、agent 进程还是当初那个 → 留着 running，让接回来的 trace 继续认领它
 *   （`ClaudeMonitorTrace` 建起来就会 reclaim，见那边的说明）。
 * - 会话没了、或 agent 进程确实不在（pid 对不上、或压根没记 pid）→ 落 lost。
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
    })
    .from(monitors)
    .where(and(eq(monitors.kind, "claude"), eq(monitors.status, "running")));
  if (!rows.length) return { kept: 0, lost: 0 };

  // 会话的 agent 进程还在不在。一条会话上可能挂着好几个投影，查一次就够。
  const alive = new Map<string, boolean>();
  const sessionAlive = async (cliSessionId: string | null): Promise<boolean> => {
    // 没记来源会话的（这一列上线之前落的存量行）无从判断死活。当成「已不在」是诚实的：
    // 没有凭据就认不回来，留着 running 只会是一张永远不会再更新的卡。
    if (!cliSessionId) return false;
    const cached = alive.get(cliSessionId);
    if (cached !== undefined) return cached;
    const session = (await db
      .select({ pid: sessions.agentPid, startedAt: sessions.agentStartedAt })
      .from(sessions)
      .where(eq(sessions.cliSessionId, cliSessionId))).at(0);
    const live = !!session?.pid && isSameProcess(session.pid, session.startedAt ?? null);
    alive.set(cliSessionId, live);
    return live;
  };

  const dead: { id: string; taskId: string }[] = [];
  let kept = 0;
  for (const row of rows) {
    if (await sessionAlive(row.cliSessionId)) kept += 1;
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
