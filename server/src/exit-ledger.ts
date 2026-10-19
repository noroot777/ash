// 服务端「上一次是怎么停的」账本。
//
// 2026-10-19 排查「ash 又停了」时发现:进程消失这件事在机器上**一点痕迹都没有**。
// 不是 JS 崩溃(兜底 handler 会打印)、不是 V8 OOM(会打印 FATAL ERROR)、不是原生崩溃
// (会在 ~/Library/Logs/DiagnosticReports 留 .ips)、不是 jetsam(会留 JetsamEvent)、
// 也不是 `npm run restart`(只发 SIGTERM)。唯一的线索是单例锁文件被留在原地,以及
// mDNSResponder 日志里一条「DNSServiceCreateConnection STOP PID[…]」—— 靠系统日志
// 反推死亡时刻,这不是个能长期依赖的取证手段。
//
// 所以把两件事做进系统:
//   1. 每条**自己走过**的退出路径都记一条(带信号名、运行时长和这一轮的 runId);
//   2. 下次启动发现锁还在,就拿锁里的 runId 回查账本 —— 查到退出记录说明上一实例
//      **走过**退出路径、只是没删掉锁;查不到才是死因未知。
//
// 两条边界,都是第 1 轮审查打回来的:
//   * **「锁还在」不等于「被强杀」**。删锁本身会失败(数据目录只读就报 EACCES),
//     旧版本的 SIGHUP/SIGQUIT 也会留锁。能证明死法的是账本里有没有那一轮的退出
//     记录,不是锁在不在。所以 `residual` 这个 kind 只说「发现残留」,死因写在
//     `diagnosis` 里,拿不准就是 `unknown`,不许升格成 SIGKILL。
//   * **`note` 可能含别的进程的完整命令行**(PID 被复用时 `staleLockReason` 会把
//     `ps` 读到的命令整段写进去),那里面可能带密钥。账本是 0600 的本地文件,可以
//     存;公开响应必须走 `publicExitSummary` 这个**白名单投影**,逐项选取字段,
//     而不是「以后每出现一种敏感 note 再补一条过滤」。
//
// 账本按 DB 走(预览实例各自一份),只追加、超水位才裁剪。写入一律 best-effort:
// 它跑在退出路径上,绝不能因为磁盘满/权限问题把退出本身搞崩。
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolveAshDbFile } from "./db/path.js";

const LEDGER_SUFFIX = ".exits.jsonl";
/** 裁剪水位:够看清「最近是不是反复出事」,又不会无限长。 */
const KEEP_RECORDS = 200;

export type ExitKind = "signal" | "exit" | "residual";

/**
 * 残留锁的死因判定。**只有这两档**,没有「被 SIGKILL 了」那一档 —— 账本能证明的
 * 上限就是「这一轮有没有留下退出记录」。
 *
 * - `cleanup_failed` 账本里有这一轮的退出记录:它走过退出路径,只是锁没删掉
 * - `unknown`        账本里没有:强杀、内核击杀、或者退出时连账本都没写进去
 */
export type ResidualDiagnosis = "cleanup_failed" | "unknown";

export type ExitRecord = {
  /** 写下这条记录的时刻(ISO)。 */
  at: string;
  /** 这条记录说的是哪个进程。 */
  pid: number;
  /**
   * 这一轮启动的身份:单例锁 token 的短哈希。
   *
   * 用哈希而不是 token 原文,是因为**那串 token 同时是宿主机运维凭证**(见
   * `singleton.ts` 的 `liveLockToken`),不该被复制到第二个文件里躺着。哈希足够
   * 把「锁」和「退出记录」对上。
   */
  runId?: string;
  /**
   * - `signal`   收到可捕获的致命信号后主动退出(SIGTERM/SIGINT/SIGHUP/SIGQUIT)
   * - `exit`     走完 `process.on("exit")`(正常收场,或启动失败自杀)
   * - `residual` 下一次启动发现上一轮的锁还在(死因见 `diagnosis`)
   */
  kind: ExitKind;
  signal?: string;
  code?: number | null;
  /**
   * 这个进程活了多久(ms)。`residual` 只能算到最后一次心跳,所以那种情况下它是
   * **下界**,不是精确寿命。
   */
  uptimeMs?: number | null;
  /**
   * `residual`:最后一次刷心跳的时刻。
   *
   * 这是**最后已知存活时间**,不是死亡时刻的上界 —— 事件循环被堵住、机器睡了、
   * 心跳落盘失败,间隔都可以任意长(第 1 轮审查实测过权限失败导致心跳停更而进程
   * 照活)。要的是「别把它当成 ±一个心跳周期的误差保证」。
   */
  lastHeartbeatAt?: string | null;
  /** `residual`:从最后已知存活到被下一个实例发现,中间静默了多久(ms)。 */
  silentMs?: number | null;
  diagnosis?: ResidualDiagnosis;
  /**
   * 诊断原文(陈旧原因、释放失败的 errno 等)。
   *
   * **可能含其它进程的完整命令行,里面可能有密钥** —— 只留在 0600 的账本里,
   * 永远不进公开响应。加字段时想清楚它属于这一侧还是 `publicExitSummary` 那一侧。
   */
  note?: string;
};

