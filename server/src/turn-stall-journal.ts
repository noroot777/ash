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
//     整个撤掉,只剩 `compactStallJournal`。
//
//   · **「结算完了」只能由结算自己说,不能由回合区间的开闭代替**(第 1 轮审查 F1,已实测两个
//     独立消费进程)。上一版的判据是「`session_turns.ended_at` 非空 ⇒ 还有读者没了 ⇒ 可以扔」,
//     而区间收口只证明**执行流**结束了:单飞那条链先落区间(`single-run.ts`),之后还要补录
//     MCP、保存持续目标,再隔着好几个 await 才轮到任务结算。进程在这段窗口里退出,盘上留下的
//     就是「区间已 failed、任务仍 running」—— 下次启动压缩按那个代理指标把判决删掉,恢复又只
//     枚举还开着的区间,于是一个已经提示过「已自动终止」的持续目标回来显示「暂停中 + 继续」。
//     所以这个日志自己记**两种**记录:判决,和**销账**(`kind: "discharged"`)。销账由
//     `clearStallFailure` 这个唯一出口追加(`turn-stall-verdict.ts`),而它只在三条消费链各自
//     写完结局之后才被调到 —— 判据于是变成「权威结算确认过」这件事本身,不再是任何代理指标。
import {
  closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import type { ModelFailure } from "@ash/shared";
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
  /** 卡住它的那条错误的模型 API 类型(StallVerdict.model)。旧记录没有 = 认不出。 */
  model?: ModelFailure | null;
}

/**
 * 一条**销账**:这个回合身份的判决已经被权威结算读过并兑现了,日志可以不再留着它。
 *
 * 为什么销账也要落盘、而不是压缩时现算一个判据出来:见文件头第四条。唯一有资格说这句话的是
 * `clearStallFailure`(`turn-stall-verdict.ts` 里判决回收的唯一出口),它在三条消费链各自写完
 * 结局之后被调到 —— 于是「可以回收了」这件事跟「结算完了」是同一个事实,而不是它的影子。
 */
export interface StallDischargeRecord {
  kind: "discharged";
  at: string;
  sessionId: string;
  turnStartedAt: string;
}

/**
 * 读一次日志的结果。**两档必须分开**,理由见文件头第一条:
 * - `ok`:确实读完了。两个清单都可能是空的 —— 那是「没有判决」这个事实本身。
 * - `unavailable`:有东西读不出来(权限、I/O、半行坏记录)。**不是**「没有判决」。
 *
 * `verdicts` 和 `discharges` 分开给:调用方几乎总是只关心「还没销账的判决有哪些」,而那是
 * 两个清单相减的结果 —— 混在一个数组里交出去,每个读取点都得自己记得过滤一遍。
 */
export type StallJournalRead =
  | { status: "ok"; verdicts: StallVerdictRecord[]; discharges: StallDischargeRecord[] }
  | { status: "unavailable"; why: string; verdicts: StallVerdictRecord[]; discharges: StallDischargeRecord[] };

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
  return appendLine(record, dbFile);
}

/**
 * 追加一条销账。**不抛** —— 它排在结算之后,这一刻掀翻收尾只会把一个已经落好位的任务搞坏。
 *
 * 写失败的后果是「日志里多留一条已经没人要的判决」:下次启动它会被装回内存,启动对账据此
 * 再念一遍那句诊断。那是**偏保守的一侧**(宁可重复说一次,也不要把一条还有人要读的判决抹掉),
 * 但也不许静默 —— 日志里要留下这一笔,否则「为什么重启后又说了一遍」查不出来。
 */
export function appendStallDischarge(
  sessionId: string,
  turnStartedAt: string,
  dbFile = resolveAshDbFile(),
): boolean {
  const ok = appendLine({ kind: "discharged", at: now(), sessionId, turnStartedAt }, dbFile);
  if (!ok) {
    console.warn(`[ash] 熔断判决的销账没能落盘(会话 ${sessionId} 回合 ${turnStartedAt}):`
      + "这一条判决会留在日志里,下次启动还会被读回来");
  }
  return ok;
}

function appendLine(record: StallVerdictRecord | StallDischargeRecord, dbFile: string): boolean {
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
    console.warn(`[ash] 熔断判决日志没能追加(会话 ${record.sessionId} 回合 ${record.turnStartedAt}):`, error);
    return false;
  }
}

type ParseResult = { verdicts: StallVerdictRecord[]; discharges: StallDischargeRecord[]; why: string | null };

