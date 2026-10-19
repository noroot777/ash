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
//   2. 下次启动发现锁还在,就拿锁里的 runId 回查账本,把**证据等级**报出来。
//
// 四条边界,全部是审查打回来的,每一条都别越:
//
//   * **进程内部的记录只是「退出意向」,不是最终终态**(第 2 轮)。那条记录写在释放锁
//     之前,写完之后照样可以被 SIGKILL 带走 —— 审查实测过:收到 SIGTERM、账本里记着
//     `kind=signal`,进程最终却是被 SIGKILL 结束的。所以残留锁旁边只报 `ExitEvidence`
//     (有没有留下退出意向),**不报死因**;最终死因要外部 wait 状态才说得清,ash 自己
//     拿不到。也不许再加一条「更晚的进程内标记」来假装终态被证明 —— 更晚的标记之后
//     同样有窗口。
//
//   * **`note` 可能含别的进程的完整命令行**(PID 被复用时 `staleLockReason` 会把 `ps`
//     读到的命令整段写进去),那里面可能带密钥(第 1 轮实测)。账本是 0600 的本地文件,
//     可以存;公开响应必须走 `publicExitSummary` 这个**白名单投影**,逐项选取字段,
//     而不是「以后每出现一种敏感 note 再补一条过滤」。
//
//   * **裁剪不许读-改-写**(第 2 轮)。这个文件是**跨进程**追加的:启动失败那条路
//     (`index.ts` 的 `exitAfterStartupFailure`)先松锁再 `process.exit`,退出钩子那条
//     记录因此是在**没有锁**的情况下追加的;取锁前的残留记账(`singleton.ts` 的
//     `reportResidualLock`)同样不持锁。原来的「读整文件 → 写临时文件 → rename」会把
//     快照之后的追加整段 rename 掉,审查用真实生产入口复现过:206 条变 200 条,刚写下
//     的那条退出记录消失。所以裁剪改成**只改名、不产生任何内容**(当前那份改成
//     `.1`),无论追加落在改名前的 inode 还是改名后的新文件,都不会丢 —— 这条不变量
//     不依赖任何跨进程加锁,也不依赖调用方的持锁生命周期。
//
//   * **每次追加自带记录边界**(第 2 轮)。原来靠「先读一次文件尾巴、缺换行就补」,
//     而读失败被当成「不需要补」:审查把账本设成 0200(可写不可读)就复现了 —— 追加
//     成功、新记录却和坏尾行粘成一行,解析时一起被跳过。现在前后各带一个 `\n`,解析
//     跳空行,写入安全不再以读成功为前提。
//
// 账本按 DB 走(预览实例各自一份)。写入一律 best-effort:它跑在退出路径上,绝不能
// 因为磁盘满/权限问题把退出本身搞崩。
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, renameSync } from "node:fs";
import { resolveAshDbFile } from "./db/path.js";

const LEDGER_SUFFIX = ".exits.jsonl";
/** 上一代账本:裁剪就是把当前这份改名成它。两代之外的才真正消失。 */
const ROTATED_SUFFIX = ".1";
/** 水位:当前那份超过这么多条就轮转。够看清「最近是不是反复出事」,又不会无限长。 */
const KEEP_RECORDS = 200;

export type ExitKind = "signal" | "exit" | "residual";

/**
 * 残留锁旁边能拿到的**证据等级** —— 注意它不是死因。
 *
 * - `exit_intent` 账本里有这一轮的退出记录:进程**进入过**退出流程(收到过可捕获的
 *   信号,或者跑过 `process.on("exit")`)。这条记录写在删锁之前,之后仍然可以被
 *   SIGKILL 带走,所以它**不能**排除强杀,也不能断定锁为什么还留着。
 * - `none`        账本里没有这一轮的任何记录。强杀、内核击杀都落在这一档,但「退出时
 *   连账本都没写进去」也落在这一档。
 *
 * 两档的共同结论都是**最终死因未知**;差别只在「有没有留下退出意向」。
 * 唯一能确定的事实是:锁还带着那一轮的 token ⇒ 那一轮的**清理确实没完成**。
 */
export type ExitEvidence = "exit_intent" | "none";

