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
import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import {
  claudeMonitorStatus, CLAUDE_MONITOR_ENDED_REASON, monitorExactExpiry,
  monitorStatusCorrectable, parseMonitorStartReceipt, type MonitorLifetime,
} from "@ash/shared/monitor";
import { bus } from "./bus.js";
import { monitorStr as str, parseMonitorInput, type MonitorCall } from "./claude-monitor-call.js";
import { matchBySource } from "./claude-monitor-identity.js";
import {
  hasRunOrigin, locateSession, runOriginOfSession, UNKNOWN_RUN_ORIGIN, type MonitorRunOrigin,
} from "./claude-monitor-origin.js";
import { isTaskRevoked } from "./claude-monitor-revoked.js";
import { orphanRows, writeIfTaskAlive } from "./claude-monitor-write.js";
import {
  noteMonitorRecovery, noteMonitorRecoveryBySession, type MonitorRecoveryReason,
} from "./claude-monitor-recovery.js";
import { db, dbClient } from "./db/index.js";
import { monitors } from "./db/schema.js";
import { id, now } from "./util.js";

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
   * 这条流的来源身份（起这些监听的是哪一代进程、哪个 run 文件）。
   *
   * **绑定一次，之后落库/收尾/认行全用它**。为什么不能在落库那一刻去问 `sessions`：那三列
   * 每回合被下一轮覆盖，而落库排在队列上 —— 晚到的那一下读到的是下一代人的凭据，旧监听于是
   * 被新进程续命（整段来龙去脉在 `claude-monitor-origin.ts` 的文件头）。
   */
  private origin: MonitorRunOrigin | null = null;
  /** 没有显式来源时那一次会话读（**构造那一刻**发起的，不是落库那一刻）。 */
  private originFreeze: Promise<void> | null = null;
  /** 那次读最多给两回机会：构造时会话行还没写出来的话，第一次必然查不到。 */
  private originReads = 0;
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
   * @param origin 这条流的来源身份（哪一代进程 / 哪个 run 文件起的这些监听）。**生产路径
   * 一律传**：它由 child 自己给出（`runOriginOfChild`），不经过任何会被下一轮覆盖的列。不传
   * 就退到「构造那一刻查一次会话并冻住」那条路（见 `freezeOrigin`）。
   */
  constructor(cliSessionId?: string, origin?: MonitorRunOrigin) {
    // 流自带的最硬：这条 stdout 就是那个进程写的。两样都空 = 其实没给（合成的失败 child）。
    if (hasRunOrigin(origin)) this.origin = { ...origin! };
    if (cliSessionId) {
      this.cliSessionId = cliSessionId;
      this.startReclaim();
      this.freezeOrigin();
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

  /**
   * 没有显式来源时的退路：**构造这一刻**查一次会话，把那一代的凭据冻在实例上。
   *
   * 为什么非得是这一刻：会话行那三列每回合被下一轮整组覆盖，而落库排在队列上（前面积压
   * 多久就晚多久）。晚一步读到的是下一代人的凭据，于是上一轮早就结束的监听写上新一代的
   * pid 和 run 文件，死活裁决照着它把旧卡续命成「正在盯着」，刷新也不自愈（整段在
   * `claude-monitor-origin.ts` 的文件头）。构造这一刻还在本代人手里。
   *
   * 读不到就**不冻**（会话行还没写出来）：`runOrigin` 会再给一次机会，之后按「没有凭据」
   * 落库 —— 绝不改成落库那一刻现查。
   */
  private freezeOrigin(): void {
    if (this.origin || this.originFreeze || this.originReads >= 2 || !this.cliSessionId) return;
    this.originReads += 1;
    const done = () => { this.originFreeze = null; };
    this.originFreeze = locateSession(this.cliSessionId).then((home) => {
      if (home) this.origin ??= runOriginOfSession(home);
      done();
    }, done);
  }

  /** 这条流的来源身份。拿不到就是「没有凭据」（NULL 落库，死活裁决退回会话那一层）。 */
  private async runOrigin(): Promise<MonitorRunOrigin> {
    if (!this.origin && this.originFreeze) await this.originFreeze;
    if (!this.origin) {
      this.freezeOrigin();
      if (this.originFreeze) await this.originFreeze;
    }
    return this.origin ?? UNKNOWN_RUN_ORIGIN;
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
    if (!nativeId) {
      // 回执配不上 `task_started` ⇒ 这次调用压根没起来（启动被拒、入参校验失败）。那条悬着
      // 的调用当场清掉，别留到 `finishAll` ——判据是「配不上」而不是回执里的错误文案，与历史
      // 扫描同一套（见 claude-monitor-scan.ts 的同一处；第 11 轮审查点名的对称位置）。
      if (callId) this.pending.delete(callId);
      return;
    }
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
    // 来源也一起：构造时还不知道是哪条会话的实例，`init` 这一刻是它最早能绑定的时机 ——
    // 仍然远早于落库（`freezeOrigin` 同样幂等）。
    if (this.cliSessionId) { this.startReclaim(); this.freezeOrigin(); }
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

  /**
   * 把投影行找出来。内存里没有就查库——接管回来的那些只在库里。
   *
   * **身份是 (taskId, 来源会话, nativeId)，不是 (taskId, nativeId)。** native_id 只在一条 CLI
   * 会话内唯一，同一个任务上先后两条会话撞同一个 id 时，少了会话这一维就会把乙的通知写到
   * 甲那一行上（第 13 轮审查 N1）。挑哪一行的判据在 `claude-monitor-identity.ts`。
   */
  private async locateRow(taskId: string, nativeId: string, sourceRun: string): Promise<string | null> {
    const cached = this.rows.get(nativeId);
    if (cached) return cached;
    const rows = await db
      .select({
        id: monitors.id, cliSessionId: monitors.cliSessionId, sourceRun: monitors.sourceRun,
      })
      .from(monitors)
      .where(and(eq(monitors.taskId, taskId), eq(monitors.nativeId, nativeId), eq(monitors.kind, "claude")));
    // 证据是**这条流绑定下来的那个 run 文件**(调用方手里的 `runOrigin()`):native_id 不是
    // 证据，它只在一条 CLI 会话内唯一(见 claude-monitor-identity.ts)。拿 `sessions` 当下那一
    // 列当证据是错的 —— 那是下一代人的 run(见 claude-monitor-origin.ts 的文件头)。
    const row = matchBySource(rows, { cliSessionId: this.cliSessionId, sourceRun });
    if (row) this.rows.set(nativeId, row.id);
    return row?.id ?? null;
  }

  private async open(
    nativeId: string, call: MonitorCall, seen: { at: string; widthMs: number },
    /** 起它的那个 tool_use id。落到行上，历史侧才配得回它的起手回执（见
     *  claude-monitor-commit.ts 的「检查点的两半」）。 */
    toolUseId: string,
  ): Promise<void> {
    // 代次凭据**先取**（多数情况下已经冻好、同步返回）：它和下面那道落库资格门闸之间不能
    // 再插一个 await，否则又把「查到会话之后、写之前问」那个窗口拉开了。
    const origin = await this.runOrigin();
    const found = await locateSession(this.cliSessionId);
    if (found) this.taskId = found.taskId; // 归属趁手记下（见 `taskId`）
    // 这个任务正在删/已经删了：实时这一侧也要问一句落库资格。它不在回填的 inflight 里，
    // 那份 finally 的补偿够不着它（第 5 轮审查 F1 指出的 writer 盲点）。查到会话之后、写
    // 之前问，窗口缩到一条语句；真有漏网的由启动期孤儿清扫收（sweepOrphanClaudeMonitors）。
    if (found && isTaskRevoked(found.taskId)) return;
    if (!found) {
      // 认不出会话就落不了库。安静跳过是对的（不能因此拖垮事件流），但要留下线索——
      // 否则用户看到的是「agent 说挂上了，面板永远空着」，而日志里什么都没有。
      this.warn("找不到对应的 ash 会话，这条没有记上", `native=${nativeId}`);
      return;
    }
    // 同一个 native_id 重复开（流被重放、resume 后 CLI 重发）就不再插一行。唯一索引
    // monitors_native_source 是最后一道，这里先查一次省掉一次必然失败的插入。
    // 同样要带上来源会话：另一条会话的同号监听是**另一条**监听，不是这一条的重放。
    const candidates = await db
      .select({
        id: monitors.id, cliSessionId: monitors.cliSessionId, sourceRun: monitors.sourceRun,
      })
      .from(monitors)
      .where(and(eq(monitors.taskId, found.taskId), eq(monitors.nativeId, nativeId)));
    const existing = matchBySource(candidates, {
      cliSessionId: this.cliSessionId, sourceRun: origin.runPath,
    });
    if (existing) {
      this.rows.set(nativeId, existing.id);
      return;
    }
    const rowId = id();
    const startedAt = seen.at;
    // 落库资格跟插入在同一个批里（见 claude-monitor-write.ts）:上面那道门闸之后还隔着
    // 两次 await,任务在这中间删完的话,这一行就成了没人清得掉的孤儿。
    await writeIfTaskAlive(db.insert(monitors).values({
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
      // 起它的就是**这条流绑定下来的那一代** agent 进程。抄在行上，之后判死活才不会把下一
      // 回合的新进程当成它（第 4 轮审查实测 reusedSession）。
      //   凭据取自 `runOrigin()` 而不是此刻的 `sessions`：后者每回合被下一轮覆盖，而这一行
      // 可能是上一代的监听排在队列上刚轮到落库（新一轮第 1 轮审查 F1 实测：旧监听写上了新
      // 一代的 pid 和 run，于是死活裁决拿新进程给它续命，刷新也不自愈）。
      sourcePid: origin.pid,
      sourcePidStartedAt: origin.pidStartedAt,
      // 同一份凭据里的 run 文件。pid 已经够判死活了，但两边写同一套列，历史侧的代次裁决
      // （claude-monitor-reconcile.ts 的 reconcileLiveness）才不必对实时行网开一面。
      sourceRun: origin.runPath || null,
      // 起点的下界：实时投影自己就看着它到达，锚点是 `observed`，所以下界就是那一刻。
      startLowAt: startedAt,
    }), db.delete(monitors).where(orphanRows(monitors, found.taskId)));
    this.rows.set(nativeId, rowId);
    bus.publish({ type: "task.monitors", taskId: found.taskId });
  }

  /** 把来源回执落到那一行上：期限从「未知」升级成有限期或持续。 */
  private async applyReceipt(nativeId: string, lifetime: MonitorLifetime, ms: number | null): Promise<void> {
    const origin = await this.runOrigin();
    const found = await locateSession(this.cliSessionId);
    if (!found) return;
    this.taskId = found.taskId;
    if (isTaskRevoked(found.taskId)) return;   // 落库资格，同 `open`
    // 认行的来源证据同样只认绑定下来的那一代（`sessions` 当下那一列已经是下一代人的）。
    const rowId = await this.locateRow(found.taskId, nativeId, origin.runPath);
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
    const origin = await this.runOrigin();
    const found = await locateSession(this.cliSessionId);
    if (!found) return;
    this.taskId = found.taskId;
    if (isTaskRevoked(found.taskId)) return;   // 落库资格，同 `open`
    const rowId = await this.locateRow(found.taskId, nativeId, origin.runPath);
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
   * agent 进程结束了：把**这一代**名下还挂着 `running` 的投影落 `lost`。
   *
   * 不收这个尾的话，面板上会永远留着几张「正在盯着」的卡，而那些进程早就随 agent 一起
   * 没了——这正是 ash 哨兵当初要解决的问题，不该在投影这一侧原样复刻一遍。
   *
   * 注意这跟 `reattachMonitors` 的分工：那边只认 `kind='ash'`（有 pid 可以验），claude 的
   * 投影没有 pid，唯一可靠的死亡信号就是「它所属的 agent 进程结束了」，也就是这里。
   *
   * **返回值是「这一摊记完了」**：调用方（`executors/claude-stream.ts` 的 finally）等它一下，
   * 流结束那一刻投影就已经落定；不等的话收尾还排在队列里，而外面那一轮的会话更新随时可能
   * 先落地（同一类问题的另一个出口，新一轮第 1 轮审查点名）。底层驱动是同步的，队列自身
   * 又吞掉全部异常（见 `queue`），所以这个 await 不会把事件流拖住，也不会抛。
   */
  finishAll(): Promise<void> {
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
      // **但只收自己这一代的尾。** 同一条 CLI 会话会跨好几代进程（resume 后号不变），
      // 把别的代次一起收掉就是拿这一代的死亡给上一代下结论 —— 方向上虽然同样是「判死」，
      // 凭据却是错的，而错凭据两个方向都会用（这一代还活着时同样会把旧卡续命，那就是 F1）。
      // 判据和落库那一侧同一份：**证明不了是别人的就算我的** —— `source_run` 为空的是存量行
      // 和没有落盘文件的会话（Windows、常驻），它们只可能归我；明确记着另一个 run 的才排除。
      // 自己都没有 run 凭据时（`runPath` 为空）回到老语义：整条会话一起收。
      const origin = await this.runOrigin();
      const mine = origin.runPath
        ? or(isNull(monitors.sourceRun), eq(monitors.sourceRun, origin.runPath))
        : undefined;
      const live = await db
        .select({ id: monitors.id, taskId: monitors.taskId })
        .from(monitors)
        .where(and(
          eq(monitors.kind, "claude"),
          eq(monitors.status, "running"),
          eq(monitors.cliSessionId, cliSessionId),
          mine,
        ));
      if (!live.length) return;
      await db.update(monitors).set({
        status: "lost",
        endedAt: now(),
        endedReason: CLAUDE_MONITOR_ENDED_REASON.lost ?? null,
      }).where(and(inArray(monitors.id, live.map((r) => r.id)), eq(monitors.status, "running")));
      for (const taskId of new Set(live.map((r) => r.taskId))) bus.publish({ type: "task.monitors", taskId });
    });
    // 队列永不 reject（`queue` 的 catch 兜住并留账），所以这里原样交出去就行。
    return this.chain.then(() => undefined);
  }
}
