// 「这个任务此前报过什么」—— 把前面各轮审查的**现象行**搬进本轮 prompt。
//
// 为什么必须由系统搬，而不是指望审查者自己知道：
// ① **跨 run 的会话是断的**。第 2 轮起复用同一条 reviewer 会话（`free-review-round.ts`
//    的 `freshSession: run.currentRound === 1`），所以一条链内部它记得自己报过什么；可是
//    用户点「再审一轮」开的是**新的 run**，又从第 1 轮起、新开一条空会话。实测
//    `zs6JLcw1VAdr` 一个任务上挂了 5 条 run 共 29 轮，后面每条 run 的第 1 轮都是在对前面
//    十几轮的发现一无所知的情况下重新开始看同一份代码。
// ② 一条链内部也不保险：十轮链的会话长到会被压缩，最早几轮的现象行正是先被压掉的部分。
//
// 搬过来干什么 —— 只干一件事：**让它判「同类」**。实测最贵的形态不是漏报，是同一个不可靠
// 判据的触发组合被一轮一报（两条十轮链，20 轮 20 条全属两个类，详见 `review-sweep.ts` 文件
// 头）。审查者手上有前面那串现象行时，「我这一条是不是上面那条的第 N 个变体」才是个能回答
// 的问题；没有这串清单，它只能把自己复现到的那一条当成独立缺陷报上去。
//
// 照 `free-review-settled.ts` 的分寸办：**只搬事实，不替它下判断**。搬的是现象行、轮次、
// 那一轮的结论和报告路径；要不要重报由它按证据定 —— 旧条目没修好、又复发的，照样该报，
// 所以这一节明写了这条出路。把它写成「上面这些一律不许再提」就从「补上下文」变成了消音。
import { and, asc, eq, lt, ne, or } from "drizzle-orm";
import { db } from "./db/index.js";
import { freeReviewRounds, freeReviewRuns } from "./db/schema.js";
import { freeReviewReportPath, readFreeReviewReport } from "./free-review-files.js";
import { readReport, reviewRoundDir } from "./review-evidence.js";
import { join } from "node:path";

/** 单条现象行内联的长度上限：够看出「是什么现象」，不至于把整份报告灌进 prompt。 */
const MAX_LINE = 110;
/** 最多内联多少条。超了**保留最近的**：早几轮多半已经修掉，活着的类在后面。 */
const MAX_ITEMS = 24;

export interface PriorRound {
  /** 轮次标签，如 `第 3 轮`；跨 run 时带上链的序号。 */
  label: string;
  /** 那一轮的权威结论（`verified` / `verify_failed` / null）。 */
  conclusion: string | null;
  /** 报告全文的落盘路径，让它要用时自己去读。 */
  reportPath: string;
  /** 从报告里抽出来的现象行。 */
  findings: string[];
}

/** 报告里**不是**发现的小节标题：抽标题那条退路会把它们一起捞上来。 */
const NOISE = [
  "结论", "覆盖声明", "技术明细", "已验证", "验证", "验证记录", "浏览器", "清场", "截图",
  "环境", "命令", "附录", "补充", "小结", "总结", "说明", "建议", "能不能验收",
  "现在什么能用了", "必须修的问题", "不拦验收",
];

/**
 * 从一份 report.md 里抽出每条发现的现象行。
 *
 * 两条路，顺序不能换：
 * ① 摘要契约要求每条阻塞问题以「你会遇到」起头（`review-report-format.ts`），这是**格式
 *    自己定义的锚点**，命中就只认它 —— 全库 275 份新格式报告都有。
 * ② 老格式报告（库里 1103 份）没有这个锚点，退回认三/四级标题（`### P1：…`），并滤掉
 *    「已验证的正向行为」这类小节标题。
 * 都抽不到就返回空：这一节宁可说「那一轮的现象没抽出来，报告在这里」，也不编一行。
 */
export function extractReportFindings(report: string): string[] {
  const lines = report.split(/\r?\n/);
  const clean = (text: string) => text
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LINE);
  const phenomena = lines
    .map((line) => /^[\s>*-]*(?:\*\*)?你会遇到(?:\*\*)?\s*[:：]?\s*(.*)$/.exec(line)?.[1] ?? "")
    .map(clean)
    .filter(Boolean);
  if (phenomena.length) return phenomena;
  return lines
    .map((line) => /^#{3,4}\s+(.+?)\s*$/.exec(line)?.[1] ?? "")
    .map(clean)
    .filter((title) => title && !NOISE.some((noise) => title.startsWith(noise)));
}

