// R 键那张「我说过的话」的纯逻辑：按天分段、时刻怎么写、一条在列表里那一行露什么。
// 拆出来是为了能脱 DOM 钉住（scripts/test-recall-model.ts）。
import type { UserMessage } from "@ash/shared/user-messages";

const two = (value: number) => String(value).padStart(2, "0");

function dayStart(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** 这一天的段头：今天、昨天，今年的写几月几日，更早的带上年份。 */
export function dayLabel(at: string, now: Date = new Date()): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "更早";
  const days = Math.round((dayStart(now) - dayStart(date)) / 86_400_000);
  if (days === 0) return "今天";
  if (days === 1) return "昨天";
  const monthDay = `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.getFullYear() === now.getFullYear() ? monthDay : `${date.getFullYear()}年${monthDay}`;
}

/** 行尾的时刻：哪一天已经写在段头上了，这里只要几点几分。 */
export function clockOf(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "" : `${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** 右边那栏的完整时刻。 */
export function fullInstant(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/**
 * 列表的一行行。day：这一行上面画天的段头（跟上一行不是同一天）；task：这一行上面画任务名
 * （跟上一行不是同一个任务，或者换了一天）。同一个任务里连着说的几句归在一个任务名下面，
 * 任务名不必每行都写一遍。
 */
export type RecallRow = { message: UserMessage; index: number; day: string | null; task: boolean };

export function recallRows(messages: readonly UserMessage[], now: Date = new Date()): RecallRow[] {
  let previousDay: string | null = null;
  let previousTask: string | null = null;
  return messages.map((message, index) => {
    const label = dayLabel(message.at, now);
    const day = label === previousDay ? null : label;
    const task = day !== null || message.taskId !== previousTask;
    previousDay = label;
    previousTask = message.taskId;
    return { message, index, day, task };
  });
}

/** 筛中的词离开头太远时，那一行从词前面这么多字起头。 */
const EXCERPT_LEAD = 24;

/**
 * 列表里那一行的正文：空白压成一个空格，只发了附件的报附件名。一行只露两行字，筛中的词落在后面时
 * 从词前面一点起头 —— 不然命中的那一句在列表里看不出命中在哪。
 */
export function rowText(message: UserMessage, fileName: (path: string) => string, query = ""): string {
  const text = message.text.replace(/\s+/g, " ").trim();
  if (!text) return message.attachments.map(fileName).join("、");
  const lower = text.toLowerCase();
  const hits = recallTerms(query).map((term) => lower.indexOf(term)).filter((at) => at >= 0);
  const first = hits.length ? Math.min(...hits) : -1;
  return first > EXCERPT_LEAD * 2 ? `…${text.slice(first - EXCERPT_LEAD)}` : text;
}

/** 查询拆成词：空白分开、不分大小写 —— 跟服务端筛的口径（server/src/user-messages-pick.ts 的 queryTerms）一样。 */
export function recallTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].sort((left, right) => right.length - left.length);
}

/** 正文切成「命中 / 没命中」几段，命中的词画出来。同一处有长有短时取长的。 */
export function highlightParts(text: string, query: string): { text: string; hit: boolean }[] {
  const terms = recallTerms(query);
  if (!terms.length) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  // 少数字符小写后长度会变（İ），下标就对不上原文：这种正文不画，照原样给。
  if (lower.length !== text.length) return [{ text, hit: false }];
  const parts: { text: string; hit: boolean }[] = [];
  let position = 0;
  while (position < text.length) {
    let at = -1;
    let length = 0;
    for (const term of terms) {
      const index = lower.indexOf(term, position);
      if (index >= 0 && (at < 0 || index < at)) {
        at = index;
        length = term.length;
      }
    }
    if (at < 0) break;
    if (at > position) parts.push({ text: text.slice(position, at), hit: false });
    parts.push({ text: text.slice(at, at + length), hit: true });
    position = at + length;
  }
  if (position < text.length) parts.push({ text: text.slice(position), hit: false });
  return parts;
}

/**
 * 「它上一句说到哪」那一小段的纯文本：它只是个由头，淡色、三行，不值得画成 Markdown —— 表格行整行不要，
 * 标题井号、加粗、行内代码的记号、链接地址去掉，换行压成空格。
 */
export function plainSnippet(markdown: string): string {
  return markdown
    .split("\n")
    .filter((line) => !/^\s*\|/.test(line) && !/^\s*```/.test(line))
    .map((line) => line.replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s?)/, ""))
    .join(" ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
