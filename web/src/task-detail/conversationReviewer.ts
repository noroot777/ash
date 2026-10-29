// 「这一回合是审查者在说话吗、是第几轮」——会话里认审查者的全部判据。
// 从 conversationModel 里分出来的一块：那边管的是「把落盘与直播拼成一条时间线」,
// 这里只管在那条线上认人。类型是单向借用（`import type` 编译后不留引用）。
import { LEGACY_SYS_MARKER } from "@ash/shared";
import type { SessionTraceEntry } from "../lib/api.ts";
import { verifyNoteOf, type VerifyNoteMark } from "./conversationNotes.ts";
import type { ConversationItem } from "./conversationModel.ts";
import { monitorWakeInput } from "./monitorWakeModel.ts";

export type ReviewerMark = { round: number | null };

// 「这一轮有结论了」的服务端信号：report_stage 写进时间线的那条（task-stage.ts,
// 文案 `验收阶段更新：${STAGE_LABELS[stage]}（${stage}）`）。认括号里的英文 key 而不认
// 中文标签 —— 标签是给人看的、随时可改，key 是 TaskStage 本身。
const CONCLUDED_STAGE = /验收阶段更新：.*（(?:verified|verify_failed)）/;

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

/**
 * 这条哨兵自动输入是不是喂给了**这一轮的审查者**。审查卡（conversationReviewLanes 的
 * closeBefore）和验证区间（下面的 applyVerifySpans）都只问这一处 —— 早先两边各自从「谁先
 * 说过话」反推，未知时一边留、一边收：审查者开口之前哨兵把执行者叫醒，那条输入和执行者
 * 随后的回合被卡吞进默认收起的折叠区，区间那一侧却已经收了口（第 1 轮逻辑审查 3）。
 *
 * 收件人是条目自带的事实：`sessionId` 是它喂进的那条会话，`sessionRole` 是那条会话的角色。
 *  · 自由派审 / 合并审查：审查者另开一条 role=reviewer 的会话 —— 角色就是答案；已经认出
 *    这一轮的审查会话时再核一道会话号（上一轮的审查会话不是这一轮的审查者）；
 *  · 就地验证：审查者搭在开轮旁注所在的那条会话上 —— 会话号就是答案。
 * 两样都答不出（极老的数据没有会话号）才按「留在这一轮」：收错卡的代价是审查者后续发言
 * 整段掉出卡外，比晚收一拍更难看懂。
 */
export function monitorWakeFedReviewer(
  item: Extract<ConversationItem, { kind: "user" }>,
  scope: { kind: VerifyNoteMark["kind"]; startSessionId?: string | null; reviewerSessionId?: string | null },
): boolean {
  const sameAs = (sessionId: string | null | undefined) => !sessionId || !item.sessionId || item.sessionId === sessionId;
  if (scope.kind === "inline") return sameAs(scope.reviewerSessionId ?? scope.startSessionId);
  if (item.sessionRole) return item.sessionRole === "reviewer" && sameAs(scope.reviewerSessionId);
  return sameAs(scope.reviewerSessionId);
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
// 收口比开口难。一轮审查**不是**一个回合：审查者提问要等答复、checkpoint 要等续跑，
// 服务端把这两种续跑都算在同一轮里（free-workflow 只暂停结算、`/answer` 与 task-resume
// 都带着 sessionRole=reviewer 回到当前 round）。所以回合结束、答复、「继续（从中断处）」
// 这些**回合级**信号都不能单独收口 —— 拿它们收，用户答完问题后徽标就从「审查者 ·
// 第 N 轮」退回「审查者」，存量 inline 甚至整个变回普通执行者。
//
// 真正标志这一轮走完的是服务端自己写的那两个信号，缺一不可：
// ① 结论：收尾旁注，或 report_stage 写的「验收阶段更新：…（verified / verify_failed）」
//    —— 后者是审查者在自己回合中间调的，写完还要继续说结论，所以它只**待收**（concluded），
//    要等下一个回合级信号才真的收口，否则最后那段结论会被踢回实现者名下；
// ② 换会话：inline 验证是搭在被验任务自己会话上的旁路回合，时间线一旦走到别的
//    sessionId，说话的就不可能还是这一轮的审查者了（自由派审反过来 —— 它本来就另开
//    一条会话、主任务可能同时在说话，所以只按 ① 收）。
//
// 剩下的：真人插话（不含【答复】）照旧收口，那是人接管了。
export function applyVerifySpans(items: ConversationItem[]): void {
  let span: (VerifyNoteMark & { sessionId?: string }) | null = null;
  let spoke = false;
  let concluded = false;
  // 这一段里**审查者在哪条会话上说话**（认出过身份的那几条才算）：inline 是被验任务自己那条，
  // 自由派审是 reviewer 那条。哨兵自动输入靠它核收件人（monitorWakeFedReviewer）。
  let reviewerSession: string | undefined;
  const close = () => { span = null; spoke = false; concluded = false; reviewerSession = undefined; };
  for (const item of items) {
    // 【答复】是审查者提问的回答，答完还是这一轮；真人另起话头才算接管。
    //
    // 哨兵自动输入（系统代写）是同一类事：审查者挂 start_monitor + pause_task、等结果回来
    // 续跑，是审查里跑回归的常规做法，服务端照样算在这一轮里（sessionRole=reviewer 回到当前
    // round）。拿它收口，用户看到的就是徽标从「审查者 · 第 N 轮」退回「审查者」，自由派审
    // 续跑后的那段结论还会整段掉出审查卡。
    // 判据是**喂给了谁**，跟审查卡问同一处（monitorWakeFedReviewer）：喂给这一轮的审查者 →
    // 还是这一轮；喂给别人（审查已交卷、或者审查者还没开口，哨兵结果把执行者叫醒）→ 照旧收口。
    if (item.kind === "user") {
      const fedReviewer = !!span && monitorWakeInput(item) !== null && monitorWakeFedReviewer(item, {
        kind: (span as VerifyNoteMark & { sessionId?: string }).kind,
        startSessionId: (span as VerifyNoteMark & { sessionId?: string }).sessionId,
        reviewerSessionId: reviewerSession,
      });
      if (!item.isAnswer && !fedReviewer) close();
      continue;
    }
    if (item.kind === "event") {
      const mark = verifyNoteOf(item.text);
      if (mark) {
        close();
        if (mark.phase === "start") span = { ...mark, sessionId: item.sessionId };
      } else if (span && CONCLUDED_STAGE.test(item.text)) {
        concluded = true;
      } else if (
        span && concluded && spoke
        && (item.variant === "boundary" || item.text.includes(LEGACY_SYS_MARKER))
      ) {
        close();
      }
      continue;
    }
    if (item.kind !== "agent" || !span) continue;
    if (span.kind === "inline" && span.sessionId && item.sessionId !== span.sessionId) { close(); continue; }
    spoke = true;
    if (!item.reviewer) {
      if (span.kind === "inline") item.reviewer = { round: span.round };
    } else if (item.reviewer.round === null && span.round) {
      item.reviewer = { round: span.round };
    }
    if (item.reviewer) reviewerSession = item.sessionId;
  }
}
