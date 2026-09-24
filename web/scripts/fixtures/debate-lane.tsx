// 时间线上那张辩论卡：一整场辩论折成一行，展开/全宽阅读列的都是 statement。
//
// 数据是线上任务 g6wp5QSD2N6Y 那场辩论的**真实落库记录**（7 段、7032 字，见同目录
// debate-lane.data.json）——用户 2026-09-24 报「codex 那一方所有的结论我都看不到」时
// 看的就是它。造一份短的假数据测不出这件事：毛病恰恰出在「真发言很长、而 agent 在对话
// 里只交代了一句」的落差上。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { FreeReviewDebate, FreeReviewRun, Session, Task } from "@ash/shared";
import { ConversationFeed } from "../../src/task-detail/ConversationFeed.tsx";
import { buildConversationItems } from "../../src/task-detail/conversationModel.ts";
import debateData from "./debate-lane.data.json" with { type: "json" };
import "../../src/styles/global.css";

const debate = debateData as unknown as FreeReviewDebate;

const session = {
  id: "s1", taskId: "t1", agentType: "claude", role: "main", executor: "claude@ccb",
  startedAt: "2026-09-24T11:45:00.000Z", endedAt: "2026-09-24T14:45:42.000Z",
} as unknown as Session;

const task = { id: "t1", title: "辩论卡", body: "", status: "done", agentType: "claude" } as unknown as Task;

const turn = (text: string, at: string) => `\x1e${JSON.stringify({ t: "system", text, at, aside: true })}`;

// 服务端那七句原文（free-review-debate.ts）。执行者那几段本来是普通气泡，混在旁注中间。
const output = [
  turn("自由工作流第 1 轮审查开始：顶级审查 · 逻辑检查。", "2026-09-24T12:56:01.750Z"),
  turn("自由工作流第 1 轮审查未通过，意见已发回会话；修复回合正常结束后自动复审。", "2026-09-24T13:13:57.977Z"),
  turn("执行者认可这一轮意见，但提出它们超出本任务边界，建议转独立任务（第 1 轮 · 顶级审查）：只转出一项。现在由你裁定：可以让双方辩一轮，也可以直接采纳执行者的说法。", "2026-09-24T13:31:36.345Z"),
  turn("开始辩论第 1 轮审查意见：3 个来回，审查者（顶级审查）先答辩，最后由它收尾给出立场；结论仍由你裁定。", "2026-09-24T14:29:37.993Z"),
  turn("辩论第 1/7 段：轮到审查者发言（顶级审查）。", "2026-09-24T14:29:38.000Z"),
  turn("辩论第 2/7 段：轮到执行者发言。", "2026-09-24T14:32:02.745Z"),
  "第 2 段已交卷（seq: 2），未动任何代码。这一段我没有分歧要争——审查者接受了代理超时的转出。",
  turn("辩论第 3/7 段：轮到审查者发言（顶级审查）。", "2026-09-24T14:39:06.784Z"),
  turn("辩论第 4/7 段：轮到执行者发言。", "2026-09-24T14:39:52.132Z"),
  turn("辩论第 5/7 段：轮到审查者发言（顶级审查）。", "2026-09-24T14:42:34.547Z"),
  turn("辩论第 6/7 段：轮到执行者发言。", "2026-09-24T14:43:01.292Z"),
  turn("辩论第 7/7 段：轮到审查者发言（顶级审查）。", "2026-09-24T14:45:13.571Z"),
  turn("辩论结束，审查者收尾立场：维持原意见。这只是它自己的立场，结论仍由你裁定：采纳执行者，或维持审查意见让它照改。", "2026-09-24T14:45:42.686Z"),
].join("\n");

const items = buildConversationItems([{ session, output, trace: [] }], [session], [] as never);

const run = {
  id: "run-1", reviewerId: null, reviewerName: "顶级审查", agentType: "codex",
  executorId: null, executorLabel: null, model: "gpt-5.6-sol", reasoningEffort: "xhigh",
  checkMode: "logic", note: null, retryLimit: 9, currentRound: 1, status: "stopped",
  rounds: [{
    round: 1, status: "failed", conclusion: "verify_failed", reviewedCommit: "c1",
    reportMarkdown: "# 报告", screenshots: [],
    dispute: {
      reason: "", deferReason: "只转出一项：P1 修复方向里的「为代理层增加有界超时/可取消策略」。",
      at: "2026-09-24T13:31:36.345Z", resolution: null, resolvedAt: null, deferredTaskId: null,
      debates: [debate],
    },
    startedAt: "2026-09-24T12:56:01.637Z", endedAt: "2026-09-24T13:13:57.975Z",
  }],
  createdAt: "2026-09-24T12:56:01.637Z", updatedAt: "2026-09-24T14:45:42.685Z",
  finishedAt: "2026-09-24T13:13:57.975Z",
} as unknown as FreeReviewRun;

const common = {
  task, items, questionHistory: [], sessions: [session], loading: false, error: null,
} as const;

// 辩到一半：三段里第 1 段说完、第 2 段正在说、第 3 段还没轮到。收口那句还没写出来，
// 所以这张卡靠「真人插话才收口」以外的东西撑着——它必须自己知道自己还没结束。
const runningOutput = [
  turn("开始辩论第 2 轮审查意见：1 个来回，审查者（顶级审查）先答辩，最后由它收尾给出立场；结论仍由你裁定。", "2026-09-24T15:10:00.000Z"),
  turn("辩论第 1/3 段：轮到审查者发言（顶级审查）。", "2026-09-24T15:10:00.100Z"),
  turn("辩论第 2/3 段：轮到执行者发言。", "2026-09-24T15:12:40.000Z"),
].join("\n");

const runningDebate = {
  id: "running-1", status: "running", exchanges: 1, currentSide: "executor", verdict: null,
  startedAt: "2026-09-24T15:10:00.000Z", finishedAt: null,
  turns: [
    { seq: 1, side: "reviewer", status: "done", statement: "审查者第 1 段。", startedAt: "2026-09-24T15:10:00.100Z", endedAt: "2026-09-24T15:12:39.000Z" },
    { seq: 2, side: "executor", status: "speaking", statement: null, startedAt: "2026-09-24T15:12:40.000Z", endedAt: null },
  ],
} as unknown as FreeReviewDebate;

const runningRun = {
  ...run,
  id: "run-2",
  rounds: [{
    ...run.rounds![0], round: 2,
    dispute: { ...run.rounds![0]!.dispute!, debates: [runningDebate] },
  }],
} as unknown as FreeReviewRun;

const runningItems = buildConversationItems(
  [{ session, output: runningOutput, trace: [] }],
  [session],
  [] as never,
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div style={{ background: "var(--bg)" }}>
      <section className="folded-fixture">
        <ConversationFeed {...common} reviews={[run]} onOpenReviewPanel={() => {}} />
      </section>
      {/* 拿不到 reviews 的只读场合：配不到落盘记录，原始行原样摆出来兜底，不能凭空少掉一段。 */}
      <section className="fallback-fixture">
        <ConversationFeed {...common} reviews={null} />
      </section>
      <section className="running-fixture">
        <ConversationFeed {...common} items={runningItems} reviews={[runningRun]} />
      </section>
    </div>
  </StrictMode>,
);
