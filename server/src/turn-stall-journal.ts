// 熔断判决的**落盘事实**:一个挨着库文件放的追加式日志。
//
// 为什么判决不能只写库那一格(第 4 轮审查 F1,已实测两个独立消费进程):
// `dbClient.execute` 的写要过 `whenIdle`(见 db/node-sqlite-client.ts 的注释:写不许借别人
// 的事务)。别人开着一笔长事务时,这条 UPDATE **排在队里等**,既没抛错也没落盘。而判决作出
// 之后紧接着就是不可撤销的两件事 —— 时间线上写「已终止本回合并按失败结算」、向执行器发终止
// 请求。消费者要是在这段窗口里退出(server 被杀、重启),排着的那笔写和内存里那份判决一起
// 消失;下一个进程读到 `stall_reason=NULL`,把它解释成「这一轮没熔断过」,于是不再兑现终止
// 义务,上游一恢复又能把这一轮写成 `completed`、任务落 `done`。
//
// 根上错的那条判据是:**「调了持久化函数」被当成了「事实已经持久」**。所以这里把事实挪到一个
// 不可能排在别人事务后面的地方 —— 另一个文件、同步写、写完 fsync。
//
// 三条本模块自己的不变量,都是审查换来的,别再走回头路:
//
//   · **「读不出来」不等于「没有判决」**(第 5 轮审查 F1,已实测)。上一版 `parseRecords` 把
//     所有读取异常折成 `[]`,于是日志不可读(EACCES/EIO)跟「压根没熔断过」在调用方眼里一模
//     一样,恢复入口据此放过去,上游一恢复这一轮就升级成成功。所以读的接口报的是
//     `ok` / `unavailable` 两档:缺文件才是 `ok`(那确实是「没有」),其余一切 —— 权限、I/O、
//     **半行坏记录** —— 都是 `unavailable`:有判决而我们核实不了。怎么处置由恢复侧决定
//     (`turn-stall-persist.ts`),但绝不许在这一层把它化简成「没有」。
//
//   · **写进去多少字节要自己数**(第 5 轮审查 F4)。`writeSync` 返回实际写入量,磁盘/配额快
//     满时短写**不一定抛异常**。上一版忽略返回值,照样 fsync、照样报成功,于是日志里留下半条
//     JSON(读端跳过)、而判决已经被标成 durable —— 时间线上那句「没存完整、重启会丢」的降级
//     说明也就不会出现。现在整条写完才算成功,写不完就报失败。
//
//   · **回收的条件是「这一轮已经结算完」,不是条数也不是年龄**(第 5 轮审查 F2,已实测)。
//     上一版按 200 条轮转、第二代直接覆盖第一代,而被覆盖的那些里完全可能有**还没结算**的
//     判决 —— `rename` 原子、不读改写,这两点都不能证明上一代已经没人需要。所以条数那一档
//     整个撤掉,只剩 `compactStallJournal`:判据是**回合行还开着**(没收口 ⇒ 还有读者 ⇒ 留着)。
import {
  closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { resolveAshDbFile } from "./db/path.js";
import { now } from "./util.js";

const JOURNAL_SUFFIX = ".stall-verdicts.jsonl";
/** 上一代:上一版按条数轮转留下的那份。只读,给已经升级过来的实例兜一次。 */
const ROTATED_SUFFIX = ".1";

/** 一条判决。字段只有判决本身要的那几个 —— 这个文件不是诊断日志,是事实来源。 */
export interface StallVerdictRecord {
  at: string;
  sessionId: string;
  turnStartedAt: string;
  /** 熔断诊断那一段原文,结算侧需要时转述。 */
  reason: string;
  /**
   * 这一次停滞的起点。接管那一路要拿它还原停滞记录 —— 持久标记的 CAS 认的是这个身份
   * (`session-stall-flag.ts`),所以它必须跟着判决一起落盘,不能由接管那一刻现编。
   * 读的一侧按可选处理:退回 `at` 是诚实的退路(撤不掉旧标记,但也碰不到别人的)。
   */
  since?: string;
}

/**
 * 读一次日志的结果。**两档必须分开**,理由见文件头第一条:
 * - `ok`:确实读完了。`records` 可能是空的 —— 那是「没有判决」这个事实本身。
 * - `unavailable`:有东西读不出来(权限、I/O、半行坏记录)。**不是**「没有判决」。
 */
export type StallJournalRead =
  | { status: "ok"; records: StallVerdictRecord[] }
  | { status: "unavailable"; why: string; records: StallVerdictRecord[] };

export function stallJournalFileForDb(dbFile = resolveAshDbFile()): string {
  return `${dbFile}${JOURNAL_SUFFIX}`;
}

/**
 * 追加一条并落盘。**返回值就是「这个事实现在存住了没有」** —— 调用方拿它决定要不要在
 * 用户看到的诊断里如实说一句「重启会丢」,所以这里不许吞掉失败再报成功。
 *
 * 整条写完才算成功(文件头第二条):短写补写,补不完就抛,由下面那个 catch 报 false。
 * fsync 自己失败不让整笔作废 —— 字节已经交给内核了,下一个进程照样读得到;挡不住的是机器
 * 掉电那一瞬,而那一刻连 SQLite 的 WAL 也一样暴露,这里不冒充更强的保证。
 */
export function appendStallVerdict(record: StallVerdictRecord, dbFile = resolveAshDbFile()): boolean {
  const line = Buffer.from(`\n${JSON.stringify(record)}\n`, "utf8");
  try {
    const fd = openSync(stallJournalFileForDb(dbFile), "a", 0o600);
    try {
      let written = 0;
      while (written < line.length) {
        const n = writeSync(fd, line, written, line.length - written);
        // 写不动了(配额/磁盘满常常是短写而不是抛错):如实失败,别把半条记录报成已保存。
        if (n <= 0) throw new Error(`短写:只写进 ${written}/${line.length} 字节`);
        written += n;
      }
      try {
        fsyncSync(fd);
      } catch {
        // 字节已经进了内核(下一个进程读得到),只是没强制刷盘 —— 不该让整笔作废。
      }
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (error) {
    console.warn(`[ash] 熔断判决没能落盘(会话 ${record.sessionId} 回合 ${record.turnStartedAt}):`, error);
    return false;
  }
}

type ParseResult = { records: StallVerdictRecord[]; why: string | null };

function parseRecords(file: string): ParseResult {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    // 缺文件 = 确实没有判决(第一次跑、或者已经压缩掉了),那是 `ok`。其余一切都是读不出来。
    if ((error as { code?: string }).code === "ENOENT") return { records: [], why: null };
    return { records: [], why: `${file} 读不出来:${String(error)}` };
  }
  const records: StallVerdictRecord[] = [];
  let damaged = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as StallVerdictRecord;
      if (parsed && typeof parsed.sessionId === "string" && typeof parsed.turnStartedAt === "string"
        && typeof parsed.reason === "string") {
        records.push(parsed);
      } else {
        damaged += 1;
      }
    } catch {
      // **坏行不许静默跳过**:那是一份读不出来的判决,正是「核实不了」而不是「没有」。
      damaged += 1;
    }
  }
  return { records, why: damaged ? `${file} 有 ${damaged} 条记录读不出来(半行/损坏)` : null };
}