function parseRecords(file: string): ParseResult {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    // 缺文件 = 确实没有判决(第一次跑、或者已经压缩掉了),那是 `ok`。其余一切都是读不出来。
    if ((error as { code?: string }).code === "ENOENT") return { verdicts: [], discharges: [], why: null };
    return { verdicts: [], discharges: [], why: `${file} 读不出来:${String(error)}` };
  }
  const verdicts: StallVerdictRecord[] = [];
  const discharges: StallDischargeRecord[] = [];
  let damaged = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<StallVerdictRecord & StallDischargeRecord>;
      const identified = parsed && typeof parsed.sessionId === "string" && typeof parsed.turnStartedAt === "string";
      if (identified && parsed.kind === "discharged") {
        discharges.push({ kind: "discharged", at: String(parsed.at ?? ""), sessionId: parsed.sessionId!, turnStartedAt: parsed.turnStartedAt! });
      } else if (identified && typeof parsed.reason === "string") {
        verdicts.push(parsed as StallVerdictRecord);
      } else {
        damaged += 1;
      }
    } catch {
      // **坏行不许静默跳过**:那是一份读不出来的判决,正是「核实不了」而不是「没有」。
      damaged += 1;
    }
  }
  return { verdicts, discharges, why: damaged ? `${file} 有 ${damaged} 条记录读不出来(半行/损坏)` : null };
}

/**
 * 读出全部记录。两代拼起来(旧在前)—— `.1` 是上一版按条数轮转留下的,只读不写。
 *
 * 任何一代读不出来,整次读都是 `unavailable`:读得出来的那部分照样带上(能救一条算一条),
 * 但「有东西核实不了」这件事必须传出去。
 */
export function readStallJournal(dbFile = resolveAshDbFile()): StallJournalRead {
  const file = stallJournalFileForDb(dbFile);
  const old = parseRecords(`${file}${ROTATED_SUFFIX}`);
  const current = parseRecords(file);
  const verdicts = [...old.verdicts, ...current.verdicts];
  const discharges = [...old.discharges, ...current.discharges];
  const why = [old.why, current.why].filter(Boolean).join(";");
  return why ? { status: "unavailable", why, verdicts, discharges } : { status: "ok", verdicts, discharges };
}

/** 回合身份在这个日志里的键 —— 内存那张表用的是同一个口径(`turn-stall-verdict.ts`)。 */
export function stallIdentityKey(sessionId: string, turnStartedAt: string): string {
  return `${sessionId}\u0000${turnStartedAt}`;
}

/** 还没销账的那些判决 —— 日志的**唯一**有效读法,两个清单相减这一步不许摊给调用方各写一遍。 */
export function pendingStallVerdicts(read: StallJournalRead): StallVerdictRecord[] {
  const discharged = new Set(read.discharges.map((r) => stallIdentityKey(r.sessionId, r.turnStartedAt)));
  return read.verdicts.filter((r) => !discharged.has(stallIdentityKey(r.sessionId, r.turnStartedAt)));
}

/**
 * 压缩:把日志重写成**只剩还没销账的判决**。
 *
 * 判据整个长在这一层,不再由调用方交进来一个回调(上一版是「问库:这个回合行还开着吗」)——
 * 那个形状本身就是缺陷的温床:判据住在外面,这一层就不认识「结算」这个概念,于是外面随手换成
 * 一个更好拿到的代理指标(区间收口)也没有任何东西拦得住。现在销账是日志自己的记录,规则只有
 * 一句:**销账记录和它销掉的那条判决一起扔,剩下的留着**。
 *
 * 这里是读-改-写,而 `exit-ledger.ts` 明令禁止那种写法 —— 差别在**有没有并发追加者**:
 * 那个账本是跨进程追加的(启动失败那条路先松锁、退出记录后到;取锁前的残留记账也不持锁),
 * 所以它只能改名。这个日志只有 ash 自己在追加,而 ash 对同一个库文件是单实例的
 * (`singleton.ts`,锁在 index.ts 里排在这之前),并且压缩只在启动期跑、那一刻连一条消费链都
 * 还没有。两条前提缺一不可,挪动调用点之前先回来看这一段。
 *
 * 不抛:压缩失败只是日志偏大,一个字节都没丢。
 */
export function compactStallJournal(dbFile = resolveAshDbFile()): { kept: number; dropped: number } | null {
  const file = stallJournalFileForDb(dbFile);
  const read = readStallJournal(dbFile);
  // 有东西读不出来就别重写:那会把读不出来的那部分真正抹掉(把「核实不了」变成「没有」)。
  if (read.status === "unavailable") {
    console.warn(`[ash] 熔断判决日志有内容读不出来,这次不压缩:${read.why}`);
    return null;
  }
  const survivors = pendingStallVerdicts(read);
  const total = read.verdicts.length + read.discharges.length;
  // 一条都不用清、也没有上一代要合并 ⇒ 不写。省的不是 I/O,是一个没有收益的失败窗口。
  if (survivors.length === total && !existsSync(`${file}${ROTATED_SUFFIX}`)) {
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
    return { kept: survivors.length, dropped: total - survivors.length };
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
