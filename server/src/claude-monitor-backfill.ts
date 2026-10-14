// 历史回填：把**升级之前**就已经起过的 claude 内置 Monitor 补进投影表。
//
// 为什么非有不可：这个功能的起点就是用户打开一个任务，agent 在对话里反复说「等 Monitor
// 通知」，而哨兵面板写着「这个任务上还没有哨兵」。实时投影只能管**之后**发生的事——对那个
// 触发需求的任务本身，以及所有升级前跑过的任务，面板仍然是空的，用户的原始疑问一个字都没
// 被回答。
//
// 数据就在手边：每条会话的 stdout 原样落在 `data/runs/<taskId>/` 下（stream-json，一行一个
// 事件），实时投影认人用的那几个字段全在里面。所以回填不是重新发明一套解析，而是把同一套
// 判据对着历史文件再跑一遍。
//
// ── 这个文件是来源重建层，和实时事件共用同一套事实优先级 ──────────────────────────
//
// 第 3 轮审查把前一版的毛病归到了一处：它把「我手上没有的信息」当成了「事实」。于是
//   · 历史里没读到终态 → 直接写 lost，哪怕来源**现在还在盯着**；
//   · 已有行一律跳过 → 旧行缺的会话归属永远补不上，从此谁都管不了它；
//   · 前缀截到第一个 `-` → 会话 id 含 `-` 时一个文件都匹配不上（nanoid 字母表含 `-`）；
//   · 每个文件重置状态 → 跨文件的 started/通知关联不上，又回到写 lost；
//   · 扫描一开始就记「扫过了」→ 读失败/截断之后再也不会重试。
//
// 所以这一版的四条规矩：
// ① **事实优先级**：来源说过的终态 > ash 的推断（`lost`）> 没有结局。没读到终态时先问
//    `claude-monitor-liveness` 来源还活不活，活着就写 `running`，别宣告死亡。
// ② **补齐而非跳过**：已有行缺的（会话归属、期限）照补，ash 推断错的（`lost`）按来源事实
//    纠正；来源已经说过的终态不碰。判据 `monitorStatusCorrectable` 与实时投影共用。
// ③ **一条会话一套状态**：`pending`/`byToolUse`/`found` 跨它的全部 run 文件存活。
// ④ **成功且完整才算扫过**：截断、读失败、写失败都不记缓存，下次打开面板再试。
import { createInterface } from "node:readline";
import { createReadStream, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, eq } from "drizzle-orm";
import {
  claudeMonitorStatus, monitorStatusCorrectable, parseMonitorStartReceipt, type MonitorLifetime,
} from "@ash/shared/monitor";
import { bus } from "./bus.js";
import { createLivenessProbe } from "./claude-monitor-liveness.js";
import { db, dbClient } from "./db/index.js";
import { monitors, sessions } from "./db/schema.js";
import { monitorStr as str, parseMonitorInput, type MonitorCall } from "./claude-monitors.js";
import { id, now } from "./util.js";

/** 单个历史文件的读取上限。超了只回填前面这一段，并且**不记缓存**（见 `Scan.truncated`）。 */
const MAX_SCAN_BYTES = 128 * 1024 * 1024;

/** 已经**完整且成功**扫过的任务。不完整的不进来，下次打开面板会重试。 */
const done = new Set<string>();

/** 正在扫的任务 → 它那次的 Promise。并发调用共享同一次工作，不重复读盘。 */
const inflight = new Map<string, Promise<number>>();

/** 一条 ash 会话的扫描工作集。**跨它的全部 run 文件存活**（规矩 ③）。 */
type Scan = {
  /** tool_use_id → Monitor 入参。`task_started` 可能落在下一个文件里。 */
  pending: Map<string, MonitorCall>;
  /** tool_use_id → 后台任务 id。起手回执同样可能跨文件到达。 */
  byToolUse: Map<string, string>;
  found: Map<string, Found>;
  /** 有文件撞到 `MAX_SCAN_BYTES`：这次的结果是残缺的。 */
  truncated: boolean;
  /** 有文件读失败。 */
  failed: boolean;
  /** 文件里出现过的、与期望不符的 session_id（只作诊断，不丢数据）。 */
  foreign: Set<string>;
};