/**
 * 拼成 prompt 的一节。空清单返回空串 —— 第一条链的第 1 轮本来就没有历史，塞一句
 * 「此前没有发现」只是让它多读一行。
 */
export function priorFindingsSection(rounds: PriorRound[]): string {
  const withFindings = rounds.filter((round) => round.findings.length > 0);
  if (!withFindings.length) return "";
  const flat = withFindings.flatMap((round) =>
    round.findings.map((text) => ({ round, text })));
  const kept = flat.slice(-MAX_ITEMS);
  const dropped = flat.length - kept.length;
  const body = kept.map(({ round, text }) =>
    `- 〔${round.label}${round.conclusion ? ` · ${round.conclusion}` : ""}〕${text}`).join("\n");
  const paths = [...new Set(withFindings.map((round) => round.reportPath))].slice(-6).join("\n  ");
  return `\n\n【这个任务此前报过的发现（${flat.length} 条，按轮次先后）】\n${body}\n` +
    (dropped > 0 ? `（更早的 ${dropped} 条没有内联，在下面那几份报告里）\n` : "") +
    `报告全文：\n  ${paths}\n` +
    `这一节**不是**让你重报上面这些，它只用来判一件事：你这一轮要报的东西，` +
    `是不是上面某一条**同一个判据下的第 N 个触发组合**？是的话别再报第 N 个实例 ——` +
    `按「报类不报个例」写成类问题，指出该在哪一层加不变量。\n` +
    `例外有两个，照样报，并写明它是旧条目：上面某一条**还没修好**，或者**修完又复发了**。`;
}

/** 自由工作流：同一个任务**所有** run 的更早轮次（不只是本条链）。 */
export async function freeReviewPriorRounds(
  taskId: string,
  current: { runId: string; round: number },
): Promise<PriorRound[]> {
  const rows = await db.select({ run: freeReviewRuns, round: freeReviewRounds })
    .from(freeReviewRounds)
    .innerJoin(freeReviewRuns, eq(freeReviewRounds.runId, freeReviewRuns.id))
    .where(and(
      eq(freeReviewRuns.taskId, taskId),
      // 本条链里只看比自己早的轮次；别的链整条都算历史。
      or(ne(freeReviewRuns.id, current.runId), lt(freeReviewRounds.round, current.round)),
    ))
    .orderBy(asc(freeReviewRuns.createdAt), asc(freeReviewRounds.round));
  const chains = [...new Set(rows.map(({ run }) => run.id))];
  return rows.map(({ run, round }) => ({
    label: chains.length > 1 && run.id !== current.runId
      ? `第 ${chains.indexOf(run.id) + 1} 条审查链第 ${round.round} 轮`
      : `第 ${round.round} 轮`,
    conclusion: round.conclusion,
    reportPath: freeReviewReportPath(taskId, run.id, round.round),
    findings: extractReportFindings(readFreeReviewReport(taskId, run.id, round.round)),
  }));
}

/** 预设工作流的就地验证轮：证据按 `data/runs/<task>/review/round-N/` 平铺，直接数轮次。 */
export async function verifyPriorRounds(taskId: string, round: number): Promise<PriorRound[]> {
  const earlier = Array.from({ length: Math.max(0, round - 1) }, (_, index) => index + 1);
  return Promise.all(earlier.map(async (previous) => ({
    label: `第 ${previous} 轮`,
    conclusion: null,
    reportPath: join(reviewRoundDir(taskId, previous), "report.md"),
    findings: extractReportFindings(await readReport(taskId, previous)),
  })));
}

/** 自由工作流派审时用的一节。读历史失败不许拖垮派审：拿不到就当没有历史。 */
export async function freeReviewHistorySection(
  taskId: string,
  current: { runId: string; round: number },
): Promise<string> {
  try {
    return priorFindingsSection(await freeReviewPriorRounds(taskId, current));
  } catch {
    return "";
  }
}

/** 就地验证轮用的一节，同样不许因为读历史失败而拖垮派审。 */
export async function verifyHistorySection(taskId: string, round: number): Promise<string> {
  try {
    return priorFindingsSection(await verifyPriorRounds(taskId, round));
  } catch {
    return "";
  }
}
