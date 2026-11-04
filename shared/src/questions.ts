import type { QuestionItem } from "./index.ts";

export type QuestionSource = {
  question?: string | null;
  questionOptions?: string[] | null;
  questionItems?: QuestionItem[] | null;
};

export type QuestionAnswerInput = {
  answers?: string[];
  questionKey?: string;
};

export type QuestionRecord = QuestionSource & {
  id: string;
  answeredAt: string;
  answer: string;
  answers?: string[];
  reply: string;
  /** 用户删掉了这条答复（server/src/conversation-redact.ts）：只留 id 与时刻，问答正文已清空。 */
  deleted?: true;
  /** 删的是会话里哪一段（会话行 + 段序号；删除不挪段序号）。正文还没换成墓碑时靠它认回原主。 */
  deletedFrom?: { sessionId: string; index: number };
};

/** 会话里的一句真人输入，拿去对问答记录（`answerIds` 见 session-output.ts 的 ConvSeg）。 */
export type AnswerMessage = {
  key: string;
  text: string;
  answerIds?: readonly string[];
  source?: { sessionId: string; index: number };
};

/**
 * 会话里的答复 ↔ 问答历史里的记录。服务端删除（conversation-redact.ts）与问答卡共用这一份，
 * 两边认的是同一条。依次三档：
 *  1. 这句话上写着 `answerIds`（发出答复时就记下的记录 id）—— 只认它；
 *  2. 墓碑记着自己删的是哪一段（`deletedFrom`）—— 删到一半（问答记录已清、正文没换成）时
 *     那一段仍归这条墓碑，不会被挪给另一条同文记录；
 *  3. 都没有（有 `answerIds` 之前的老会话）：同文的按出现先后与记录的答复先后一一对上，
 *     前两档认走的记录不参与。
 * `unpaired`：没有出处可对的未删记录（会话里那句话不在这几条会话里）。
 */
export function pairAnswerMessages(records: readonly QuestionRecord[], messages: readonly AnswerMessage[]): {
  paired: Map<string, QuestionRecord>;
  unpaired: QuestionRecord[];
} {
  const byId = new Map(records.map((record) => [record.id, record]));
  const claimed = new Set(messages.flatMap((message) => message.answerIds ?? []));
  const paired = new Map<string, QuestionRecord>();
  const legacy: AnswerMessage[] = [];
  for (const message of messages) {
    if (message.answerIds?.length) {
      const own = message.answerIds.map((id) => byId.get(id)).find((record) => record);
      if (own) paired.set(message.key, own);
      continue;
    }
    const source = message.source;
    const from = source && records.find((record) =>
      record.deletedFrom?.sessionId === source.sessionId && record.deletedFrom.index === source.index);
    if (from) {
      paired.set(message.key, from);
      claimed.add(from.id);
      continue;
    }
    legacy.push(message);
  }
  const pool = records.filter((record) => !record.deleted && !claimed.has(record.id))
    .sort((left, right) => left.answeredAt.localeCompare(right.answeredAt));
  for (const message of legacy) {
    const at = pool.findIndex((record) => record.reply === message.text);
    if (at < 0) continue;
    paired.set(message.key, pool[at]!);
    claimed.add(pool[at]!.id);
    pool.splice(at, 1);
  }
  return { paired, unpaired: records.filter((record) => !record.deleted && !claimed.has(record.id)) };
}

export function questionItems(source: QuestionSource): QuestionItem[] {
  return source.questionItems?.length
    ? source.questionItems
    : [{ question: source.question ?? "", options: source.questionOptions ?? undefined }];
}

export function questionKey(source: QuestionSource): string {
  return JSON.stringify([source.question ?? "", source.questionOptions ?? [], source.questionItems ?? []]);
}

export function formatQuestionAnswers(answers: readonly string[]): string {
  if (answers.length === 1) return answers[0]!.trim();
  return answers.map((answer, index) => `${index + 1}. ${answer.trim() || "（未答）"}`).join("\n");
}

export function questionOptionSelected(value: string, option: string): boolean {
  return `\n${value.trim()}\n`.includes(`\n${option}\n`);
}

export function toggleQuestionOption(value: string, option: string): string {
  return questionOptionSelected(value, option)
    ? `\n${value.trim()}\n`.replace(`\n${option}\n`, "\n").trim()
    : [value.trim(), option].filter(Boolean).join("\n");
}

export function legacyQuestionRecord(text: string, id: string, at = ""): QuestionRecord | null {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  const prefix = /^【答复】\s*你之前的提问[:：]\s*「/.exec(normalized);
  if (!prefix) return null;
  let depth = 1;
  let end = prefix[0].length;
  for (; end < normalized.length; end += 1) {
    if (normalized[end] === "「") depth += 1;
    if (normalized[end] === "」" && --depth === 0) break;
  }
  if (depth || !/^\s*\n/.test(normalized.slice(end + 1))) return null;
  const question = normalized.slice(prefix[0].length, end).trim();
  const answer = normalized.slice(end + 1).trim()
    .replace(/\n\s*\n请据此(?:继续完成任务|接着安排)。$/, "").trim();
  if (!answer) return null;
  const parts = [...answer.matchAll(/(?:^|\n\n)【\d+】([\s\S]*?)\n答：([\s\S]*?)(?=\n\n【\d+】|$)/g)];
  return {
    id, answeredAt: at, question, answer, reply: text,
    ...(parts.length ? {
      questionItems: parts.map((part) => ({ question: part[1]! })),
      answers: parts.map((part) => part[2] === "(未答)" ? "" : part[2]!),
    } : { answers: [answer] }),
  };
}

export function isQuestionAnswer(text: string): boolean {
  return text.trimStart().startsWith("【答复】");
}
