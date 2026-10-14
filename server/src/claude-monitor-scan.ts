// 扫描层：从 agent 的 stdout 落盘文件里认出内置 Monitor，**可增量续读**。
//
// 为什么要增量：上一版缓存的是「这个任务扫过了」，没有任何版本依据。而这些文件是**活的**
// ——任务还在跑，stdout 一直在追加。于是正常运行中的任务第一次打开面板之后，后续追加的
// Monitor、以及已有 Monitor 的完成通知，同一个 server 进程里再也读不到（第 4 轮审查实测
// cachedSnapshot：空文件后追加 → rows=[]；先无会话后新增会话 → rows=[]；已扫过的文件追加
// completed → 卡片仍是 running）。
//
// 所以缓存的粒度改成**每个文件读到第几字节**：
// - `size > cursor.offset` → 从 offset 接着读，只读新增那一段
// - `size < cursor.offset` → 文件被重写或截断过，从头重读
// - 出现新会话 / 新文件 → 给它建一份新游标
// - 全部文件 size 都没变 → 这一轮不碰磁盘
//
// 顺带解决了 128 MiB 上限那条：超限不再是「永远只能读前缀」，而是这一轮读到上限为止、
// offset 停在那里，下次打开面板继续往后读。
//
// ── 按会话分区 ────────────────────────────────────────────────────────────────
//
// `pending`/`byToolUse` 的键是来源侧的 `tool_use_id` / 后台任务 id。上一版为了「跨文件关联
// 事件」把它们做成了**跨整个任务**共用，那是实现过头了：要跨的是同一条会话的多个 run 文件，
// 不是不同会话。实测 1017 条 task_started 里 `local_bash` 的 id 跨会话重复 0 个，但
// `local_agent` 那种出现过同 id 挂两个 tool_use 的情况 —— 来源侧并没有承诺全局唯一，所以
// 按会话分区（见 shared/monitor.ts 的 NATIVE_MONITOR_ID_SCOPE）。
import { open as openFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { claudeMonitorStatus, parseMonitorStartReceipt, type MonitorLifetime } from "@ash/shared/monitor";
import { monitorStr as str, parseMonitorInput, type MonitorCall } from "./claude-monitors.js";

/** 单次调用的读取上限。超了这一轮就停在这儿，游标记着，下次接着读。 */
const MAX_SCAN_BYTES = 128 * 1024 * 1024;
const CHUNK = 1 << 20;

export type Found = {
  nativeId: string;
  call: MonitorCall;
  cliSessionId: string | null;
  /**
   * 起始时刻。**只有来自起手回执那条事件的才可信**（`startedAtFrom === "receipt"`）。
   *
   * 为什么不能用 tool_use 那条 assistant 事件的时刻：工具调用可能卡在权限确认或调度上，
   * 模型发出调用和进程真正起来之间能差很久（第 4 轮审查实测 timestampAnchor：tool_use 在
   * 12:13、回执在 12:33，按前者算出来的到期时刻早了整整 20 分钟）。而起手回执是**启动之后
   * 立刻**返回的，它那条事件的时刻就约等于真实启动时刻。
   *
   * 这正好和「期限从哪来」重合：能算到期时刻的前提是收到回执，而回执自带可信时刻。所以不会
   * 出现「知道期限但不知道起点」的组合。
   */
  startedAt: string | null;
  startedAtFrom: "receipt" | "tool_use" | "file" | null;
  endedAt: string | null;
  lifetime: MonitorLifetime;
  expiresMs: number | null;
  status: string | null;
  endedReason: string | null;
  /** 它是在哪个 run 文件里起的。用来判「那一代 run 结束了没有」。 */
  filePath: string;
  /**
   * 它所在的 run 文件**不是**这条会话最新的那个 —— 也就是后来又起过新的一轮。
   *
   * 每个 run 文件对应一次 agent 进程启动（executors/detached.ts 的 `runPaths`），所以这是
   * 「起它的那一代进程已经退出」的确证。缺了它，历史投影只能退回「这条会话现在有没有活
   * 进程」，而那会被**下一回合的新进程**骗（第 4 轮审查实测 reusedSession）。
   *
   * 每轮扫完重算：新文件出现时，之前那些 Found 要跟着变成 stale。
   */
  staleRun: boolean;
};

/** 一条会话的扫描状态。跨它的全部 run 文件、跨多次增量调用存活。 */
type SessionScan = {
  /** tool_use_id → 入参 + 那条 assistant 事件的时刻（只作显示占位，见 Found.startedAt）。 */
  pending: Map<string, { call: MonitorCall; at: string | null }>;
  byToolUse: Map<string, string>;
  found: Map<string, Found>;
  cursors: Map<string, { size: number; offset: number }>;
  /**
   * 最近见到的事件时刻。
   *
   * 只用来给**结束时刻**兜底：`task_notification` 是 system 事件，自己不带 timestamp，而
   * 它前后几行的 assistant/user 带（实测行距 5~20 行，秒级误差）。结束时刻不参与期限计算，
   * 这个精度够用，总比写「回填运行的这一刻」好——那可能是几天以后。
   *
   * **起始时刻不走这条**：那个只认起手回执那条事件的时刻，差一点都不行（见 Found.startedAt）。
   */
  lastAt: string | null;
};

/** 一个任务的扫描快照（进程内缓存）。 */
export type TaskScan = {
  sessions: Map<string, SessionScan>;
  /** 这一轮有文件读到了上限，还没读完。 */
  truncated: boolean;
  /** 这一轮有文件读失败。 */
  failed: boolean;
  /** 文件里出现过的、与期望不符的 session_id（只作诊断）。 */
  foreign: Set<string>;
  /** 这一轮有没有读到新内容。没有就不必重新提交事实。 */
  advanced: boolean;
};

export const newTaskScan = (): TaskScan => ({
  sessions: new Map(), truncated: false, failed: false, foreign: new Set(), advanced: false,
});

const newSessionScan = (): SessionScan => ({
  pending: new Map(), byToolUse: new Map(), found: new Map(), cursors: new Map(), lastAt: null,
});

/**
 * 一条会话**全部**的 stdout 文件，按时间排好。
 *
 * `sessions.agent_out_path` 只记着最后一次 run 的那一个（每回合覆盖），而内置 Monitor 多半
 * 起在中间某一轮 —— 实测用户那个任务字段指向第 6 个文件，12 个 Monitor 全在前 5 个里。
 * 落盘约定是 `<sessionId>-<时间戳>.agent-out.jsonl`（executors/detached.ts 的 `runPaths`），
 * 所以**拿 `sessions.id` 当前缀**，不从文件名去猜（会话 id 是可含 `-` 的 nanoid）。
 */
export async function streamFilesOf(
  sessionId: string, outPath: string,
): Promise<{ path: string; startedAt: string | null }[]> {
  const dir = dirname(outPath);
  let entries: string[] = [];
  try { entries = await readdir(dir); } catch { return [{ path: outPath, startedAt: null }]; }
  const files = entries
    .filter((f) => f.startsWith(`${sessionId}-`) && f.endsWith(".agent-out.jsonl"))
    .sort()
    .map((f) => ({ path: join(dir, f), startedAt: timestampOf(f) }));
  return files.length ? files : [{ path: outPath, startedAt: null }];
}

/** 从 `<id>-20261014T063919165Z.agent-out.jsonl` 里把那个时间戳还原成 ISO。认不出就 null。 */
export function timestampOf(fileName: string): string | null {
  const m = /-(\d{8})T(\d{6})(\d{3})Z\./.exec(fileName);
  if (!m) return null;
  const [, date, time, ms] = m;
  const iso = `${date!.slice(0, 4)}-${date!.slice(4, 6)}-${date!.slice(6, 8)}T`
    + `${time!.slice(0, 2)}:${time!.slice(2, 4)}:${time!.slice(4, 6)}.${ms}Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/**
 * 从 `start` 读到文件尾（或读满 `maxBytes`），逐行回调，返回新游标。
 *
 * **游标只停在完整行的边界上。** 按字节续读时，上一轮很可能正好停在某一行中间（文件还在被
 * 追加）。从半行开始解析会把那条事件整条丢掉，所以残留的不完整尾巴不消费，下次从它的起点
 * 重读。
 */
async function eachLine(
  path: string, start: number, maxBytes: number, onLine: (line: string) => void,
): Promise<{ nextOffset: number; truncated: boolean }> {
  const fh = await openFile(path, "r");
  try {
    let offset = start;
    let carry = Buffer.alloc(0);
    while (offset - start < maxBytes) {
      const want = Math.min(CHUNK, maxBytes - (offset - start));
      const buf = Buffer.allocUnsafe(want);
      const { bytesRead } = await fh.read(buf, 0, want, offset);
      if (!bytesRead) break;
      const data = carry.length
        ? Buffer.concat([carry, buf.subarray(0, bytesRead)])
        : buf.subarray(0, bytesRead);
      let from = 0;
      for (;;) {
        const nl = data.indexOf(0x0a, from);
        if (nl < 0) break;
        onLine(data.subarray(from, nl).toString("utf8"));
        from = nl + 1;
      }
      carry = Buffer.from(data.subarray(from)); // 复制：data 可能指向复用的 buf
      offset += bytesRead;
    }
    return { nextOffset: offset - carry.length, truncated: offset - start >= maxBytes };
  } finally {
    await fh.close();
  }
}

/** 事件自报的时刻。只有 `assistant` / `user` 带（`system` 不带，实测）。 */
function eventTime(ev: any): string | null {
  const t = typeof ev?.timestamp === "string" ? ev.timestamp : "";
  return t && !Number.isNaN(Date.parse(t)) ? t : null;
}

/**
 * 把一条会话的全部文件扫一遍（只读新增部分），结果并进 `scan`。
 *
 * 判据与实时投影同一套：`task_started` 的 `tool_use_id` 回指发起它的工具名，只有 `Monitor`
 * 算数 —— 普通后台 Bash（`run_in_background`）同样是 `local_bash`，混进来会把面板变成一份
 * 「这个任务跑过的所有后台命令」流水账（实测 76 条里 64 条是它们）。
 */
export async function scanSession(
  scan: TaskScan, sessionId: string, cliSessionId: string | null, outPath: string,
  /** 单次读取上限。只有回归测试会传小值——128 MiB 的夹具没法写进测试里。 */
  maxBytes: number = MAX_SCAN_BYTES,
): Promise<void> {
  let session = scan.sessions.get(sessionId);
  if (!session) {
    session = newSessionScan();
    scan.sessions.set(sessionId, session);
  }
  const files = await streamFilesOf(sessionId, outPath);
  for (const file of files) {
    let size = 0;
    try { size = (await stat(file.path)).size; } catch { scan.failed = true; continue; }
    const cursor = session.cursors.get(file.path) ?? { size: 0, offset: 0 };
    // 文件比上次短 = 被重写/截断过，之前的游标无意义，从头再来。
    if (size < cursor.offset) { cursor.offset = 0; cursor.size = 0; }
    // **判据是「读到文件尾了没有」，不是「文件有没有变大」。** 写成 `size === cursor.size`
    // 会在撞到单次上限之后卡死：文件大小没变、游标还停在半路，于是后半截永远读不到
    // （本轮自测：第 1 轮 offset=99134/409154 truncated=true，第 2 轮仍是 99134 就停了）。
    // 空文件也走这一支（0 >= 0），它本来就没东西可读。
    if (cursor.offset >= size) {
      session.cursors.set(file.path, { size, offset: cursor.offset });
      continue;
    }

    const sink = (line: string) => consume(scan, session!, line, cliSessionId, file.startedAt, file.path);
    try {
      const { nextOffset, truncated } = await eachLine(file.path, cursor.offset, maxBytes, sink);
      if (nextOffset > cursor.offset) scan.advanced = true;
      if (truncated) scan.truncated = true;
      session.cursors.set(file.path, { size, offset: nextOffset });
    } catch (e) {
      scan.failed = true;
      console.warn(`[ash] 内置 Monitor 历史扫描读失败（${file.path}）:`, e);
    }
  }
  // **每轮重算**：新文件出现之后，之前那些 Found 的「那一代还在跑吗」答案会翻转。
  const latest = files.length ? files[files.length - 1]!.path : "";
  for (const row of session.found.values()) row.staleRun = !!latest && row.filePath !== latest;
}

/** 一行 stream-json。认人判据见 `scanSession` 的说明。 */
function consume(
  scan: TaskScan, session: SessionScan, line: string,
  expectSessionId: string | null, fileStartedAt: string | null, filePath: string,
): void {
  const text = line.trim();
  if (!text || text[0] !== "{") return;
  let ev: any;
  try { ev = JSON.parse(text); } catch { return; }
  if (ev.type === "stream_event") return;
  const at = eventTime(ev);
  if (at) session.lastAt = at;

  // 会话身份核对：对不上只记一笔诊断，**不丢数据**。resume 之后 CLI 会换 session_id，而
  // 文件名前缀已经保证了「这些文件属于这条 ash 会话」。
  const evSession = str(ev.session_id) || null;
  if (evSession && expectSessionId && evSession !== expectSessionId) scan.foreign.add(evSession);

  const content = Array.isArray(ev.message?.content) ? ev.message.content : [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "tool_use" && str(block.name) === "Monitor") {
      const call = parseMonitorInput(block.input);
      if (call && str(block.id)) session.pending.set(str(block.id), { call, at });
    } else if (block.type === "tool_result") {
      const nativeId = session.byToolUse.get(str(block.tool_use_id));
      const row = nativeId ? session.found.get(nativeId) : undefined;
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
        // 回执这条事件的时刻才是可信起点（见 Found.startedAt）。
        if (at) { row.startedAt = at; row.startedAtFrom = "receipt"; }
      }
    }
  }

  if (ev.type !== "system") return;
  const nativeId = str(ev.task_id);
  if (ev.subtype === "task_started") {
    const started = session.pending.get(str(ev.tool_use_id));
    if (!started || !nativeId) return;
    session.pending.delete(str(ev.tool_use_id));
    session.byToolUse.set(str(ev.tool_use_id), nativeId);
    session.found.set(nativeId, {
      nativeId, call: started.call,
      cliSessionId: evSession ?? expectSessionId,
      // 先用 tool_use 那条的时刻占位（只作显示），回执到了再换成可信起点。
      startedAt: started.at ?? fileStartedAt,
      startedAtFrom: started.at ? "tool_use" : fileStartedAt ? "file" : null,
      endedAt: null,
      lifetime: "unknown", expiresMs: null,
      status: null, endedReason: null,
      filePath, staleRun: false,
    });
  } else if (ev.subtype === "task_notification" && session.found.has(nativeId)) {
    const row = session.found.get(nativeId)!;
    row.status = claudeMonitorStatus(ev.status);
    row.endedReason = str(ev.summary) || null;
    row.endedAt = session.lastAt ?? row.endedAt;
  }
}

/** 这一轮扫出来的全部结果（跨会话合并，键仍按会话分区保证不互相覆盖）。 */
export function foundOf(scan: TaskScan): Found[] {
  const all: Found[] = [];
  for (const session of scan.sessions.values()) all.push(...session.found.values());
  return all;
}
