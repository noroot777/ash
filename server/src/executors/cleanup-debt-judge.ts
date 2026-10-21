// **「这一行此刻该怎么处置」—— 清理责任的判定层。**
//
// 从 `cleanup-debt.ts` 拆出来的理由是职责:那一份现在只管**账本的读写**(落账、推进、销账、
// 收档、披露,以及落库失败时在内存里接着扛的那两摊),而「按行上的线索重新取证、这一刻算
// 不算空」是另一件事 —— 它一条数据库都不写,却是整张表唯一的判据来源。两件事挤在一个文件
// 里时那份已经 747 行,接近单文件上限,每次改判据都要把账本那一半一起塞进上下文。
//
// 判空的代数(四档答案、两个问、合取规则)在 `cleanup-result.ts`;**这一份只负责把这张表
// 行上的那几条线索各自问成一个答案**,然后交给那边合。线索与问的对应:
//
//   根   —— 行上记的 `root_pid` + `root_started_at`(见 `rootResidue`);
//   后代 —— 资源记号(`unit_token`)、追踪文件、这一次运行独有的输出文件。
//
// 第 4 轮审查 F1 实测的那一下就出在这里:上一版只合并了后代那两台设备,而 Windows 上它们
// **结构性答不了**、却各自返回「没有残留」——「根」这一问压根没人问。于是一行记着活根进程
// 的责任在重试清扫里被真的 DELETE 掉(settled=1、行 0 笔、同一个 pid 仍 alive、写文件计数
// 78→83)。所以这一份的两条硬规矩:
//
//  ① 设备不存在就**不发言**(返回 `null`),不许交一张「已经空了」的证书;
//  ② 「这一次查询失败」和「这台机器/这一行永远答不了」要分开 —— 前者该重试,后者该收档。
import { isPidAlive } from "../platform.js";
import { processGenerationSync } from "../process-generation.js";
import { processIdentity, processUnitEvidence, type UnitEvidence } from "../proc.js";
import { monitorUnitAnswerable } from "../monitor-unit-scan.js";
import { agentCleanupDebts } from "../db/schema.js";
import { describeEvidence } from "./escapees.js";
import {
  fileHoldersAnswerable, holderScanFault, probeFileHolders, type HolderProbe,
} from "./track-evidence.js";
import {
  cleanupRetriable, describeOpen, judgeByClues, mergeClueAnswers, residueFromProbe,
  type CleanupOpen, type CleanupResult, type ClueAnswer,
} from "./cleanup-result.js";

export type DebtRow = typeof agentCleanupDebts.$inferSelect;

/**
 * 定位这一次运行的那几条线索 —— **记一笔和销一笔必须按同一套线索算键**。
 *
 * 销账那一侧上一版只交了个记号,于是没有记号的那些行(键是 `no-unit:<路径>`)永远对不上,
 * 一旦欠过就再也销不掉,披露面上堆着一笔其实早就空了的账(第 3 轮审查 N8)。
 */
export type CleanupDebtClues = {
  /** `null` = 这一次运行没有记号(升级前建的老会话行)⇒ 退回路径线索当键,见 `debtKey`。 */
  unitToken: string | null;
  trackPath?: string | null;
  outPath?: string | null;
};

/**
 * 这一笔记在哪个键上。
 *
 * 首选记号 —— 它是这一次运行独有的身份,而且清扫侧能靠它重新取证。**没有记号时不是直接
 * 放弃**:升级前建的那些会话行就没有这一列,可它们同样会留下后代,而路径线索(这一次
 * 运行独有的输出文件 / 追踪文件)对它们仍然有效 —— 清扫问得出「还有没有人握着」,
 * 只是问不出「那个号是谁」。留一行能追的,比什么都不留强。
 *
 * 三条线索都没有才返回 `null`:那种记录追不出任何东西,记下来只会让披露面永久积压一条
 * 谁也处置不了的行(失败桩、没有真实进程的合成句柄就属于这一类)。
 */
export function debtKey(clues: CleanupDebtClues): string | null {
  if (clues.unitToken) return clues.unitToken;
  const path = clues.outPath || clues.trackPath;
  return path ? `${NO_UNIT_PREFIX}${path}` : null;
}

/** 键前缀:这一行没有记号,清扫侧据此知道「别拿记号那一问当判据」。 */
const NO_UNIT_PREFIX = "no-unit:";

/**
 * 按行上现有的线索重新取证,得到这一刻的结论。销账与推进共用它 —— 判据只有一处。
 *
 * **三台设备分属两个问**(判空的不变量见 cleanup-result.ts 顶部):行上记的根身份答「根」,
 * 资源记号与两个运行专属文件答「后代」。第 4 轮审查 F1 实测的那一下就是这里少了根这一问 ——
 * Windows 上后代那两台设备结构性答不了,各自返回「没有残留」,合并出来是「已经证明清空」,
 * 于是一行**记着活根进程**的责任被真的 DELETE 掉了。设备不存在的那几档一律**不发言**
 * (返回 `null`),让那一问自己说出「没有证据来源」。
 */