type Found = {
  nativeId: string;
  call: MonitorCall;
  /** 事件里自报的会话身份，优先于 `sessions` 表那一列（旧行那一列可能是空的）。 */
  cliSessionId: string | null;
  /**
   * 起始时刻。两种来源，**可信度不同**：
   * - `event`：`task_started` 之前最近一条自报 timestamp 的事件（秒级误差），可以拿来算期限。
   * - `file`：退回 run 文件名上的时刻。那是**这一轮进程开始**的时刻，不是 Monitor 开始的
   *   时刻——agent 可能先干了 20 分钟活才挂上一个 10 分钟的哨兵。拿它当锚点算出来的「盯到
   *   X」会早得离谱，所以这一档只用于显示，不参与期限计算。
   */
  startedAt: string | null;
  startedAtFrom: "event" | "file" | null;
  /** 终态附近最近一条带 timestamp 的事件。 */
  endedAt: string | null;
  lifetime: MonitorLifetime;
  expiresMs: number | null;
  status: string | null;
  endedReason: string | null;
};

const newScan = (): Scan => ({
  pending: new Map(), byToolUse: new Map(), found: new Map(),
  truncated: false, failed: false, foreign: new Set(),
});

/**
 * 一条会话**全部**的 stdout 文件，按时间排好。
 *
 * `sessions.agent_out_path` 只记着**最后一次** run 的那一个——每跑一回合就被覆盖一次。
 * 直接照它扫，拿到的只是最后一回合，而内置 Monitor 多半起在中间某一轮（实测用户那个任务：
 * 字段指向第 6 个文件，12 个 Monitor 全在前 5 个里，照字段扫一条都补不到）。
 *
 * 落盘约定是 `data/runs/<taskId>/<sessionId>-<时间戳>.agent-out.jsonl`（executors/detached.ts
 * 的 `runPaths`），所以**拿 `sessions.id` 当前缀**，不从文件名去猜。前一版按「截到第一个
 * `-`」推前缀，而 nanoid 的字母表含 `-`（实测 `-0123456789A-Za-z_`）：会话 id 形如
 * `-abcDEF12345` 时前缀退化成 `-`，一个文件都匹配不上（第 3 轮审查实测 added=0）。
 */
function streamFilesOf(sessionId: string, outPath: string): { path: string; startedAt: string | null }[] {
  const dir = dirname(outPath);
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return [{ path: outPath, startedAt: null }]; }
  const files = entries
    .filter((f) => f.startsWith(`${sessionId}-`) && f.endsWith(".agent-out.jsonl"))
    .sort()
    .map((f) => ({ path: join(dir, f), startedAt: timestampOf(f) }));
  // 一个都没匹配上时退回字段本身：好过什么都不扫。
  return files.length ? files : [{ path: outPath, startedAt: null }];
}

