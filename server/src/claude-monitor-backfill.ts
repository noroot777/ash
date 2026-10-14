// 历史回填：把**升级之前**就已经起过的 claude 内置 Monitor 补进投影表。
//
// 为什么非有不可：这个功能的起点就是用户打开一个任务，agent 在对话里反复说「等 Monitor
// 通知」，而哨兵面板写着「这个任务上还没有哨兵」。实时投影只能管**之后**发生的事——对那个
// 触发需求的任务本身，以及所有升级前跑过的任务，面板仍然是空的，用户的原始疑问一个字都没
// 被回答。`cli_session_id` 那次迁移只加了一个空列，没有重建任何来源关系。
//
// 数据就在手边：每条会话的 stdout 原样落在 `sessions.agent_out_path`（stream-json，一行
// 一个事件），实时投影认人用的那几个字段全在里面。所以回填不是重新发明一套解析，而是把
// 同一套判据对着历史文件再跑一遍。
//
// ── 三条设计约束 ──────────────────────────────────────────────────────────────
//
// ① **按需，不在开机时全扫。** 开机扫一遍所有历史会话意味着每次重启都读几百 MB，而绝大
//    多数任务用户根本不会打开。改成「第一次打开这个任务的哨兵面板时扫它自己的」。
// ② **幂等。** 靠 `monitors_native` 唯一索引兜底，重复回填不会长出第二行；同一进程内另有
//    一个 Set 记着扫过谁，避免反复读盘。
// ③ **只补、不覆盖。** 实时投影写的是当下事实，比历史文件新。回填只插入不存在的行。
import { createInterface } from "node:readline";
import { createReadStream, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { and, eq, isNotNull } from "drizzle-orm";
import { claudeMonitorStatus, parseMonitorStartReceipt, type MonitorLifetime } from "@ash/shared/monitor";
import { bus } from "./bus.js";
import { db, dbClient } from "./db/index.js";
import { monitors, sessions } from "./db/schema.js";
import { monitorStr as str, parseMonitorInput, type MonitorCall } from "./claude-monitors.js";
import { id, now } from "./util.js";

/** 单个历史文件的读取上限。超了只回填前面这一段并留下诊断——不值得为补卡片读进 1GB。 */
const MAX_SCAN_BYTES = 128 * 1024 * 1024;

/** 这一轮进程里已经扫过的任务。回填是补历史，同一个任务扫一次就够。 */
const scanned = new Set<string>();

/**
 * 一条会话**全部**的 stdout 文件。
 *
 * `sessions.agent_out_path` 只记着**最后一次** run 的那一个——每跑一回合就被覆盖一次。
 * 直接照它扫，拿到的只是最后一回合，而内置 Monitor 多半起在中间某一轮（实测用户那个任务：
 * 字段指向第 6 个文件，12 个 Monitor 全在前 5 个里，照字段扫一条都补不到）。
 *
 * 真实落盘是同一目录下 `<sessionId>-<时间戳>.agent-out.jsonl`，所以按前缀把兄弟文件一起取。
 * 文件名里那个时间戳同时用来给历史卡一个像样的起始时刻（会话 startedAt 只有第一轮是对的）。
 */
function streamFilesOf(outPath: string): { path: string; startedAt: string | null }[] {
  const dir = dirname(outPath);
  const name = basename(outPath);
  const dash = name.indexOf("-");
  const prefix = dash > 0 ? name.slice(0, dash + 1) : name;
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return [{ path: outPath, startedAt: null }]; }
  const files = entries
    .filter((f) => f.startsWith(prefix) && f.endsWith(".agent-out.jsonl"))
    .sort()
    .map((f) => ({ path: join(dir, f), startedAt: timestampOf(f) }));
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

type Found = {
  nativeId: string;
  call: MonitorCall;
  cliSessionId: string;
  startedAt: string;
  /** 来源回执给出的生效期限。 */
  lifetime: MonitorLifetime;
  expiresMs: number | null;
  /** 文件里有没有读到它的终态。 */
  status: string | null;
  endedReason: string | null;
};

/**
 * 扫一份 agent-out.jsonl，把里面的内置 Monitor 连同它们的结局挑出来。
 *
 * 判据与实时投影**同一套**（`ClaudeMonitorTrace`）：`task_started` 的 `tool_use_id` 回指
 * 发起它的工具名，只有 `Monitor` 算数——普通后台 Bash（`run_in_background`）同样是
 * `local_bash`，混进来会把面板变成一份「这个任务跑过的所有后台命令」流水账。
 */
async function scanStream(path: string, cliSessionId: string, fileStartedAt: string): Promise<Found[]> {
  let size = 0;
  try { size = statSync(path).size; } catch { return []; }
  if (!size) return [];

  const pending = new Map<string, MonitorCall>();   // tool_use_id → Monitor 入参
  const byToolUse = new Map<string, string>();      // tool_use_id → 后台任务 id
  const found = new Map<string, Found>();

  const stream = createReadStream(path, { encoding: "utf8", end: MAX_SCAN_BYTES });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const text = line.trim();
      if (!text || text[0] !== "{") continue;
      let ev: any;
      try { ev = JSON.parse(text); } catch { continue; }
      if (ev.type === "stream_event") continue;

      const content = Array.isArray(ev.message?.content) ? ev.message.content : [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "tool_use" && str(block.name) === "Monitor") {
          const call = parseMonitorInput(block.input);
          if (call && str(block.id)) pending.set(str(block.id), call);
        } else if (block.type === "tool_result") {
          // 起手回执：来源侧唯一说出**生效**期限的地方（入参那个 timeout_ms 只是请求值）。
          const nativeId = byToolUse.get(str(block.tool_use_id));
          const row = nativeId ? found.get(nativeId) : undefined;
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
        const call = pending.get(str(ev.tool_use_id));
        if (!call || !nativeId) continue;
        pending.delete(str(ev.tool_use_id));
        byToolUse.set(str(ev.tool_use_id), nativeId);
        found.set(nativeId, {
          nativeId, call, cliSessionId,
          startedAt: fileStartedAt,
          lifetime: "unknown", expiresMs: null,
          status: null, endedReason: null,
        });
      } else if (ev.subtype === "task_notification" && found.has(nativeId)) {
        const row = found.get(nativeId)!;
        row.status = claudeMonitorStatus(ev.status);
        row.endedReason = str(ev.summary) || null;
      }
    }
  } finally {
    lines.close();
    stream.close();
  }
  return [...found.values()];
}