export type JudgedDebt = {
  marked: boolean; after: UnitEvidence; clues: PathClues;
  result: CleanupResult;
  /** 还有没有「下一轮可能换答案」的那种线索(只有这一次查询失败算)。 */
  retriable: boolean;
};

export async function judgeDebtRow(row: DebtRow): Promise<JudgedDebt> {
  const marked = isMarked(row.unitToken);
  const after = processUnitEvidence(marked ? row.unitToken : null, { fresh: true });
  const clues = await probeDebtPaths(row);
  const root = rootResidue(row);
  const marker = markerResidue(after, marked);
  const paths = pathResidue(clues);
  const held = openResidue(row.openMembers);
  const answers: ClueAnswer[] = [{ subject: "root", answer: root }];
  for (const answer of [marker, paths, held.answer]) {
    if (answer) answers.push({ subject: "descendants", answer });
  }
  return {
    marked, after, clues, result: judgeByClues(answers),
    // **路径那一侧自己判可重试**:`unknown` 里混着两种 —— 「这一次没答出来」下一轮还问得
    // 出来,「名字本身没了」(`lost`)再问多少次都是同一句。前者该重试,后者该收档。
    retriable: cleanupRetriable(root) || (!!marker && cleanupRetriable(marker))
      || pathRetriable(clues) || held.retriable,
  };
}

/**
 * **行上那份「排除不掉的号」这一问**。`null` = 这一行没点过名(老行、或者当初就没有这台设备)。
 *
 * 第 8 轮审查 F1-A 实测的那一下就出在少了这一问:即时清理点名了 75600「挂在谁下面问不出来」、
 * 正确答 `unknown` 并落了账;重试时**故障一个字都没恢复**,可清扫手里只有根身份 / 记号 /
 * 两个文件三台设备,它们各自答「我这边没有」,合出来是「已经证明清空」—— 行被真的 DELETE,
 * 那个后代还在写(心跳 74→84)。
 *
 * **只有逐个核过才算覆盖了这份责任**,一个号两条出路:
 *  · 号上没有进程了 ⇒ 当初那个一定退了(正面的退出证明);
 *  · 还有进程、但**不是当初那一代** ⇒ 号换了主人,当初那个也一定退了。
 *
 * 其余一律留着:还是那一代 ⇒ 它还在;代次这一刻读不出来 ⇒ 没核成;当初连代次都没记下 ⇒
 * 核不动,只能等它退出。三种都**可重试**(它迟早会退),所以这一问不会把行推去收档 ——
 * 它是一份会自己消解的责任,不是那种「重试一万次也是同一句」的弃权(第 3 轮审查 N2)。
 */
export function openResidue(
  stored: string | null,
): { answer: CleanupResult | null; retriable: boolean } {
  const parsed = parseOpenMembers(stored);
  if (parsed === "broken") {
    // 名单读不出来 ⇒ 核不动它,也绝不能当成「没有责任」。再读一万次也是同一句 ⇒ 不可重试
    // (行留着收档:它仍是这次运行最后的可定位身份)。
    return {
      answer: { kind: "silent", why: "行上那份「排除不掉的号」读不出来(内容坏了),核不动" },
      retriable: false,
    };
  }
  if (!parsed.length) return { answer: null, retriable: false };
  const left = parsed.filter((one) => !provenGone(one));
  if (!left.length) return { answer: { kind: "empty" }, retriable: false };
  return {
    answer: {
      kind: "unknown",
      detail: `上一轮点名、这一刻仍排除不掉:${describeOpen(left)}`,
      open: left,
    },
    retriable: true,
  };
}

/** 这个号上当初那个进程**一定退了**吗(两条正面出路,见 `openResidue`)。 */
function provenGone(one: CleanupOpen): boolean {
  if (!Number.isInteger(one.pid) || one.pid <= 1) return true;   // 记歪的号核不动,也追不动
  if (!isPidAlive(one.pid)) return true;
  if (!one.gen) return false;                     // 当初没记代次 ⇒ 只能等它退出
  const current = processGenerationSync(one.pid);
  return current !== null && current !== one.gen; // 读不出来 ⇒ 这一次没核成,不是反证
}