/** 从 `<id>-20261014T063919165Z.agent-out.jsonl` 里把那个时间戳还原成 ISO。认不出就 null。 */
function timestampOf(fileName: string): string | null {
  const m = /-(\d{8})T(\d{6})(\d{3})Z\./.exec(fileName);
  if (!m) return null;
  const [, date, time, ms] = m;
  const iso = `${date!.slice(0, 4)}-${date!.slice(4, 6)}-${date!.slice(6, 8)}T`
    + `${time!.slice(0, 2)}:${time!.slice(2, 4)}:${time!.slice(4, 6)}.${ms}Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/** 事件自报的时刻。只有 `assistant` / `user` 带（`system` 不带，实测）。 */
function eventTime(ev: any): string | null {
  const t = typeof ev?.timestamp === "string" ? ev.timestamp : "";
  return t && !Number.isNaN(Date.parse(t)) ? t : null;
}

/**
 * 扫一份 agent-out.jsonl，把里面的内置 Monitor 连同它们的结局并进 `scan`。
 *
 * 判据与实时投影**同一套**（`ClaudeMonitorTrace`）：`task_started` 的 `tool_use_id` 回指
 * 发起它的工具名，只有 `Monitor` 算数——普通后台 Bash（`run_in_background`）同样是
 * `local_bash`，混进来会把面板变成一份「这个任务跑过的所有后台命令」流水账。
 */
async function scanStream(
  scan: Scan, path: string, expectSessionId: string | null, fileStartedAt: string | null,
): Promise<void> {
  let size = 0;
  try { size = statSync(path).size; } catch { scan.failed = true; return; }
  if (!size) return;
  if (size > MAX_SCAN_BYTES) scan.truncated = true;

  // 时间锚点：`system` 事件不带 timestamp，但它前后几行的 assistant/user 带（实测 task_started
  // 与最近一条的行距是 5~20 行，秒级误差）。拿它当近似，总比拿「回填运行的这一刻」好——
  // 那可能是几天以后。
  // 真锚点只认事件自报的 timestamp。文件名那个时刻只是兜底显示值，见 Found.startedAtFrom。
  let seenAt: string | null = null;

  const stream = createReadStream(path, { encoding: "utf8", end: MAX_SCAN_BYTES });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const text = line.trim();
      if (!text || text[0] !== "{") continue;
      let ev: any;
      try { ev = JSON.parse(text); } catch { continue; }
      if (ev.type === "stream_event") continue;
      seenAt = eventTime(ev) ?? seenAt;

      // 会话身份核对：对不上只记一笔诊断，**不丢数据**。resume 之后 CLI 会换一个
      // session_id，而文件名前缀已经保证了「这些文件属于这条 ash 会话」。
      const evSession = str(ev.session_id) || null;
      if (evSession && expectSessionId && evSession !== expectSessionId) scan.foreign.add(evSession);

      const content = Array.isArray(ev.message?.content) ? ev.message.content : [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "tool_use" && str(block.name) === "Monitor") {
          const call = parseMonitorInput(block.input);
          if (call && str(block.id)) scan.pending.set(str(block.id), call);
        } else if (block.type === "tool_result") {
          // 起手回执：来源侧唯一说出**生效**期限的地方（入参那个 timeout_ms 只是请求值）。
          const nativeId = scan.byToolUse.get(str(block.tool_use_id));
          const row = nativeId ? scan.found.get(nativeId) : undefined;
          if (!row) continue;
          const raw = typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((b: any) => (b && typeof b.text === "string" ? b.text : "")).join("\n")
              : "";
          const receipt = parseMonitorStartReceipt(raw);
          if (receipt.lifetime !== "unknown") {
            row.lifetime = receipt.lifetime;
            row.expiresMs = receipt.ms;
          }
        }
      }

      if (ev.type !== "system") continue;
      const nativeId = str(ev.task_id);
      if (ev.subtype === "task_started") {
        const call = scan.pending.get(str(ev.tool_use_id));
        if (!call || !nativeId) continue;
        scan.pending.delete(str(ev.tool_use_id));
        scan.byToolUse.set(str(ev.tool_use_id), nativeId);
        scan.found.set(nativeId, {
          nativeId, call,
          cliSessionId: evSession ?? expectSessionId,
          startedAt: seenAt ?? fileStartedAt,
          startedAtFrom: seenAt ? "event" : fileStartedAt ? "file" : null,
          endedAt: null,
          lifetime: "unknown", expiresMs: null,
          status: null, endedReason: null,
        });
      } else if (ev.subtype === "task_notification" && scan.found.has(nativeId)) {
        const row = scan.found.get(nativeId)!;
        row.status = claudeMonitorStatus(ev.status);
        row.endedReason = str(ev.summary) || null;
        row.endedAt = seenAt;
      }
    }
  } catch (e) {
    scan.failed = true;
    console.warn(`[ash] 内置 Monitor 历史扫描读失败（${path}）:`, e);
  } finally {
    lines.close();
    stream.close();
  }
}

/** 这次插入撞的是唯一索引吗（= 别人刚补过同一条，幂等，不是错误）。 */
const isUniqueConflict = (e: unknown): boolean =>
  (e as { errcode?: number } | null)?.errcode === 2067
  || /UNIQUE constraint failed/i.test((e as Error | null)?.message ?? "");

/**
 * 把一个任务历史会话里的内置 Monitor 补进投影表。
 *
 * 返回补了几行（纠正不计入）。并发调用共享同一次扫描；完整成功过的任务在本进程内不再扫。
 */
export function backfillClaudeMonitors(taskId: string): Promise<number> {
  if (dbClient.closed || done.has(taskId)) return Promise.resolve(0);
  // 并发共享：面板和 SSE 可能同时触发，前一版两边各扫一遍，而且先到的那次还没写完库，
  // 后到的那次会读到一份空的「已有行」名单（第 3 轮审查列为非拦截项）。
  const running = inflight.get(taskId);
  if (running) return running;
  const job = runBackfill(taskId).finally(() => inflight.delete(taskId));
  inflight.set(taskId, job);
  return job;
}

async function runBackfill(taskId: string): Promise<number> {
  try {
    const rows = await db
      .select({ id: sessions.id, cliSessionId: sessions.cliSessionId, outPath: sessions.agentOutPath })
      .from(sessions)
      .where(and(eq(sessions.taskId, taskId), eq(sessions.agentType, "claude")));
    if (!rows.length) {
      done.add(taskId); // 这个任务没有 claude 会话，不会凭空长出来
      return 0;
    }

    const scan = newScan();
    for (const session of rows) {
      if (!session.outPath) continue;
      for (const file of streamFilesOf(session.id, session.outPath)) {
        await scanStream(scan, file.path, session.cliSessionId, file.startedAt);
      }
    }
    if (scan.foreign.size) {
      console.warn(`[ash] 内置 Monitor 历史回填：task=${taskId} 的文件里出现了别的会话身份`
        + `（${[...scan.foreign].join(", ")}），已按文件归属采用`);
    }

    const added = await commitFound(taskId, [...scan.found.values()]);

    // **完整且成功才算扫过**（规矩 ④）。截断/读失败留着下次重试：前一版在扫描一开始就记
    // 缓存，于是一次读失败之后，这个任务在本进程里永远不会再被回填（第 3 轮审查实测）。
    if (!scan.truncated && !scan.failed) done.add(taskId);
    else {
      console.warn(`[ash] 内置 Monitor 历史回填不完整（task=${taskId}，`
        + `${scan.truncated ? "有文件超过扫描上限" : ""}${scan.truncated && scan.failed ? "，" : ""}`
        + `${scan.failed ? "有文件读失败" : ""}），下次打开面板会重试`);
    }
    if (added) bus.publish({ type: "task.monitors", taskId });
    return added;
  } catch (e) {
    // 回填失败不该让面板打不开：这是补历史，不是主路径。但要留下线索，而且不记缓存。
    console.warn(`[ash] 内置 Monitor 历史回填失败（task=${taskId}）:`, e);
    return 0;
  }
}

/**
 * 把扫出来的结果落库：缺的插进去，已有的按来源事实补齐/纠正（规矩 ①②）。
 *
 * 写失败会往外抛，由调用方决定不记缓存——**不能整段吞掉**。前一版把所有插入错误当成「唯一
 * 索引撞上了」静静忽略，于是一次 SQLITE_BUSY 之后那张卡永久消失，日志里一个字都没有
 * （第 3 轮审查注入一次写失败即复现：injected=1、rows=[]、warnings=[]）。
 */
async function commitFound(taskId: string, items: Found[]): Promise<number> {
  if (!items.length) return 0;
  const existing = new Map((await db
    .select({
      id: monitors.id, nativeId: monitors.nativeId, status: monitors.status,
      cliSessionId: monitors.cliSessionId, sourceLifetime: monitors.sourceLifetime,
      startedAt: monitors.startedAt,
    })
    .from(monitors)
    .where(and(eq(monitors.taskId, taskId), eq(monitors.kind, "claude"))))
    .filter((r) => !!r.nativeId)
    .map((r) => [r.nativeId as string, r]));

  const probe = createLivenessProbe();
  let added = 0;
  let corrected = 0;

  for (const item of items) {
    // 历史里没读到终态有两种可能，差别正好相反：那一轮的进程早就没了（该写 lost），还是
    // 它**现在还在盯着**（该写 running）。问来源，别猜。
    const sourceAlive = item.status ? false : await probe.sourceAlive(item.cliSessionId, taskId);
    const status = item.status ?? (sourceAlive ? "running" : "lost");
    const endedReason = item.endedReason
      ?? (item.status ? null : sourceAlive ? null : "历史记录里没有它的结局（那一轮的进程早已结束）");
    const prior = existing.get(item.nativeId);

    if (prior) {
      if (await mergeInto(prior, item, status, endedReason)) corrected += 1;
      continue;
    }
    const startedAt = item.startedAt || now();
    // **真起始时刻不明就不编到期时刻。** 期限是相对起点算的，起点本身是猜的时候，那句
    // 「盯到 X」没有事实基础——降一档说「不知道」。只有事件自报的 timestamp 算真锚点：
    // 文件名上那个时刻是整轮进程的开始，Monitor 可能在它之后很久才挂上（报告原话：
    // 「不能用 run 时间制造精确到期时刻」）。
    const trustStart = item.startedAtFrom === "event";
    const lifetime: MonitorLifetime = item.lifetime === "bounded" && !trustStart ? "unknown" : item.lifetime;
    const rowId = id();
    try {
      await insertFound(rowId, taskId, item, status, endedReason, startedAt, lifetime);
      added += 1;
      // 记真实 rowId：同一个任务的两条会话扫出同一个 native_id 时，第二次走 mergeInto,
      // 占位 id 会让那次 UPDATE 静默匹配 0 行。
      existing.set(item.nativeId, {
        id: rowId, nativeId: item.nativeId, status,
        cliSessionId: item.cliSessionId, sourceLifetime: lifetime, startedAt,
      });
    } catch (e) {
      if (!isUniqueConflict(e)) throw e; // 真写失败：往外抛，这次就不算扫完
      // 唯一索引撞上了 = 别人刚补过同一条。幂等，不是错误。
    }
  }
  if (corrected) bus.publish({ type: "task.monitors", taskId });
  return added;
}

/** 插一行历史投影。只读投影：没有 pid、没有日志文件（见 shared/monitor.ts 的两种来源）。 */
async function insertFound(
  rowId: string, taskId: string, item: Found, status: string, endedReason: string | null,
  startedAt: string, lifetime: MonitorLifetime,
): Promise<void> {
  await db.insert(monitors).values({
    id: rowId,
    taskId,
    command: item.call.command,
    description: item.call.description,
    cwd: "",
    status,
    pid: null,
    pidStartedAt: null,
    logPath: "",
    offset: 0,
    events: 0,
    exitCode: null,
    startedAt,
    expiresAt: lifetime === "bounded" && item.expiresMs !== null
      ? new Date(Date.parse(startedAt) + item.expiresMs).toISOString()
      : startedAt,
    // 还在跑的没有结束时刻；结束了的用通知附近那条事件的时刻，不用「回填这一刻」。
    // 还在跑的没有结束时刻；结束了的用通知附近那条事件的时刻。连那个都没有就留空——
    // 写 `now()`（回填这一刻，可能是几天后）等于把读取时间冒充成来源完成时间。
    endedAt: status === "running" ? null : item.endedAt,
    endedReason,
    ownerUserId: null,
    kind: "claude",
    nativeId: item.nativeId,
    cliSessionId: item.cliSessionId,
    sourceLifetime: lifetime,
  });
}

type PriorRow = {
  id: string; nativeId: string | null; status: string;
  cliSessionId: string | null; sourceLifetime: string; startedAt: string;
};

/**
 * 已有行：**按来源事实补齐/纠正，不是「已有就永不更新」**（规矩 ②）。
 *
 * 三件事，各自独立判断：
 * - **会话归属**：`cli_session_id` 这一列上线前落的行是空的，而开机清扫和流收尾都靠它认人。
 *   不补上，那些行就永远没人管得了（第 3 轮审查实测：一条 null 行穿过 sweep、回填、真
 *   completed 和 finishAll，始终停在 running）。
 * - **结局**：只纠正 ash 自己推断的 `lost`（`monitorStatusCorrectable`）。来源说过的终态
 *   不碰——历史文件会被重复扫，翻案等于让显示跟着扫描次数变。
 * - **期限**：`unknown` 升级成来源回执说的那个。已经有事实的不覆盖。
 */
async function mergeInto(
  prior: PriorRow, item: Found, status: string, endedReason: string | null,
): Promise<boolean> {
  const patch: Record<string, unknown> = {};
  if (!prior.cliSessionId && item.cliSessionId) patch.cliSessionId = item.cliSessionId;
  if (item.status && prior.status !== status && monitorStatusCorrectable(prior.status)) {
    patch.status = status;
    patch.endedAt = item.endedAt; // 没有来源时刻就留空，别拿「回填这一刻」冒充
    patch.endedReason = endedReason;
  }
  if (prior.sourceLifetime === "unknown" && item.lifetime !== "unknown") {
    // 有限期要落到期时刻，前提是起点可信。已有行的 startedAt 可能本身就是兜底值，所以
    // 优先用这次从事件里读到的真锚点；两边都不可信时只升级到 persistent/不动期限。
    const anchor = item.startedAtFrom === "event" ? item.startedAt : null;
    if (item.lifetime === "bounded" && item.expiresMs !== null && anchor) {
      patch.sourceLifetime = "bounded";
      patch.startedAt = anchor;
      patch.expiresAt = new Date(Date.parse(anchor) + item.expiresMs).toISOString();
    } else if (item.lifetime === "persistent") {
      patch.sourceLifetime = "persistent";
    }
  }
  if (!Object.keys(patch).length) return false;
  await db.update(monitors).set(patch).where(eq(monitors.id, prior.id));
  return true;
}