/**
 * 把一个任务历史会话里的内置 Monitor 补进投影表。
 *
 * 返回补了几行。已经扫过（本进程内）或没有 claude 会话时直接返回 0。
 */
export async function backfillClaudeMonitors(taskId: string): Promise<number> {
  if (dbClient.closed || scanned.has(taskId)) return 0;
  scanned.add(taskId);
  try {
    const rows = await db
      .select({
        cliSessionId: sessions.cliSessionId,
        outPath: sessions.agentOutPath,
        startedAt: sessions.startedAt,
      })
      .from(sessions)
      .where(and(eq(sessions.taskId, taskId), eq(sessions.agentType, "claude"), isNotNull(sessions.agentOutPath)));
    if (!rows.length) return 0;

    // 已经有的不动：实时投影写的是当下事实，比历史文件新。
    const existing = new Set((await db
      .select({ nativeId: monitors.nativeId })
      .from(monitors)
      .where(and(eq(monitors.taskId, taskId), eq(monitors.kind, "claude"))))
      .map((r) => r.nativeId)
      .filter((v): v is string => !!v));

    let added = 0;
    for (const session of rows) {
      if (!session.outPath || !session.cliSessionId) continue;
      const items: Found[] = [];
      for (const file of streamFilesOf(session.outPath)) {
        items.push(...await scanStream(file.path, session.cliSessionId, file.startedAt ?? session.startedAt));
      }
      for (const item of items) {
        if (existing.has(item.nativeId)) continue;
        existing.add(item.nativeId);
        // 历史文件里没读到终态 = 那一轮没来得及写（进程被杀 / 日志被截断）。它所属的 agent
        // 进程早已不在，所以收成 lost 而不是 running —— 回填出一张「正在盯着」的历史卡，
        // 比不回填更误导。
        const status = item.status ?? "lost";
        const endedReason = item.endedReason
          ?? (item.status ? null : "历史记录里没有它的结局（那一轮的进程早已结束）");
        const startedAt = item.startedAt || now();
        try {
          await db.insert(monitors).values({
            id: id(),
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
            expiresAt: item.lifetime === "bounded" && item.expiresMs !== null
              ? new Date(Date.parse(startedAt) + item.expiresMs).toISOString()
              : startedAt,
            endedAt: now(),
            endedReason,
            ownerUserId: null,
            kind: "claude",
            nativeId: item.nativeId,
            cliSessionId: item.cliSessionId,
            sourceLifetime: item.lifetime,
          });
          added += 1;
        } catch {
          // 唯一索引撞上了 = 别人刚补过同一条。幂等，不是错误。
        }
      }
    }
    if (added) bus.publish({ type: "task.monitors", taskId });
    return added;
  } catch (e) {
    // 回填失败不该让面板打不开：这是补历史，不是主路径。但要留下线索。
    scanned.delete(taskId); // 失败不算扫过，下次再试
    console.warn(`[ash] 内置 Monitor 历史回填失败（task=${taskId}）:`, e);
    return 0;
  }
}