/** 落库的那份 JSON 读回来。`"broken"` = 存着东西、可是读不出来(跟「没有」是两件事)。 */
function parseOpenMembers(stored: string | null): CleanupOpen[] | "broken" {
  if (!stored || !stored.trim()) return [];
  try {
    const raw: unknown = JSON.parse(stored);
    if (!Array.isArray(raw)) return "broken";
    const open: CleanupOpen[] = [];
    for (const one of raw) {
      if (!one || typeof one !== "object") return "broken";
      const { pid, gen, why } = one as Record<string, unknown>;
      if (typeof pid !== "number") return "broken";
      open.push({
        pid,
        gen: typeof gen === "string" ? gen : null,
        why: typeof why === "string" ? why : "排除不掉",
      });
    }
    return open;
  } catch {
    return "broken";
  }
}

/** 行上那份名单读成结构(读不出来 ⇒ 空;要分「坏了」和「没有」的地方用 `openResidue`)。 */
export const openMembersOf = (stored: string | null): readonly CleanupOpen[] => {
  const parsed = parseOpenMembers(stored);
  return parsed === "broken" ? [] : parsed;
};

/** 写进行里的那份 JSON(空名单写 `null`,跟老行同形)。 */
export const serializeOpenMembers = (open: readonly CleanupOpen[]): string | null =>
  open.length ? JSON.stringify(open) : null;

/**
 * **根这一问**:行上记下的号 + 启动时刻,四档答案。
 *
 * 为什么必须核启动时刻:号会被复用,只凭号只能问出「这个号上有进程」。拿它当「还是它」会
 * 误报,拿它当「不是它」会漏报 —— 所以这一问直接用全仓唯一那份身份判据(`processIdentity`),
 * 它把「是它」「是别人」「没记时刻比不出来」「这一刻问不出来」分成四档。
 *
 *  · `same`         ⇒ 确证根还活着(第 4 轮审查 F1 的 Windows 现场就是这一档);
 *  · `different`    ⇒ 号换了主人 ⇒ 当初那个一定退了,这是**正面的退出证明**;
 *  · `unverifiable` ⇒ 号上有进程、但这一行当初没记启动时刻:核验不了,而且**永远**核验不了
 *                     (那份时刻不会再长出来)⇒ 这一问没有证据来源,不是「没有残留」;
 *  · `unqueryable`  ⇒ 这一刻 ps 失败。号上没人 ⇒ 当初那个一定退了;号上有人 ⇒ 留着重试。
 */
function rootResidue(row: DebtRow): CleanupResult {
  const pid = row.rootPid;
  if (!pid || !Number.isInteger(pid) || pid <= 1) {
    return { kind: "silent", why: "这一行没记下根进程的号,核验不了它退没退" };
  }
  switch (processIdentity(pid, row.rootStartedAt)) {
    case "same":
      return { kind: "remaining", detail: `根进程 ${pid} 还活着(启动时刻对得上)` };
    case "different":
      return { kind: "empty" };                   // 号换了主人 ⇒ 当初那个一定没了
    case "unverifiable":
      return {
        kind: "silent",
        why: `${pid} 号上有进程,但这一行没记启动时刻 —— 号会被复用,核验不了是不是当初那个`,
      };
    default:
      return isPidAlive(pid)
        ? { kind: "unknown", detail: `根进程 ${pid} 的身份这一刻问不出来(号上有进程)` }
        : { kind: "empty" };                      // 号上没有进程 ⇒ 当初那个一定退了
  }
}


/** 两条跨得过重启的路径线索,**一起问**(少问一条就是上面那段说的那个漏洞)。 */
async function probeDebtPaths(debt: DebtRow): Promise<PathClues> {
  const recorded = !!(debt.trackPath || debt.outPath);
  // 这台机器结构性答不了「谁握着这个文件」时**不问**(见 `fileHoldersAnswerable`)。两种
  // 错法都实测过了:记成「没答出来」会让每一笔账在那个平台上永远推不动(第 3 轮审查 N2);
  // 记成「没有残留」会让它把活着的根洗成清空(第 4 轮审查 F1)。所以如实弃权。
  if (!fileHoldersAnswerable()) return { track: null, out: null, answerable: false, recorded };
  const [track, out] = await Promise.all([
    debt.trackPath ? probeFileHolders(debt.trackPath) : Promise.resolve(null),
    debt.outPath ? probeFileHolders(debt.outPath) : Promise.resolve(null),
  ]);
  return { track, out, answerable: true, recorded };
}

type PathClues = {
  track: HolderProbe | null;
  out: HolderProbe | null;
  /** 这台机器答得了「谁握着这个文件」吗。 */
  answerable: boolean;
  /** 这一行上到底有没有记下路径线索(两条都没有 ⇒ 这台设备压根不存在)。 */
  recorded: boolean;
};

