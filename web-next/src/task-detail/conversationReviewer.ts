// 「这一回合是审查者在说话吗、是第几轮」——会话里认审查者的全部判据。
// 从 conversationModel 里分出来的一块：那边管的是「把落盘与直播拼成一条时间线」,
// 这里只管在那条线上认人。类型是单向借用（`import type` 编译后不留引用）。
import { LEGACY_SYS_MARKER } from "@harness/shared";
import type { SessionTraceEntry } from "../lib/api.ts";
import { verifyNoteOf, type VerifyNoteMark } from "./conversationNotes.ts";
import type { ConversationItem } from "./conversationModel.ts";

export type ReviewerMark = { round: number | null };

// 「这一回合是审查者在说话吗」的唯一判据，落盘与直播两条路读同一份语义：
// ① 就地验证轮 —— 服务端按回合把轮次号写进 trace 的 run 事件、并随 agent.event 广播；
// ② 自由派审的独立审查回合 —— 它自己开一条 role=reviewer 的会话，没有轮次号。
// 轮次号优先：reviewer 会话上跑的验证轮同样该报出「第 N 轮」。
//
// 身份走 role 而不是走 session 对象：直播时 agent.event 自带 role，新开的 reviewer 会话
// 却要等下一次拉取才进 sessions —— 通用 textParser 那类执行器从不发 session 事件，只认
// sessions 快照的话，整轮自由派审直播都不会有徽标（刷新才出现）。
export function reviewerOf(
  verifyRound: number | null | undefined,
  role: string | null | undefined,
): ReviewerMark | undefined {
  if (verifyRound) return { round: verifyRound };
  return role === "reviewer" ? { round: null } : undefined;
}

export function traceVerifyRound(entries: SessionTraceEntry[]): number | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const event = entries[index]?.event;
    if (event?.kind === "run") return event.verifyRound ?? null;
  }
  return null;
}

// 「说话的是同一个身份吗」的比较键：换一轮验证也算换人（第 1 轮和第 2 轮之间隔着
// 一次修复，不该排成一段连续发言）。
export function reviewerKeyOf(reviewer: ReviewerMark | undefined): string {
  return reviewer ? `reviewer:${reviewer.round ?? "free"}` : "";
}

export function reviewerKey(item: Extract<ConversationItem, { kind: "agent" }>): string {
  return reviewerKeyOf(item.reviewer);
}

// 存量与自由派审的轮次：`run.verifyRound` 是这次改动才开始写的，老会话一条都没有；
// 自由派审的轮号也只写在时间线旁注里、从不进 run 事件。所以在**排好序的时间线上**
// 按「开始 … 结论」这对旁注划出区间，补齐 run 事件给不出的那部分。
//
// 两种区间能推的东西不一样，这个区别是必须的：
// · 就地验证搭在被验任务自己的会话上，区间内说话的那个人**就是**审查者 → 可以立身份；
// · 自由派审另开一条 reviewer 会话，主任务的发言也可能落在同一段时间里 → 只给已经
//   认出是 reviewer 的气泡补轮次，绝不拿它改别人的身份。
// 两种情形都让位给 run.verifyRound：那是服务端按回合直接标的，比旁注推断准。
//
// 收口比开口难：**跑通**的那条路根本不写「第 N 轮验证…」收尾旁注（`concludeRound`
// 直接往下推线），而「验收阶段更新：已验证」是审查者自己在回合中间调 report_stage
// 写的、还在它的回合里 —— 拿它收口会把审查者最后那段结论踢回实现者名下。所以收口认
// 的是**回合真的换了人**：结论旁注、真人插话、回合边界，以及审查者已经说完话之后再
// 出现的「继续（从中断处）」新回合标记。
export function applyVerifySpans(items: ConversationItem[]): void {
  let span: VerifyNoteMark | null = null;
  let spoke = false;
  const close = () => { span = null; spoke = false; };
  for (const item of items) {
    if (item.kind === "user") { close(); continue; }
    if (item.kind === "event") {
      const mark = verifyNoteOf(item.text);
      if (mark) {
        span = mark.phase === "start" ? mark : null;
        spoke = false;
      } else if (span && (item.variant === "boundary" || (spoke && item.text.includes(LEGACY_SYS_MARKER)))) {
        close();
      }
      continue;
    }
    if (item.kind !== "agent" || !span) continue;
    spoke = true;
    if (!item.reviewer) {
      if (span.kind === "inline") item.reviewer = { round: span.round };
      continue;
    }
    if (item.reviewer.round === null && span.round) item.reviewer = { round: span.round };
  }
}
