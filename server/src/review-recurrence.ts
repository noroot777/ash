// 同一谱系的拦验收发现**连续两轮没收口**时，修复交接换一种打法：不再照常按点修，而是卡执行者二选一。
//
// 为什么要它：审查链几十轮不收口，最大的单一形态是「按点修一个类问题」。`RsE8V4MFZ39x` 的一条六轮
// 链，每轮最要命那条都是同一类（接入误拒：项目级 → 默认执行器 → 终端 shim；后台查询泄漏：macOS →
// Linux → Windows → 首次检查分支）—— 审查者指一处、执行者修一处、下一轮隔壁分支再冒头。审查者其实
// **判得出**同类（它自己在标题里写「旧条目未修好」），只是判断留在散文里，系统读不到。
//
// 所以分三段，每段都只认结构化的东西：
// ① **承接**：审查者在 report_stage 的 `recurs` 里声明「本轮第 N 条承接清单里哪一条」，值是编号
//    （`review-recurrence-refs.ts`），不是自由文本。校验是精确匹配：编号必须在这一轮**实际发出去**的
//    清单里（`history_refs`），N 必须是这份报告里真抽得到的那一条。
// ② **谱系**：承接按链传递，且只认**紧挨着的上一轮**、两头都是 verify_failed。跨 run 照算（用户点
//    「再审一轮」开的新链，清单本来就跨链）；中间断一轮（没承接、没结论、通过了）谱系就断了。
// ③ **熔断**：修复交接里那一轮有谱系够长的发现，就在那一条交接里附一段指令，点名**每一条**够长的
//    （只这一轮，常驻提示词一个字节不加）；同时这一轮的审查记录与时间线上都留下「同类问题第 N 轮
//    未收口，已熔断」。熔断期间的提问要过格式闸，那道闸绑在哪见 `review-recurrence-gate.ts`。
//
// **失效向不触发**：没填、填错、格式不对、引用对不上，一律按「不是复发」处理，绝不报错、绝不编一条
// 假承接（同 `extractReportFindings` 的「宁可说没抽到」）。不填完全合法 —— 熔断是加在按点修上的一道
// 闸，漏判的代价是多修一轮，误判的代价是把一条独立缺陷当成老问题逼执行者重做方案。
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "./db/index.js";
import { freeReviewRounds, freeReviewRuns } from "./db/schema.js";
import { chainSequence, findingRefBase } from "./review-recurrence-refs.js";

/** 同一谱系连续几轮被标为拦验收就熔断。常量，不做设置项。 */
export const RECURRENCE_THRESHOLD = 2;

export type Carry = { finding: number; from: string };

/**
 * 把审查者交来的 `recurs` 读成承接清单。**任何不合格的一条都静默丢掉**，整体读不懂就返回空。
 *
 * 认三种写法：`{"1":"2.3.1"}`（字段说明里教的那种）、`[{finding:1, from:"2.3.1"}]`、以及上面两种
 * 被序列化成字符串的样子 —— 执行器把对象参数当字符串传过来并不罕见，读不懂就当没填，不让一份完整
 * 的结论因为一个可选字段被拒。编号两侧的方括号（照抄清单行首时会带上）去掉再比。
 */
export function parseCarries(raw: unknown, findingCount: number, sent: ReadonlySet<string>): Carry[] {
  let value = raw;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return []; }
  }
  const pairs: Array<[unknown, unknown]> = Array.isArray(value)
    ? value.map((item) => item && typeof item === "object"
      ? [(item as Record<string, unknown>).finding, (item as Record<string, unknown>).from] as [unknown, unknown]
      : [null, null])
    : value && typeof value === "object" ? Object.entries(value) : [];
  const carries: Carry[] = [];
  for (const [rawFinding, rawFrom] of pairs) {
    const finding = typeof rawFinding === "number" ? rawFinding
      : typeof rawFinding === "string" && /^\s*\d+\s*$/.test(rawFinding) ? Number(rawFinding) : NaN;
    if (!Number.isInteger(finding) || finding < 1 || finding > findingCount) continue;
    if (typeof rawFrom !== "string") continue;
    const from = rawFrom.trim().replace(/^\[(.*)\]$/, "$1").trim();
    if (!sent.has(from)) continue;
    // 一条发现只承接一个来源：同一条填了两个，取第一个合格的，不让它同时挂在两条谱系上。
    if (carries.some((carry) => carry.finding === finding)) continue;
    carries.push({ finding, from });
  }
  return carries;
}

