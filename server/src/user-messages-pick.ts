// 「我说过的话」（R 键那张表）的纯函数部分：从一份会话正文里摘出真人的发言、按查询筛、按时间倒序
// 翻页。从 user-messages.ts 拆出来是因为那边一导入就连库，这几条规则要能脱库钉住
// （server/scripts/test-user-messages.ts）。
import { isUserFollowUp } from "@navi/shared";
import { parseAttachmentText } from "@navi/shared/attachments";
import { annotationBatchDisplayText } from "@navi/shared/page-annotation-display";
import { parseSessionSpans } from "@navi/shared/session-output";
import type { UserMessage } from "@navi/shared/user-messages";

/** 列表里一条最多带多少字：右边那栏读全文用，再长的没人在这里读完，也不该为它撑大响应。 */
export const MESSAGE_TEXT_CAP = 4000;

/** 索引里的一条：比交出去的多一份没截断的正文（筛的时候整段都要算）。 */
export type IndexedMessage = UserMessage & { full: string };

/** 会话里的一句：段号 + 发言时刻（没有就是 null）+ 原文。 */
export type SessionUtterance = { index: number; at: string | null; raw: string };

/**
 * 一份会话正文里我自己打的每一句，按正文先后。段号是 parseSessionSpans 的下标、**含删掉的段**：
 * 页面上气泡的出处记的是同一个下标（conversationIdentity / conversationPersistedTurns），落点靠它对上。
 * 删掉的那几句不交出去 —— 会话里已经看不到它了。
 */
export function utterancesIn(output: string): SessionUtterance[] {
  const found: SessionUtterance[] = [];
  parseSessionSpans(output).forEach(({ seg }, index) => {
    if (seg.deleted || seg.kind !== "user" || !isUserFollowUp(seg)) return;
    found.push({ index, at: seg.at ?? null, raw: seg.text });
  });
  return found;
}

/** 给人读的正文：附件清单剥成路径，页面标注批次换成展示文本 —— 跟会话里那颗气泡显示的一样。 */
export function displayedMessage(raw: string): { text: string; attachments: string[] } {
  const { body, paths } = parseAttachmentText(raw);
  return { text: (annotationBatchDisplayText(body) ?? body).trim(), attachments: paths };
}

export function toIndexed(
  base: { id: string; taskId: string; sessionId: string | null; index: number | null; at: string },
  raw: string,
): IndexedMessage | null {
  const { text, attachments } = displayedMessage(raw);
  if (!text && !attachments.length) return null;
  const truncated = text.length > MESSAGE_TEXT_CAP;
  return {
    ...base,
    text: truncated ? `${text.slice(0, MESSAGE_TEXT_CAP)}…` : text,
    truncated,
    attachments,
    full: text,
  };
}

/** 新的在前；同一时刻的（老数据里常见）按 id 定个死顺序，翻页时才不会两页里各出现一次或都漏掉。 */
export function compareNewestFirst(left: { at: string; id: string }, right: { at: string; id: string }): number {
  if (left.at !== right.at) return left.at < right.at ? 1 : -1;
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
}

/**
 * 查询拆成词：空白分开，每个词都得出现（不分大小写）。词可以落在正文里，也可以落在任务标题里 ——
 * 人记得的常常是「在那个讲 XX 的任务里说过」，标题本身就是线索。
 */
export function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
}

