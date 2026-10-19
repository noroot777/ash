// 服务端「上一次是怎么停的」账本。
//
// 2026-10-19 排查「ash 又停了」时发现:进程消失这件事在机器上**一点痕迹都没有**。
// 不是 JS 崩溃(兜底 handler 会打印)、不是 V8 OOM(会打印 FATAL ERROR)、不是原生崩溃
// (会在 ~/Library/Logs/DiagnosticReports 留 .ips)、不是 jetsam(会留 JetsamEvent)、
// 也不是 `npm run restart`(只发 SIGTERM,那条路会删掉单例锁)。唯一的线索是单例锁文件
// 被留在原地,以及 mDNSResponder 日志里一条「DNSServiceCreateConnection STOP PID[…]」
// —— 靠系统日志反推死亡时刻,这不是个能长期依赖的取证手段。
//
// 所以把两件事做进系统:
//   1. 每条**自己走过**的退出路径都记一条(带信号名和运行时长);
//   2. 下次启动发现锁还在 = 上一实例一条退出路径都没走过,记一条 `vanished`,
//      并用锁文件里的心跳给出死亡时刻。
//
// 账本按 DB 走(预览实例各自一份),只追加、启动时裁剪。写入一律 best-effort:
// 它跑在退出路径上,绝不能因为磁盘满/权限问题把退出本身搞崩。
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolveAshDbFile } from "./db/path.js";

const LEDGER_SUFFIX = ".exits.jsonl";
/** 裁剪水位:够看清「最近是不是反复出事」,又不会无限长。 */
const KEEP_RECORDS = 200;

export type ExitRecord = {
  /** 写下这条记录的时刻(ISO)。 */
  at: string;
  /** 这条记录说的是哪个进程。 */
  pid: number;
  /**
   * - `signal`   收到可捕获的致命信号后主动退出(SIGTERM/SIGINT/SIGHUP/SIGQUIT)
   * - `exit`     走完 `process.on("exit")`(正常收场,或启动失败自杀)
   * - `vanished` 下一次启动时发现:上一实例一条退出路径都没走过
   */
  kind: "signal" | "exit" | "vanished";
  signal?: string;
  code?: number | null;
  /** 这个进程活了多久(ms)。`vanished` 用锁文件里的启动时间算。 */
  uptimeMs?: number | null;
  /** `vanished`:最后一次刷心跳的时刻 —— 死亡时刻的上界。 */
  lastHeartbeatAt?: string | null;
  /** `vanished`:从最后心跳到被下一个实例发现,中间静默了多久(ms)。 */
  silentMs?: number | null;
  /** 人话版本,直接可以打在终端上。 */
  note?: string;
};

export function exitLedgerFileForDb(dbFile = resolveAshDbFile()): string {
  return `${dbFile}${LEDGER_SUFFIX}`;
}

/** 追加一条。同步 + 吞异常:调用点在退出路径上。 */
export function recordExit(record: ExitRecord, dbFile = resolveAshDbFile()): void {
  try {
    appendFileSync(exitLedgerFileForDb(dbFile), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch {
    /* 账本写不进去不该影响退出本身 */
  }
}

/** 读出最近 N 条(最旧在前)。读不到就当没有 —— 它只是诊断信息。 */
export function readExitRecords(limit = KEEP_RECORDS, dbFile = resolveAshDbFile()): ExitRecord[] {
  let text = "";
  try {
    text = readFileSync(exitLedgerFileForDb(dbFile), "utf8");
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
  return records.slice(-limit);
}

/** 启动时裁剪,把账本钉在水位上。 */
export function trimExitLedger(dbFile = resolveAshDbFile()): void {
  try {
    const records = readExitRecords(KEEP_RECORDS, dbFile);
    if (!records.length) return;
    writeFileSync(
      exitLedgerFileForDb(dbFile),
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      { mode: 0o600 },
    );
  } catch {
    /* 裁剪失败只是文件偏大,不值得影响启动 */
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
