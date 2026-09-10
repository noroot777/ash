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
};

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