/** 只看我说的那句本身（整段，截掉的部分也算）。 */
export function textMatches(message: IndexedMessage, terms: readonly string[]): boolean {
  const haystack = message.full.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export function matchesTerms(message: IndexedMessage, title: string, terms: readonly string[]): boolean {
  if (!terms.length) return true;
  const haystack = `${message.full}\n${title}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/**
 * 游标 = 上一页最后一条的 `at` + `id`。不用页码：翻页的工夫里又说了新的话，页码会整体错开一位，
 * 一条在两页里各出现一次。
 */
export function encodeCursor(message: { at: string; id: string }): string {
  return Buffer.from(JSON.stringify([message.at, message.id])).toString("base64url");
}

export function decodeCursor(cursor: string | undefined | null): { at: string; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string") return { at: parsed[0], id: parsed[1] };
  } catch {
    // 坏游标当没给：从头翻，总比 400 掉整张表强。
  }
  return null;
}

/** 已按新→旧排好的全量里，取游标之后、匹配查询的一页。 */
export function pageMessages(
  sorted: readonly IndexedMessage[],
  titleOf: (taskId: string) => string,
  options: { query: string; cursor?: string | null; limit: number },
): { messages: IndexedMessage[]; next: string | null } {
  const terms = queryTerms(options.query);
  const after = decodeCursor(options.cursor);
  const page: IndexedMessage[] = [];
  let more = false;
  for (const message of sorted) {
    if (after && compareNewestFirst(message, after) <= 0) continue;
    if (!matchesTerms(message, titleOf(message.taskId), terms)) continue;
    if (page.length === options.limit) {
      more = true;
      break;
    }
    page.push(message);
  }
  return { messages: page, next: more && page.length ? encodeCursor(page.at(-1)!) : null };
}

/** 上下文里智能体那两段各带多少字：认得出在聊什么就够，读全文去会话里。 */
export const CONTEXT_BEFORE_CAP = 240;
export const CONTEXT_AFTER_CAP = 520;

export type ContextLine = { text: string; truncated: boolean };

/** 截到段落边界上（截在代码块、列表中间会把 Markdown 弄坏）；找不到合适的边界就硬截。 */
function capHead(text: string, cap: number): ContextLine {
  const trimmed = text.trim();
  if (trimmed.length <= cap) return { text: trimmed, truncated: false };
  const head = trimmed.slice(0, cap);
  const cut = head.lastIndexOf("\n\n");
  return { text: (cut > cap / 2 ? head.slice(0, cut) : head).trimEnd(), truncated: true };
}

/**
 * 留末尾：从最后一段往前整段地收，装不下就停 —— 从表格、列表中间切进去，剩下的半截 Markdown 画出来
 * 是一堆竖线。最后一段自己就超长时才硬截它的尾巴。
 */
function capTail(text: string, cap: number): ContextLine {
  const trimmed = text.trim();
  if (trimmed.length <= cap) return { text: trimmed, truncated: false };
  const paragraphs = trimmed.split(/\n{2,}/);
  const kept: string[] = [];
  let length = 0;
  for (let at = paragraphs.length - 1; at >= 0; at -= 1) {
    const paragraph = paragraphs[at]!;
    if (length + paragraph.length > cap) break;
    kept.unshift(paragraph);
    length += paragraph.length + 2;
  }
  return { text: kept.length ? kept.join("\n\n") : trimmed.slice(-cap).trimStart(), truncated: true };
}

/**
 * 回复开头那几句过程话（「先查一下哨兵记录：」「截图核对一下渲染结果：」）—— 它们是智能体边干活边念叨的，
 * 每句后面跟着一串工具调用，正文里只剩一行冒号结尾的短句。去掉它们，露出来的才是它真正回我的话。
 */
const NARRATION = /^[^\n]{1,80}[：:]$/;

function dropNarration(text: string): string {
  const paragraphs = text.trim().split(/\n{2,}/);
  let at = 0;
  while (at < paragraphs.length - 1 && NARRATION.test(paragraphs[at]!.trim())) at += 1;
  return paragraphs.slice(at).join("\n\n");
}

/**
 * 一句话前后的对话：它上一句说了什么（我是在接哪句话）、它怎么回的。
 *
 * - before：往前找最近的一段智能体正文，取**末尾** —— 紧挨着我这句的是它最后说的那几句。中间先碰到
 *   我自己的另一句（连着说了两句）就不算「在接它的话」，给 null。
 * - after：往后到我下一句话为止，智能体最后那段正文，去掉开头的过程话（dropNarration）取**开头** ——
 *   一轮回复往往先是「我先看看」之类的过程话，最后那段才是结论。
 * - 旁注（系统注记）和系统代写的输入（哨兵投喂、审查打回）不是我跟它的对话，跳过：它们只是把同一件事
 *   接着往下推，回复要读到我下一次开口为止。删掉的段不算。`index` 为 null = 原始需求：前面没有东西，回复是
 *   第一条会话开头那一轮。
 */
export function contextAround(output: string, index: number | null): { before: ContextLine | null; after: ContextLine | null } {
  const segs = parseSessionSpans(output).map(({ seg }) => seg);
  // 段号指不到我说的一句（越界、指到智能体那段）：这不是一句我的话，前后都无从谈起。
  if (index !== null && segs[index]?.kind !== "user") return { before: null, after: null };
  let before: ContextLine | null = null;
  if (index !== null) {
    for (let at = index - 1; at >= 0; at -= 1) {
      const seg = segs[at]!;
      if (seg.deleted || seg.kind === "system" || (seg.kind === "user" && !isUserFollowUp(seg)) || !seg.text.trim()) continue;
      if (seg.kind === "agent") before = capTail(seg.text, CONTEXT_BEFORE_CAP);
      break;
    }
  }
  let reply: string | null = null;
  for (let at = (index ?? -1) + 1; at < segs.length; at += 1) {
    const seg = segs[at]!;
    if (seg.deleted || seg.kind === "system") continue;
    if (seg.kind === "user") {
      if (isUserFollowUp(seg)) break;
      continue;
    }
    if (seg.text.trim()) reply = seg.text;
  }
  return { before, after: reply === null ? null : capHead(dropNarration(reply), CONTEXT_AFTER_CAP) };
}

// ── 讨论（duet）的时间线 ─────────────────────────────────────────────────────
//
// 讨论里我插的话（注入意见、提问）不写进任何一条会话 .md，只落在讨论自己的 transcript.jsonl 上
// （server/src/duet/timeline.ts 的 recordUserTurn）。一行一条：我插的话是 `speaker: "user"`，两位讨论者
// 的整轮发言是 `speaker: "A" | "B" | …`，另有闸口、进度、诊断几种带 `type` 的行，跟对话无关。

type DuetRow = { speaker: string; text: string; at: string | null };

function duetRows(raw: string): DuetRow[] {
  const rows: DuetRow[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== "object") continue;
    const { type, speaker, text, at } = row as Record<string, unknown>;
    if (type !== undefined || typeof speaker !== "string") continue;
    rows.push({ speaker, text: typeof text === "string" ? text : "", at: typeof at === "string" ? at : null });
  }
  return rows;
}

/**
 * 一场讨论里我插的每一句，按先后。段号是「第几次插话」（从 0 数，空的也占号）—— 讨论页按同样的数法给
 * 我那几颗气泡编号（DuetView 的 userTurnIds），落点靠它对上。
 */
export function duetUtterancesIn(raw: string): SessionUtterance[] {
  return duetRows(raw).filter((row) => row.speaker === "user").map((row, index) => ({ index, at: row.at, raw: row.text }));
}

/**
 * 讨论里一句话前后的对话，口径同 contextAround：before 是紧挨在前面那位讨论者的发言末尾（前面先碰到
 * 我自己的话就是 null）；after 是我这句之后第一位开口的讨论者怎么回的（到我下一句为止）。`ordinal` 为
 * null = 议题本身：回复是第一位发言。
 */
export function duetContextAround(raw: string, ordinal: number | null): { before: ContextLine | null; after: ContextLine | null } {
  const rows = duetRows(raw);
  let position = -1;
  if (ordinal !== null) {
    let seen = -1;
    position = rows.findIndex((row) => row.speaker === "user" && (seen += 1) === ordinal);
    if (position < 0) return { before: null, after: null };
  }
  let before: ContextLine | null = null;
  for (let at = position - 1; at >= 0; at -= 1) {
    const row = rows[at]!;
    if (row.speaker === "user") break;
    if (!row.text.trim()) continue;
    before = capTail(row.text, CONTEXT_BEFORE_CAP);
    break;
  }
  let after: ContextLine | null = null;
  for (let at = position + 1; at < rows.length; at += 1) {
    const row = rows[at]!;
    if (row.speaker === "user") break;
    if (!row.text.trim()) continue;
    after = capHead(dropNarration(row.text), CONTEXT_AFTER_CAP);
    break;
  }
  return { before, after };
}
