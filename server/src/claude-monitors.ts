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
  claudeMonitorStatus, CLAUDE_MONITOR_ENDED_REASON, monitorExactExpiry,
  monitorStatusCorrectable, parseMonitorStartReceipt, type MonitorLifetime,
} from "@ash/shared/monitor";
import { bus } from "./bus.js";
import { createLivenessProbe } from "./claude-monitor-liveness.js";
import {
  noteMonitorRecovery, noteMonitorRecoveryBySession, type MonitorRecoveryReason,
} from "./claude-monitor-recovery.js";
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
  { taskId: string; cwd: string; pid: number | null; pidStartedAt: string | null; outPath: string } | null
> {
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
   * 改成不命中时查一次库裁决，并把「查过且当时没命中」记在这里，避免对每条通知都查库
   * ——实测一个长任务里 76 条 task_started 有 64 条是普通后台 Bash。
   *
   * **但这个否定结论必须能失效。** 「此刻库里没有这一行」不等于「它不是 Monitor」：回填可能
   * 还没跑到，或者上一次写库失败了。永久否定会让那条通知之后即使行出现了也永远被短路掉
   * （第 5 轮审查按代码推断指出）。
   *
   * 失效**两道都要**：
   * - **精确信号**：`bus` 上的 `task.monitors`。投影行有任何增减都会发它（回填补行、实时
   *   open 都算），正好就是「再查一次会有不同答案」的那一刻。响应是立即的。
   * - **兜底时限**（`FOREIGN_MAX_MS`）：万一有哪条写入路径忘了 publish，否定结论也不该变成
   *   永久的。只靠信号就是把正确性押在「每个 writer 都记得发事件」上。
   *
   * （一开始只做了 30 秒 TTL，自测里立刻发现回填补行是秒级内的事、那条通知仍被短路——时间
   * 阈值本来就是猜测。但反过来只留信号也不够，所以两道并存，各补对方的短板。）
   */
  private foreign = new Map<string, number>();
  /** 否定结论最多撑这么久（兜底，正常由 bus 信号提前作废）。 */
  private static readonly FOREIGN_MAX_MS = 2_000;

  /** 取消 bus 订阅。`finishAll` 里调用，别让实例跟着事件总线泄漏。 */
  private unsubscribe: (() => void) | null = null;
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
  /**
   * 来源侧**自己盖的**最后一个时刻（`assistant`/`user` 事件上的 `timestamp`）。
   *
   * 起点那一刻只有 ash 的墙上时钟可用——`system` 事件不带 timestamp（本机 2.1.283 实测：
   * assistant 1592 条、user 877 条全带，system/stream_event 一条不带）。但「我现在读到了
   * 这条事件」不等于「这件事刚刚发生」：**接管回来那一刻是从文件已消费位置之后接着读的**
   * （见 executors/detached.ts），积压的事件会一口气涌进来，那时的 `Date.now()` 比真实起点
   * 晚几分钟甚至几小时。
   *
   * 所以起点跟历史重建一样按**区间**判：下界取这个来源时刻（必然 ≤ 真实启动时刻，`tool_use`
   * 块就在那条 assistant 事件里），上界取事件到达时刻（必然 ≥ 真实启动时刻），区间宽到超过
   * 共用容差就说「起点不明」。实时与重建的证据档位不同，承诺相同。
   */
  private lastEventAt: string | null = null;
  /**
   * 这条会话属于哪个 ash 任务。**正常跑的时候就记下来**，别等到出事才去查。
   *
   * 出事那条路是「写库两次都失败了，现在要把这件事记进恢复账本」——而记账需要 taskId。
   * 上一版在那一刻才去查 `locateSession`，可磁盘/权限这类故障通常还没好，这一查照样失败，
   * 于是 catch 一兜：既没有待恢复任务、也没有重试定时器，一次性事实就这么没了（第 7 轮
   * 审查按代码推断）。恢复责任本身不能押在「再查一次同一个失败资源」上。
   */
  private taskId = "";
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
    // 投影行一有增减就把否定缓存整批作废：那正是「再查一次会有不同答案」的时刻（见 `foreign`）。
    // 不按 taskId 过滤——清掉只是让下一条通知多查一次库，而漏清会让事实永久丢掉。
    this.unsubscribe = bus.subscribe((ev) => {
      if (ev.type === "task.monitors" && this.foreign.size) this.foreign.clear();
    });
  }

  /**
   * 串到写库链上，**失败重试一次**。
   *
   * 为什么要重试：这些 job 是「已经从事件流里消费掉的事实」——`tool_use`/`task_started` 一旦
   * 处理过就从 `pending` 里删了，来源侧不会再发一遍。一次 SQLITE_BUSY 就只写一行日志的话，
   * 那条投影在这个进程里再也没机会落库（第 5 轮审查按代码推断指出这一条）。
   *
   * 只重试一次、而且隔一小会儿：BUSY 这类争用通常瞬间就过去了；真的是逻辑错误时重试也救不
   * 回来，继续往下拖反而会积压事件流。重试仍失败就留诊断——历史回填那条路还能把它补回来
   * （文件一直在追加，游标式扫描会重读到这条事实）。
   */
  private queue(job: () => Promise<void>): void {
    const once = async (): Promise<void> => {
      try {
        await job();
      } catch (first) {
        this.warn("记账失败，重试一次", first);
        await new Promise((r) => setTimeout(r, 50));
        await job();
      }
    };
    this.chain = this.chain.then(once, once).catch((e) => {
      this.warn("记账重试后仍失败，已留账等自动恢复", e);
      // **事实已经从事件流里消费掉了**（pending/byToolUse 都删了，来源侧不会再发）。原来
      // 这里只有一句「历史回填会再补」，而历史回填本身只在用户打开面板时才跑——留账交给
      // 恢复账本自己退避重排（第 6 轮审查的类问题之一）。
      this.noteRecovery("write-failed");
    });
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

  /**
   * 把「有事实没确认落地」记到这条会话所属的 ash 任务上。
   *
   * 要查一次会话才知道 taskId——这条路只在真失败时才走，多查一次库换一条不丢的事实。
   */
  private noteRecovery(reason: MonitorRecoveryReason): void {
    // 先用正常跑的时候记下的归属（见 `taskId`）。
    if (this.taskId) {
      noteMonitorRecovery(this.taskId, reason);
      return;
    }
    // **一次都没查成功过**（第一条 Monitor 就撞上库故障，或接管实例还没查过）。这时不能
    // 再去查同一个正在失败的资源——上一版就是这么做的，于是 catch 一兜，责任凭空消失，
    // 而来源事实早已消费完（第 8 轮审查实测 firstLookup）。改成挂在**这条流自己的身份**
    // 上：CLI 会话 id 不用查库就有，等库好了由恢复账本自己解析成 taskId。
    noteMonitorRecoveryBySession(this.cliSessionId, reason);
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
    if (!ev) return;
    // **先吸收来源时刻，再按类型过滤**：带 timestamp 的是 assistant/user，而我们要认的
    // task_started 是 system（不带）。过滤写在前面的话这条下界永远取不到（见 lastEventAt）。
    if (typeof ev.timestamp === "string" && ev.timestamp) this.lastEventAt = ev.timestamp;
    if (ev.type !== "system") return;
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
        // **起点在这一行取，不在 open() 里取。** open 排在写库队列上，前面积压多久它就
        // 晚多久——实测注入一个 2.2 秒的前序 job，起点就偏 2205ms，而那一行照旧标着
        // 「亲眼看着它开始的」（第 6 轮审查 liveQueueDelay）。事件到达这一刻才是上界。
        const seen = this.startAnchor();
        // 同步认领，再排队落库：准入与落库之间隔着一个 await，中间到达的终态必须认得出来。
        this.claimed.add(taskId);
        this.queue(() => this.open(taskId, call, seen, str(ev.tool_use_id)));
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
        const deniedAt = this.foreign.get(taskId);
        if (deniedAt !== undefined) {
          if (Date.now() - deniedAt < ClaudeMonitorTrace.FOREIGN_MAX_MS) return;
          this.foreign.delete(taskId); // 兜底时限到了，再查一次
        }
        // 不在 `claimed` 里也要排队：权威是库，不是这一个实例的内存名单（见 `foreign`）。
        // `close` 里的 `locateRow` 查不到就把它记进 `foreign`，下次直接短路。
        this.queue(() => this.close(taskId, claudeMonitorStatus(ev.status), str(ev.summary)));
        return;
      }
      default:
    }
  }

  /**
   * 事件到达这一刻能给出的起点锚点：时刻本体 + 这个区间有多宽。
   *
   * 宽度 = 到达时刻 − 来源盖的上一个时刻。实时流里它是「CLI 吐出那条 assistant 消息」到
   * 「ash 的 readline 回调跑起来」之间那点开销（实测同量级的 tool_use→回执区间是
   * 22~59ms）；接管积压重放时它等于那批事件积压了多久，于是自动落到容差之外。
   */
  private startAnchor(): { at: string; widthMs: number } {
    const at = now();
    const low = this.lastEventAt ? Date.parse(this.lastEventAt) : NaN;
    // 来源一个时刻都没盖过（理论上不会：tool_use 块就在 assistant 事件里）→ 宽度未知，
    // 当成不可信。宁可只报时长，不编时刻。
    const widthMs = Number.isFinite(low) ? Math.abs(Date.parse(at) - low) : Number.POSITIVE_INFINITY;
    return { at, widthMs };
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

  private async open(
    nativeId: string, call: MonitorCall, seen: { at: string; widthMs: number },
    /** 起它的那个 tool_use id。落到行上，历史侧才配得回它的起手回执（见
     *  claude-monitor-commit.ts 的「检查点的两半」）。 */
    toolUseId: string,
  ): Promise<void> {
    const found = await locateSession(this.cliSessionId);
    if (found) this.taskId = found.taskId; // 归属趁手记下（见 `taskId`）
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
    const startedAt = seen.at;
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
      toolUseId: toolUseId || null,
      sourceLifetime: "unknown",
      lifetimeEvidence: null, // 回执还没到；拿到了由 applyReceipt 写成 'receipt'
      // 档位是「实时看着它到达」，**但准不准由误差界说**：接管回来积压重放时这条事件可能
      // 已经旧了几分钟，宽度会自己落到容差之外（见 `lastEventAt`）。判定放在读的时候算，
      // 所以这里只如实记下「锚点哪来的 + 最远差多少」，不在写入侧替读取方下结论。
      startEvidence: "observed",
      startAnchorWidthMs: Number.isFinite(seen.widthMs) ? Math.round(seen.widthMs) : null,
      timeoutMs: null, // 回执才说得出时长
      // 起它的就是当下这一代 agent 进程。抄在行上，之后判死活才不会把下一回合的新进程
      // 当成它（第 4 轮审查实测 reusedSession）。
      sourcePid: found.pid,
      sourcePidStartedAt: found.pidStartedAt,
      // 起它的就是当下这一代 run 文件。pid 已经够判死活了，但两边写同一套列，历史侧的代次
      // 裁决（claude-monitor-backfill.ts 的 reconcileLiveness）才不必对实时行网开一面。
      sourceRun: found.outPath || null,
      // 起点的下界：实时投影自己就看着它到达，锚点是 `observed`，所以下界就是那一刻。
      startLowAt: startedAt,
    });
    this.rows.set(nativeId, rowId);
    bus.publish({ type: "task.monitors", taskId: found.taskId });
  }

  /** 把来源回执落到那一行上：期限从「未知」升级成有限期或持续。 */
  private async applyReceipt(nativeId: string, lifetime: MonitorLifetime, ms: number | null): Promise<void> {
    const found = await locateSession(this.cliSessionId);
    if (!found) return;
    this.taskId = found.taskId;
    const rowId = await this.locateRow(found.taskId, nativeId);
    if (!rowId) return;
    const row = (await db.select().from(monitors).where(eq(monitors.id, rowId))).at(0);
    // **不看状态**：回执带来的是时长和起点，跟这一行此刻是不是终态没有关系。原来这里有一道
    // `monitorStatusCorrectable` 闸、WHERE 里又按状态过滤了一遍，于是「完成抢先于回执到达」
    // 的那种（命令瞬间结束）时长永远补不上，卡片永远写着「期限未知」——跟历史回填那一侧
    // 的 casAtRace 是同一个类问题，只是入口在实时这一边（第 6 轮审查）。
    if (!row) return;
    await db.update(monitors).set({
      sourceLifetime: lifetime,
      // 期限是**回执**说的，这才是它可信的理由。旧版本推算出来的那些行这一列是 NULL，
      // 迁移据此纠正（见 shared/monitor.ts 的 MONITOR_LIFETIME_EVIDENCE）。
      lifetimeEvidence: "receipt",
      // 时长单独记一列：起点不确定的那些行（历史重建）靠它显示「时长 X」。
      timeoutMs: ms,
      // **起点那两列一个都不动**：锚点和它的误差界是 open 那一刻如实记下的事实，回执只负责
      // 时长。起点够不够准由读取方拿「误差界 vs 容差」现算（容差随时长放宽，所以同一行拿到
      // 真实时长之后可能自己就从「不可信」变成「可信」，不需要在这里改任何一列）。
      //
      // 到期列同样现算，算不出来就明确落回占位值。上一版只补时长、把占位值留在那儿，于是
      // 期限从 unknown 升级那一刻卡片画出「开始即到期」（第 6 轮审查 pending-receipt）。
      expiresAt: monitorExactExpiry({
        sourceLifetime: lifetime, startEvidence: row.startEvidence,
        startAnchorWidthMs: row.startAnchorWidthMs, startedAt: row.startedAt, timeoutMs: ms,
      }) ?? row.startedAt,
    }).where(eq(monitors.id, rowId));
    bus.publish({ type: "task.monitors", taskId: row.taskId });
  }

  private async close(nativeId: string, status: string, summary: string): Promise<void> {
    const found = await locateSession(this.cliSessionId);
    if (!found) return;
    this.taskId = found.taskId;
    const rowId = await this.locateRow(found.taskId, nativeId);
    if (!rowId) {
      // 库里**暂时**没有。多数情况是这条后台任务不是 Monitor 起的（普通后台 Bash），
      // 但也可能是回填还没跑到 / 上次写库失败了——所以这个结论会在投影行变化时整批作废
      // （见 `foreign` 和构造函数里的订阅）。
      this.foreign.set(nativeId, Date.now());
      return;
    }
    const row = (await db.select().from(monitors).where(eq(monitors.id, rowId))).at(0);
    // `lost` 也要让路：那是 ash 推断的，来源侧后到的真终态是事实（见 monitorStatusCorrectable）。
    if (!row || !monitorStatusCorrectable(row.status)) return;
    // **条件更新**：WHERE 里再查一次旧状态，不是只按 id 写。读和写之间隔着 await，期间另一个
    // writer（回填的 merge / 死活裁决）可能已经落了一个来源终态；只按 id 写会把它覆盖掉。
    // 对称的 revive/bury 一开始就在 SQL 里带了这个条件，这两处之前漏了（第 5 轮审查指出）。
    const result = await db.update(monitors).set({
      status,
      endedAt: now(),
      endedReason: summary || CLAUDE_MONITOR_ENDED_REASON[status as keyof typeof CLAUDE_MONITOR_ENDED_REASON] || null,
    }).where(and(eq(monitors.id, rowId), inArray(monitors.status, ["running", "lost"])));
    // 条件更新 0 行 = 这条来源终态**没有**落地（期间别的 writer 改了状态）。来源侧不会重发，
    // 所以要留账让回填那条路重读一次并重新裁决，不能就这么算了（第 6 轮审查的类问题）。
    if (Number((result as { rowsAffected?: number } | null)?.rowsAffected ?? 0) === 0) {
      noteMonitorRecovery(found.taskId, "update-missed");
    }
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
    this.foreign.clear();
    this.unsubscribe?.();
    this.unsubscribe = null;
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
