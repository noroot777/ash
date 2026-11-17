// 「我说过的话」（R 键那张表）的纯函数部分：从一份会话正文里摘出真人的发言、按查询筛、按时间倒序
// 翻页。从 user-messages.ts 拆出来是因为那边一导入就连库，这几条规则要能脱库钉住
// （server/scripts/test-user-messages.ts）。
import { isUserFollowUp } from "@ash/shared";
import { parseAttachmentText } from "@ash/shared/attachments";
import { annotationBatchDisplayText } from "@ash/shared/page-annotation-display";
import { parseSessionSpans } from "@ash/shared/session-output";
import type { UserMessage } from "@ash/shared/user-messages";

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
