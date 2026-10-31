// 熔断判决的**落盘事实**:一个挨着库文件放的追加式日志。
//
// 为什么判决不能只写库那一格(第 1 轮审查 F1,已实测两个独立消费进程):
// `dbClient.execute` 的写要过 `whenIdle`(见 db/node-sqlite-client.ts 的注释:写不许借别人
// 的事务)。别人开着一笔长事务时,这条 UPDATE **排在队里等**,既没抛错也没落盘。而判决作出
// 之后紧接着就是不可撤销的两件事 —— 时间线上写「已终止本回合并按失败结算」、向执行器发终止
// 请求。消费者要是在这段窗口里退出(server 被杀、重启),排着的那笔写和内存里那份判决一起
// 消失;下一个进程读到 `stall_reason=NULL`,把它解释成「这一轮没熔断过」,于是不再兑现终止
// 义务,上游一恢复又能把这一轮写成 `completed`、任务落 `done`。
//
// 根上错的那条判据是:**「调了持久化函数」被当成了「事实已经持久」**。所以这里把事实挪到一个
// 不可能排在别人事务后面的地方 —— 另一个文件、同步写、写完 fsync。库里那一格仍然写,但它从此
// 只是**给界面和接口读的投影**(`turn-stall-persist.ts` 的 `projectStallVerdictToDb`),不再是
// 判决的依据。判决作出 → 这里落盘 → 才动手终止,这个顺序由 `turn-stall.ts` 的 trip 保证。
//
// 账本形状照 `exit-ledger.ts` 抄,那几条是它被审查打回来换的,别再走一遍:
//   · **裁剪只改名、不产生内容**。读-改-写会把快照之后的追加整段吞掉(那边实测 206 → 200)。
//   · **每次追加自带前后换行**,不先去读文件尾巴补 —— 读失败会被当成「不需要补」,于是新记录
//     和坏尾行粘成一行,解析时一起被跳过。
//   · 两代拼起来读:轮转之后「最近的记录」横跨两个文件。
//
// 耐受边界,别把它说大:同步写 + fsync 挡得住的是**进程退出**(这正是 F1 那条路);机器掉电
// 的那一瞬连 SQLite 的 WAL 也一样暴露,这里不冒充更强的保证。fsync 本身失败不让整笔作废 ——
// 字节已经交给内核了,下一个进程照样读得到。
import { appendFileSync, closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { resolveAshDbFile } from "./db/path.js";
import { now } from "./util.js";

const JOURNAL_SUFFIX = ".stall-verdicts.jsonl";
/** 上一代:裁剪就是把当前这份改名成它。两代之外的才真正消失。 */
const ROTATED_SUFFIX = ".1";
/**
 * 水位。一次熔断一条,而熔断本身是「上游连不上几十分钟」才会发生的事,所以这个数远比实际
 * 需要的大;给足是因为**排在这里的记录可能还有人要读**(没收口的回合),宁可文件偏大。
 */
const KEEP_RECORDS = 200;

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

export function stallJournalFileForDb(dbFile = resolveAshDbFile()): string {
  return `${dbFile}${JOURNAL_SUFFIX}`;
}

/**
 * 追加一条并落盘。**返回值就是「这个事实现在存住了没有」** —— 调用方拿它决定要不要在
 * 用户看到的诊断里如实说一句「重启会丢」,所以这里不许吞掉失败再报成功。
 */
export function appendStallVerdict(record: StallVerdictRecord, dbFile = resolveAshDbFile()): boolean {
  const line = `\n${JSON.stringify(record)}\n`;
  try {
    const fd = openSync(stallJournalFileForDb(dbFile), "a", 0o600);
    try {
      writeSync(fd, line);
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

function parseRecords(file: string): StallVerdictRecord[] {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const records: StallVerdictRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as StallVerdictRecord;
      if (parsed && typeof parsed.sessionId === "string" && typeof parsed.turnStartedAt === "string"
        && typeof parsed.reason === "string") {
        records.push(parsed);
      }
    } catch {
      /* 半行/损坏行跳过 */
    }
  }
  return records;
}

/** 两代拼起来(旧在前)。 */
function parseJournal(dbFile: string): StallVerdictRecord[] {
  const file = stallJournalFileForDb(dbFile);
  return [...parseRecords(`${file}${ROTATED_SUFFIX}`), ...parseRecords(file)];
}

/**
 * 这个回合身份落盘过判决吗(从新往旧找,同一身份只认最后那条)。
 *
 * **读失败一律当成「没有」**:这里是个纯读,读不出来就只能回到库那一格。真正不能混的是
 * 反过来那一侧 —— 见 `turn-stall-persist.ts` 的 `restoreStallVerdict`。
 */
export function readStallVerdict(
  sessionId: string,
  turnStartedAt: string,
  dbFile = resolveAshDbFile(),
): StallVerdictRecord | null {
  const records = parseJournal(dbFile);
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i]!;
    if (record.sessionId === sessionId && record.turnStartedAt === turnStartedAt) return record;
  }
  return null;
}

/**
 * 启动时轮转,把日志钉在水位上。**只改名,不产生任何内容**(理由见文件头第一条)。
 *
 * 不做「按回合挑掉已收口的那些」:那正是读-改-写。收口过的记录不会被误用 ——
 * `restoreStallVerdict` 的判据是「有判决 **且** 这一行还没收口」。
 */
export function rotateStallJournal(dbFile = resolveAshDbFile()): void {
  const file = stallJournalFileForDb(dbFile);
  try {
    if (parseRecords(file).length <= KEEP_RECORDS) return;
    renameSync(file, `${file}${ROTATED_SUFFIX}`);
  } catch {
    // 读不了/改不了名:日志偏大而已,内容一个字节都没动。
  }
}

/** 只给回归测试:直接追加一条(不经 fsync 那条路),用来铺两代之间的历史。 */
export function __seedStallVerdict(record: Partial<StallVerdictRecord>, dbFile: string): void {
  const at = record.at ?? now();
  const full: StallVerdictRecord = {
    at, sessionId: record.sessionId ?? "s", turnStartedAt: record.turnStartedAt ?? "t",
    reason: record.reason ?? "seed", since: record.since ?? at,
  };
  appendFileSync(stallJournalFileForDb(dbFile), `\n${JSON.stringify(full)}\n`, { mode: 0o600 });
}