/** 谱系计算要的那一轮：全局顺序里的一项。 */
export type LineageRound = {
  key: string;
  /** 这一轮条目编号的前缀（`<链序>.<轮>`）。 */
  refBase: string;
  conclusion: string | null;
  carries: Carry[];
};

/** 一轮熔断的结果：达到阈值的**每一条**发现各自连着几轮，外加其中最长的那个（界面与时间线报它）。 */
export type Recurrence = { length: number; findings: Array<{ finding: number; length: number }> };

/**
 * 每一轮里**谱系达到阈值的全部发现**。`rounds` 是这个任务全部轮次的**全局顺序**（链按创建先后，
 * 链内按轮次）；返回值里只有至少一条达到阈值的轮次。
 *
 * 触发集合是「每一条够长的」，不是「最长的那几条」：同一轮里 A 连着三轮、B 连着两轮，两条都得
 * 进修复交接 —— 只点名最长的那条，B 只要总比 A 晚冒头一轮就永远不会被要求一次修全。`length`
 * 只是展示用的那个最大值。
 *
 * 一条承接计入的条件，三条缺一不可：来源恰好是**全局顺序里的上一轮**（中间断一轮就断）、两头都是
 * verify_failed（「被标为拦验收」）、来源编号里的那一条存在于上一轮（编号是从它算出来的，到这里只是
 * 再核一次）。
 */
export function lineageLengths(rounds: readonly LineageRound[], threshold = RECURRENCE_THRESHOLD): Map<string, Recurrence> {
  const depth = new Map<string, number>(); // `${refBase}.${finding}` → 这一条的谱系长度
  const result = new Map<string, Recurrence>();
  rounds.forEach((round, index) => {
    if (round.conclusion !== "verify_failed") return;
    const previous = index > 0 ? rounds[index - 1]! : null;
    const findings: Recurrence["findings"] = [];
    for (const carry of round.carries) {
      if (!previous || previous.conclusion !== "verify_failed" || !carry.from.startsWith(`${previous.refBase}.`)) continue;
      const length = (depth.get(carry.from) ?? 1) + 1;
      depth.set(`${round.refBase}.${carry.finding}`, length);
      if (length >= threshold) findings.push({ finding: carry.finding, length });
    }
    if (findings.length) {
      result.set(round.key, {
        length: Math.max(...findings.map((item) => item.length)),
        findings: findings.sort((a, b) => a.finding - b.finding),
      });
    }
  });
  return result;
}

const roundKey = (runId: string, round: number) => `${runId}:${round}`;

/** 任务全部轮次的全局顺序 + 各自的谱系长度。读失败就当没有（熔断是附加的闸，不许拖垮修复交接）。 */
export async function taskRecurrences(taskId: string): Promise<Map<string, Recurrence>> {
  try {
    const sequence = await chainSequence(taskId);
    const runIds = [...sequence.keys()];
    if (!runIds.length) return new Map();
    // 合并结果审查照样在全局顺序里、照样传递承接（审查者声明的承接是真的），但它**自己那一轮
    // 不熔断**：那条线的修复是另起的独立任务，不走这里的修复交接，只在显示上熔断等于说了没做到的事。
    const merged = new Set((await db.select({ id: freeReviewRuns.id }).from(freeReviewRuns)
      .where(and(eq(freeReviewRuns.taskId, taskId), eq(freeReviewRuns.targetKind, "accepted_merge")))).map((row) => row.id));
    const rows = await db.select({
      runId: freeReviewRounds.runId, round: freeReviewRounds.round,
      conclusion: freeReviewRounds.conclusion, carries: freeReviewRounds.carries,
    }).from(freeReviewRounds).where(inArray(freeReviewRounds.runId, runIds)).orderBy(asc(freeReviewRounds.round));
    const ordered = rows.sort((a, b) => sequence.get(a.runId)! - sequence.get(b.runId)! || a.round - b.round);
    const found = lineageLengths(ordered.map((row) => ({
      key: roundKey(row.runId, row.round),
      refBase: findingRefBase(sequence.get(row.runId)!, row.round),
      conclusion: row.conclusion,
      carries: Array.isArray(row.carries) ? row.carries : [],
    })));
    for (const row of ordered) if (merged.has(row.runId)) found.delete(roundKey(row.runId, row.round));
    return found;
  } catch {
    return new Map();
  }
}