/**
 * 公开响应(`/api/health`)用的白名单投影。
 *
 * 健康端点是**免登录**的(`auth/middleware.ts` 把它列在放行名单里,多人模式同样
 * 放行),所以这里逐项选取字段、默认不带新字段:第 1 轮审查实测过未登录请求能从
 * `note` 里读到另一个进程命令行里的密钥。
 */
export type PublicExitSummary = {
  at: string;
  pid: number;
  kind: ExitKind;
  signal?: string;
  code?: number | null;
  uptimeMs?: number | null;
  lastHeartbeatAt?: string | null;
  silentMs?: number | null;
  diagnosis?: ResidualDiagnosis;
};

export function publicExitSummary(record: ExitRecord | null): PublicExitSummary | null {
  if (!record) return null;
  // 逐项列举 —— 不要改成展开 record 再 delete 几个字段:那样新加的内部字段默认是公开的。
  return {
    at: record.at,
    pid: record.pid,
    kind: record.kind,
    signal: record.signal,
    code: record.code,
    uptimeMs: record.uptimeMs,
    lastHeartbeatAt: record.lastHeartbeatAt,
    silentMs: record.silentMs,
    diagnosis: record.diagnosis,
  };
}

/** 锁 token → 账本里的 runId。单向,够用来做关联,不泄露凭证。 */
export function runIdOfToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

export function exitLedgerFileForDb(dbFile = resolveAshDbFile()): string {
  return `${dbFile}${LEDGER_SUFFIX}`;
}

/**
 * 上一次写入是不是停在了半行上(文件非空且结尾不是换行)。
 *
 * 不补这个换行的后果,第 1 轮审查实测过:坏尾行 `{"at":"unfinished` 后面直接接上
 * 新 JSON,两段粘成一行,解析时**连这条完整的新记录一起被跳过** —— 写坏一次就吞掉
 * 下一次。补一个换行把行边界还回来,坏的那半行自己占一行、被跳过就是了。
 */
function tailNeedsNewline(file: string): boolean {
  try {
    const { size } = statSync(file);
    if (size === 0) return false;
    const fd = openSync(file, "r");
    try {
      const tail = Buffer.alloc(1);
      readSync(fd, tail, 0, 1, size - 1);
      return tail[0] !== 0x0a;
    } finally {
      closeSync(fd);
    }
  } catch {
    return false; // 文件不在/读不了:没有要修的边界
  }
}

/** 追加一条。同步 + 吞异常:调用点在退出路径上。 */
export function recordExit(record: ExitRecord, dbFile = resolveAshDbFile()): void {
  const file = exitLedgerFileForDb(dbFile);
  try {
    const prefix = tailNeedsNewline(file) ? "\n" : "";
    appendFileSync(file, `${prefix}${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch {
    /* 账本写不进去不该影响退出本身 */
  }
}

function parseRecords(file: string): ExitRecord[] {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const records: ExitRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as ExitRecord;
      if (parsed && typeof parsed.at === "string" && typeof parsed.pid === "number") records.push(parsed);
    } catch {
      /* 半行/损坏行跳过:账本是诊断信息,不是真相来源 */
    }
  }
  return records;
}

/** 读出最近 N 条(最旧在前)。读不到就当没有 —— 它只是诊断信息。 */
export function readExitRecords(limit = KEEP_RECORDS, dbFile = resolveAshDbFile()): ExitRecord[] {
  return parseRecords(exitLedgerFileForDb(dbFile)).slice(-limit);
}

/** 这一轮启动留下过退出记录吗(从新往旧找)。残留锁的死因判定就靠它。 */
export function findExitByRunId(runId: string, dbFile = resolveAshDbFile()): ExitRecord | null {
  const records = parseRecords(exitLedgerFileForDb(dbFile));
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i]!;
    if (record.runId === runId && record.kind !== "residual") return record;
  }
  return null;
}

/**
 * 启动时裁剪,把账本钉在水位上。
 *
 * 两条都是第 1 轮审查打回来的:
 *   * **没超水位就一个字都不动**。原来每次取锁都整文件重写,等于把「刚刚写进去的
 *     那条关键记录」反复放进一个可能失败的写入里。
 *   * **临时文件写完再原子换**。`writeFileSync` 是先截断再写:实测在 `ulimit -f 0`
 *     下,82 字节的历史被截成 0、异常被 catch 吞掉、服务照常启动 —— 「裁剪失败只是
 *     文件偏大」这句注释跟真实结果正好相反。
 *
 * 另外:裁剪只在**持锁**期间跑(取锁成功之后才调),而退出记录现在也改成了**释放锁
 * 之前**追加,所以整文件重写不会盖掉另一个实例的并发追加。
 */
export function trimExitLedger(dbFile = resolveAshDbFile()): void {
  const file = exitLedgerFileForDb(dbFile);
  const temp = `${file}.trim`;
  try {
    const all = parseRecords(file);
    if (all.length <= KEEP_RECORDS) return;
    writeFileSync(temp, `${all.slice(-KEEP_RECORDS).map((r) => JSON.stringify(r)).join("\n")}\n`, { mode: 0o600 });
    renameSync(temp, file);
  } catch {
    // 原历史还在原地,这才是失败时该有的样子。
    try { rmSync(temp, { force: true }); } catch { /* 清不掉就留着,下次覆盖 */ }
  }
}

/** 把毫秒说成人话("2h14m"/"67s"),给终端那一行用。 */
export function humanDuration(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "未知";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}