/**
 * 读出全部判决。两代拼起来(旧在前)—— `.1` 是上一版按条数轮转留下的,只读不写。
 *
 * 任何一代读不出来,整次读都是 `unavailable`:读得出来的那部分照样带上(能救一条算一条),
 * 但「有东西核实不了」这件事必须传出去。
 */
export function readStallJournal(dbFile = resolveAshDbFile()): StallJournalRead {
  const file = stallJournalFileForDb(dbFile);
  const old = parseRecords(`${file}${ROTATED_SUFFIX}`);
  const current = parseRecords(file);
  const records = [...old.records, ...current.records];
  const why = [old.why, current.why].filter(Boolean).join(";");
  return why ? { status: "unavailable", why, records } : { status: "ok", records };
}

/**
 * 压缩:把日志重写成**只剩还有读者的那些**。判据由调用方给(`turn-stall-persist.ts` 问库:
 * 这个回合行还开着吗),所以这一层不认识「结算」这个概念,也就不会偷偷把它换成条数或年龄。
 *
 * 这里是读-改-写,而 `exit-ledger.ts` 明令禁止那种写法 —— 差别在**有没有并发追加者**:
 * 那个账本是跨进程追加的(启动失败那条路先松锁、退出记录后到;取锁前的残留记账也不持锁),
 * 所以它只能改名。这个日志只有 ash 自己在追加,而 ash 对同一个库文件是单实例的
 * (`singleton.ts`,锁在 index.ts 里排在这之前),并且压缩只在启动期跑、那一刻连一条消费链都
 * 还没有。两条前提缺一不可,挪动调用点之前先回来看这一段。
 *
 * 不抛:压缩失败只是日志偏大,一个字节都没丢。
 */
export function compactStallJournal(
  keep: (record: StallVerdictRecord) => boolean,
  dbFile = resolveAshDbFile(),
): { kept: number; dropped: number } | null {
  const file = stallJournalFileForDb(dbFile);
  const read = readStallJournal(dbFile);
  // 有东西读不出来就别重写:那会把读不出来的那部分真正抹掉(把「核实不了」变成「没有」)。
  if (read.status === "unavailable") {
    console.warn(`[ash] 熔断判决日志有内容读不出来,这次不压缩:${read.why}`);
    return null;
  }
  const survivors = read.records.filter(keep);
  // 一条都不用清、也没有上一代要合并 ⇒ 不写。省的不是 I/O,是一个没有收益的失败窗口。
  if (survivors.length === read.records.length && !existsSync(`${file}${ROTATED_SUFFIX}`)) {
    return { kept: survivors.length, dropped: 0 };
  }
  const temp = `${file}.compact`;
  try {
    writeFileSync(temp, survivors.map((r) => `\n${JSON.stringify(r)}\n`).join(""), { mode: 0o600 });
    renameSync(temp, file);
    try {
      unlinkSync(`${file}${ROTATED_SUFFIX}`);
    } catch {
      // 上一代不在就算了(多半压根没有过)。
    }
    return { kept: survivors.length, dropped: read.records.length - survivors.length };
  } catch (error) {
    console.warn("[ash] 压缩熔断判决日志失败(内容没动):", error);
    try {
      unlinkSync(temp);
    } catch { /* 临时文件可能压根没建出来 */ }
    return null;
  }
}

/** 只给回归测试:直接追加一条,用来铺历史。 */
export function __seedStallVerdict(record: Partial<StallVerdictRecord>, dbFile: string): void {
  const at = record.at ?? now();
  appendStallVerdict({
    at, sessionId: record.sessionId ?? "s", turnStartedAt: record.turnStartedAt ?? "t",
    reason: record.reason ?? "seed", since: record.since ?? at,
  }, dbFile);
}