/** 某一轮有没有熔断；没有返回 null。 */
export async function roundRecurrence(taskId: string, runId: string, round: number): Promise<Recurrence | null> {
  return (await taskRecurrences(taskId)).get(roundKey(runId, round)) ?? null;
}

export { roundKey as recurrenceKey };

/** 审查记录与时间线上的那一句（刷新后还看得见的那份状态，界面与时间线共用这一种说法）。 */
export function recurrenceLabel(length: number): string {
  return `同类问题第 ${length} 轮未收口，已熔断`;
}

/** 时间线上那一条：说清熔断之后接下来会发生什么（写给用户，不带编号和条序）。 */
export function recurrenceTimeline(length: number): string {
  return `${recurrenceLabel(length)}：接下来的修复不再按点修，执行者要么一次改全同类位置，要么把方案选择交给你。`;
}

/** 熔断指令的字节上限（用户定的）。体积闸按真实投递逐字节量，这里是构造时就守住的那一道。 */
export const RECURRENCE_NOTE_CAP = 300;

/** 条目放不进指令时，完整清单写在报告同目录的这个文件里（`free-review-prompts.ts` 负责落盘）。 */
export const RECURRENCE_LIST_FILE = "recurrence.md";

/** `1、2、3、5` → `1–3、5`：连续的条序压成一段。 */
function findingRanges(findings: readonly number[]): string {
  const parts: string[] = [];
  for (let index = 0; index < findings.length;) {
    let end = index;
    while (end + 1 < findings.length && findings[end + 1] === findings[end]! + 1) end++;
    parts.push(end > index + 1 ? `${findings[index]}–${findings[end]}` : findings.slice(index, end + 1).join("、"));
    index = end + 1;
  }
  return parts.join("、");
}

/**
 * 熔断那一轮修复交接里附的指令。**只在触发轮出现**，≤ 300 字节（体积闸 `test-prompt-budget.ts`
 * 钉着「去掉这一段就和普通修复交接逐字节相同」）。驳回的权利不在这里重复：同一条交接后面照常带着。
 *
 * 触发条目全部要有去处，长度又要有上界：条序先压成区间，放得下就内联；放不下（触发的条目多到
 * 区间也压不住）就只报条数，完整清单指到报告同目录的 `recurrence.md` —— 不截掉任何一条。
 */
export function recurrenceRepairNote(found: Recurrence): { text: string; listed: boolean } {
  const note = (which: string) => `\n\n【${recurrenceLabel(found.length)}】${which}已按点修过没收口，二选一：` +
    `(a) 没修全——列出全部同类位置，这轮一次改完；(b) 方案本身走不通——用 ask_question 把选择题交给用户。不许再按点修。\n`;
  const inline = note(`报告第 ${findingRanges(found.findings.map((item) => item.finding))} 条`);
  return Buffer.byteLength(inline, "utf8") <= RECURRENCE_NOTE_CAP ? { text: inline, listed: false }
    : { text: note(`这 ${found.findings.length} 条（见同目录 ${RECURRENCE_LIST_FILE}）`), listed: true };
}

/** 外置清单的正文：每条的条序、连着几轮、报告里那句「你会遇到」。 */
export function recurrenceListMarkdown(found: Recurrence, phenomena: readonly string[]): string {
  return `# ${recurrenceLabel(found.length)}\n\n` + found.findings.map(({ finding, length }) =>
    `- 报告第 ${finding} 条（连续 ${length} 轮）：${phenomena[finding - 1] ?? "（报告里没抽到这条的现象）"}`).join("\n") + "\n";
}
