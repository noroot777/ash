// 智能体收回了挂在回复框顶上的建议任务：那一行不见了，为什么不见了写在会话里收回的那一刻——跟回合的尾注
// 同一种小灰字（FootnoteLine 的 standalone），不带颜色、不占回复框。记录跟拿掉那一件同一笔落库、随任务下发
// （shared/src/dispatch-suggestion.ts），这里不读会话正文：建议不见了，这一句就一定在。
import type { WithdrawnSuggestion } from "@ash/shared/dispatch-suggestion";
import type { TurnFootnote } from "../turnFootnote.ts";

export type WithdrawalNote = { key: string; at: string; footnote: TurnFootnote };

/** 一次收回一句：同一次收回的几件（同一时刻）并在一行里，中间一个间隔号；按先后排。 */
export function withdrawalNotes(records: readonly WithdrawnSuggestion[] | null | undefined): WithdrawalNote[] {
  const calls = new Map<string, WithdrawnSuggestion[]>();
  for (const record of records ?? []) calls.set(record.at, [...(calls.get(record.at) ?? []), record]);
  return [...calls.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([at, items]) => {
    const key = `withdrawn:${items[0]!.id}`;
    return {
      key, at,
      footnote: {
        id: key, live: false,
        parts: items.map((item) => ({
          kind: "event" as const, id: `withdrawn:${item.id}`, at,
          view: {
            tier: "alert" as const, tone: "neutral" as const, topic: "other" as const, icon: "info" as const,
            text: `收回了建议任务「${item.title}」：${item.reason}`, detail: null, dispute: false,
          },
        })),
      },
    };
  });
}