/**
 * 两条路径线索合成这一问的一档。`null` = **这一行没有这台设备**,不发言。
 *
 * **它们只用于残留检测,不用于下刀** —— 「谁还握着这个文件」证明得了「还有东西在」,证明
 * 不了「那个号就是那个东西」,而重启之后这边连句柄都没有。要下刀只走记号 `ours` 那一条
 * (自带归属证明 + 同源代次)。
 */
const pathResidue = (clues: PathClues): CleanupResult | null => {
  if (!clues.recorded) return null;
  if (!clues.answerable) {
    return {
      kind: "silent",
      why: "这台机器答不了「谁还握着这次运行的文件」(没有 lsof 等价物)",
    };
  }
  return mergeClueAnswers([
    residueFromProbe("追踪文件", clues.track), residueFromProbe("输出文件", clues.out),
  ], "运行专属文件");
};

/**
 * 路径这边有没有「下一轮还问得出来」的那种没答出来。
 *
 * **判据看探测本身,不看合出来的那一档**:`unknown` 这个答案有两种来源,而它们的处置相反 ——
 *  · 没问全、而且再问也是同一句(名字自己没了;lsof 每次都声明输出不完整)⇒ 不可重试(该收档);
 *  · 没问全但下一次还问得出来(这一次查询失败)⇒ 下一轮完全可能换答案 ⇒ 可重试;
 *  · 问全了、但发现的持有者只读/模式问不出(分不出是后代还是看客)⇒ 看客关掉窗口、持有者
 *    退出,下一轮就能销账 ⇒ 可重试。
 *
 * 最初这里只看「整问失败」那一种,于是第三种被判成不可重试,一笔其实下一轮就能销掉的账在
 * 第一次清扫里就被收了档 —— 而收过档的行不再进重试名单,它从此永远销不掉(test:cleanup-debt
 * 第 3 组实测)。
 */
const pathRetriable = (clues: PathClues): boolean =>
  [clues.track, clues.out].some((p) => {
    if (!p) return false;
    const fault = holderScanFault(p);
    return fault ? fault.retriable : p.found.length > 0;
  });

/**
 * 记号那一问写成同一档。`null` = **这一行没有这台设备**(升级前建的老会话没种过记号),
 * 不发言 —— 它不是一张「已经空了」的证书(第 4 轮审查 F1)。
 *
 * `answerable` 是「这台机器答得了这一问吗」(默认取本机事实,见 `monitorUnitAnswerable`)。
 * 显式收成参数是为了让「结构性答不了」那一支在**任何**平台上都跑得到回归 —— 它只在 win32
 * 上触发,把判据写成参数,这条分支的逻辑本身就被钉住了。
 */
export function markerResidue(
  evidence: UnitEvidence, marked: boolean, answerable = monitorUnitAnswerable(),
): CleanupResult | null {
  if (!marked) return null;
  switch (evidence.verdict) {
    case "ours": case "suspected":
      return { kind: "remaining", detail: describeEvidence(evidence) };
    case "unprovable":
      // 这台机器**结构性读不到别的进程的环境块**(win32)跟「这一次查询失败」不是一件事:
      // 后者下一轮还问得出来 ⇒ 留着重试;前者永远是这个答案 ⇒ 这一问没有证据来源。两者
      // 都不许写成「没有」。
      return answerable
        ? { kind: "unknown", detail: `资源记号${describeEvidence(evidence)}` }
        : { kind: "silent", why: "这台机器读不到别的进程的环境块,问不出带这次记号的进程" };
    case "none":
      return { kind: "empty" };
  }
}

/** 这一行有没有记号(`no-unit:` 开头的那些是升级前建的老会话,键退回了路径线索)。 */
export const isMarked = (key: string): boolean => !key.startsWith(NO_UNIT_PREFIX);

/**
 * 这一刻该怎么处置这一行:**销账 / 收档 / 留着**。判据只有一处,销账入口与清扫共用。
 *
 *  · `settle` —— 判空成立(两问都有正面答案)⇒ 删行;
 *  · `keep`   —— 确证还有残留,或者还有「下一轮可能换答案」的线索 ⇒ 留着、把这一刻记上去;
 *  · `close`  —— 剩下的那种:证不出空、而且**再问多少次都是同一句**(这台机器答不了、线索
 *                的名字自己没了、当初没记启动时刻)⇒ 盖戳收档。**收档不是销账**:行留着,
 *                它是这次运行最后的可定位身份,只是不再自动重试、开机也不再报警
 *                (第 4 轮审查 F1 要的「可标注人工处置或停止自动重试,但仍保留记录」)。
 */
export type DebtDisposition = "settle" | "close" | "keep";

export function debtDisposition(judged: JudgedDebt): DebtDisposition {
  if (judged.result.kind === "empty") return "settle";
  if (judged.result.kind === "remaining") return "keep";
  return judged.retriable ? "keep" : "close";
}
