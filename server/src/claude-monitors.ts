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
import { and, eq, inArray } from "drizzle-orm";
import { claudeMonitorStatus, CLAUDE_MONITOR_ENDED_REASON, normalizeMonitorTimeout } from "@ash/shared/monitor";
import { bus } from "./bus.js";
import { db, dbClient } from "./db/index.js";
import { monitors, sessions } from "./db/schema.js";
import { id, now } from "./util.js";

/** 一个内置 Monitor 的入参，从它的 tool_use 块上摘下来。 */
type MonitorCall = { command: string; description: string; timeoutMs: number };

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
  // claude 自己也会钳（超过 30 分钟一律按 30 分钟），ash 这边的区间已经对齐过去了，
  // 所以同一个 normalize 两边得出的结果一致。
  const timeoutMs = normalizeMonitorTimeout(typeof fields.timeout_ms === "number" ? fields.timeout_ms : undefined);
  return { command, description, timeoutMs };
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
  /** claude 的后台任务 id → ash 这边那一行的主键。 */
  private rows = new Map<string, string>();
  /** 串行化写库：同一个后台任务的 started/notification 可能紧挨着到。 */
  private chain: Promise<unknown> = Promise.resolve();
  private cliSessionId = "";

  private queue(job: () => Promise<void>): void {
    this.chain = this.chain.then(job, job).catch(() => {});
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
    if (ev.session_id) this.cliSessionId = str(ev.session_id);
    const taskId = str(ev.task_id);
    switch (ev.subtype) {
      case "task_started": {
        // 只认 Monitor 起的。普通后台 Bash（`run_in_background`）同样是 local_bash，
        // 把它们一起记进来会让哨兵面板变成一份「这个任务跑过的所有后台命令」流水账
        // ——实测 76 条里有 64 条是它们。
        const call = this.pending.get(str(ev.tool_use_id));
        if (!call || !taskId) return;
        this.pending.delete(str(ev.tool_use_id));
        this.queue(() => this.open(taskId, call));
        return;
      }
      case "task_notification": {
        // 只管我们认领过的那些；别的后台任务的通知一概不碰。
        if (!taskId || !this.rows.has(taskId)) return;
        this.queue(() => this.close(taskId, claudeMonitorStatus(ev.status), str(ev.summary)));
        return;
      }
      default:
    }
  }

  private async open(nativeId: string, call: MonitorCall): Promise<void> {
    const found = await locateSession(this.cliSessionId);
    if (!found) return;
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
    });
    this.rows.set(nativeId, rowId);
    bus.publish({ type: "task.monitors", taskId: found.taskId });
  }

  private async close(nativeId: string, status: string, summary: string): Promise<void> {
    const rowId = this.rows.get(nativeId);
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
    const ids = [...this.rows.values()];
    this.rows.clear();
    this.pending.clear();
    if (!ids.length) return;
    this.queue(async () => {
      if (dbClient.closed) return;
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
