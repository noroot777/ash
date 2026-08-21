import type { QuestionItem } from "@ash/shared";

export function appendQuestionOption(value: string, option: string): string {
  return value.trim() ? `${value.trimEnd()}\n${option}` : option;
}

export function formatQuestionAnswers(items: QuestionItem[], drafts: string[]): string {
  return items
    .map((item, index) => `【${index + 1}】${item.question}\n答：${drafts[index]?.trim() || "(未答)"}`)
    .join("\n\n");
}