/** 账本里那条退出记录说了什么 —— 观察到的意向,不是终态。 */
export type ObservedIntent = {
  kind: ExitKind;
  signal?: string;
  code?: number | null;
  at: string;
};

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
   * - `signal`   收到可捕获的致命信号、处理器跑过(SIGTERM/SIGINT/SIGHUP/SIGQUIT)。
   *              **不等于进程最终以这个信号收场** —— 之后仍可能被强杀。
   * - `exit`     走到了 `process.on("exit")`(正常收场,或启动失败自杀)
   * - `residual` 下一次启动发现上一轮的锁还在(证据等级见 `evidence`)
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
  /** `residual`:证据等级。**不是死因** —— 见 `ExitEvidence`。 */
  evidence?: ExitEvidence;
  /** `residual` 且 `evidence==="exit_intent"`:账本里那条记录观察到了什么。 */
  observedIntent?: ObservedIntent;
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
  evidence?: ExitEvidence;
  observedIntent?: ObservedIntent;
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
    evidence: record.evidence,
    observedIntent: record.observedIntent,
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
 * 追加一条。同步 + 吞异常:调用点在退出路径上。
 *
 * 前后各带一个 `\n`,**不先去读文件尾巴**:上一次写到半行上时,那半行自己占一行被
 * 跳过,本次这条完整记录照样解析得出。靠「读尾巴补换行」的版本在可写不可读的账本上
 * 会把读失败当成「不需要补」,于是又粘回去(第 2 轮审查实测)。多出来的那个空行由
 * `parseRecords` 跳掉。
 */
export function recordExit(record: ExitRecord, dbFile = resolveAshDbFile()): void {
  try {
    appendFileSync(exitLedgerFileForDb(dbFile), `\n${JSON.stringify(record)}\n`, { mode: 0o600 });
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

/** 两代拼起来(旧在前)。轮转之后「最近的记录」会横跨两个文件,读的一侧必须都看。 */
function parseLedger(dbFile: string): ExitRecord[] {
  const file = exitLedgerFileForDb(dbFile);
  return [...parseRecords(`${file}${ROTATED_SUFFIX}`), ...parseRecords(file)];
}

/** 读出最近 N 条(最旧在前)。读不到就当没有 —— 它只是诊断信息。 */
export function readExitRecords(limit = KEEP_RECORDS, dbFile = resolveAshDbFile()): ExitRecord[] {
  return parseLedger(dbFile).slice(-limit);
}

/** 这一轮启动留下过退出意向吗(从新往旧找)。残留锁的证据等级就靠它。 */
export function findExitByRunId(runId: string, dbFile = resolveAshDbFile()): ExitRecord | null {
  const records = parseLedger(dbFile);
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i]!;
    if (record.runId === runId && record.kind !== "residual") return record;
  }
  return null;
}

/**
 * 启动时轮转,把账本钉在水位上。**只改名,不产生任何内容。**
 *
 * 这是第 2 轮审查之后的形状,理由见文件头第三条:账本是跨进程追加的(启动失败那条路
 * 先松锁、退出记录后到;取锁前的残留记账也不持锁),所以任何「读整文件 → 重写」都会
 * 把快照之后的追加吞掉 —— 审查用真实生产入口复现过 206 → 200。改名没有这个窗口:
 * 追加落在改名前的 inode 就跟着进 `.1`,落在改名后就进新文件,两种交错都读得到。
 *
 * 代价是磁盘上最多留两代(稳态 ≤ 2×水位),以及最旧那一代在下次轮转时被覆盖 —— 那是
 * 裁剪本来就要做的事。换来的是「裁剪永不删除任何已经落盘的记录」这条不依赖加锁的
 * 不变量,所以它也不要求调用方在持锁期间调用。
 */
export function rotateExitLedger(dbFile = resolveAshDbFile()): void {
  const file = exitLedgerFileForDb(dbFile);
  try {
    if (parseRecords(file).length <= KEEP_RECORDS) return;
    renameSync(file, `${file}${ROTATED_SUFFIX}`);
  } catch {
    // 读不了/改不了名:账本偏大而已,内容一个字节都没动。
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
