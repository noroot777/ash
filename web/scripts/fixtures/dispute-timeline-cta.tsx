// 「执行者驳回了、等你裁定」那条时间线旁注：留到裁完为止，后面不再挂「去裁定」（裁定在回复框顶上那一行）。
//
// 几种形态并排：**挂着未裁定驳回**（那一句带点）、**已裁定**（那一句还在，但已是过去的事）、
// **没有 onOpenReviewPanel**（只读会话视图）。另有两份照 R8M9Tsn2q0aj 那一回合录的：驳回之后同一回合
// 又落了一句「本回合没有交卷」——任务还开着（那一句不被盖掉）、任务已验收（没裁过的驳回也不再是等你
// 裁定的事）。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { FreeReviewRun, Session, Task } from "@navi/shared";
import { ConversationFeed } from "../../src/task-detail/ConversationFeed.tsx";
import { buildConversationItems } from "../../src/task-detail/conversationModel.ts";
import "../../src/styles/global.css";

const session = {
  id: "s1",
  taskId: "t1",
  agentType: "claude",
  role: "main",
  executor: "claude@ccb",
  startedAt: "2026-09-24T03:00:00.000Z",
  endedAt: "2026-09-24T04:00:00.000Z",
} as unknown as Session;

const task = { id: "t1", title: "驳回旁注", body: "", status: "done", agentType: "claude" } as unknown as Task;

// 会话落盘里一条「回合行」= \x1e 开头的一行 JSON（见 shared 的 parseSessionOutput）；
// 少了那个记录分隔符就只是一行普通正文，会原样糊进 agent 气泡里。
const turn = (kind: string, text: string, at: string) =>
  `\x1e${JSON.stringify({ t: kind, text, at, aside: true })}`;

// 与 server/src/free-review-dispute.ts 那一处写下的句子同形（只提转出的那种形态）。
const DISPUTE_NOTE =
  "执行者认可这一轮意见，但说该另开一个任务去改，不在这个任务里改（第 2 轮 · 顶级审查）。\n"
  + "它的说法：这两条我认，但它们是上一轮照意见改出来的新问题，建议另开一个任务做。\n"
  + "现在由你裁定：让它接着改 / 这一轮不用改了 / 把那几条转成独立任务；拿不准就先让双方辩一轮。"
  + "（自动复审已取消，等你拍板。）";

const output = [
  "已按第 1 轮意见修好，并把另外两条的越界依据逐条写下了。",
  turn("system", DISPUTE_NOTE, "2026-09-24T04:00:00.000Z"),
].join("\n");

const items = buildConversationItems([{ session, output, trace: [] }], [session], [] as never);

// R8M9Tsn2q0aj 那一回合：驳回落下 13 秒后，同一回合又落了结算说明「本回合没有交卷」。
const settled = [
  "已按第 2 轮意见修好，只剩一条建议转出去。",
  `\x1e${JSON.stringify({ t: "system", text: DISPUTE_NOTE, aside: true, notice: { kind: "review.dispute", round: 2 }, at: "2026-09-24T04:00:00.000Z" })}`,
  `\x1e${JSON.stringify({ t: "agentEnd", at: "2026-09-24T04:00:13.000Z" })}`,
  `\x1e${JSON.stringify({ t: "system", text: "本回合没有交卷:agent 结束前没有调用 complete_task 确认目标已达成,按 navi 的完成协议记为未完成。", level: "notice", at: "2026-09-24T04:00:13.000Z" })}`,
].join("\n");
const heldItems = buildConversationItems([{ session, output: settled, trace: [] }], [session], [] as never);
const acceptedTask = { ...task, stage: "accepted" } as unknown as Task;

function run(resolution: "deferred" | null): FreeReviewRun {
  return {
    id: "run-1",
    reviewerId: null,
    reviewerName: "顶级审查",
    agentType: "codex",
    executorId: null,
    executorLabel: null,
    model: null,
    reasoningEffort: null,
    checkMode: "logic",
    note: null,
    retryLimit: 1,
    currentRound: 2,
    status: "stopped",
    rounds: [{
      round: 2,
      status: "failed",
      conclusion: "verify_failed",
      reviewedCommit: "c2",
      reportMarkdown: "# 报告",
      screenshots: [],
      dispute: {
        summary: "这两条我认，但它们是上一轮照意见改出来的新问题，建议另开一个任务做。",
        reason: "",
        deferReason: "第 2、3 条成立，但都是第 1 轮修复引入的。",
        at: "2026-09-24T04:00:00.000Z",
        resolution,
        resolvedAt: resolution ? "2026-09-24T05:00:00.000Z" : null,
        deferredTaskId: resolution ? "derived-1" : null,
        debates: [],
      },
      startedAt: "2026-09-24T03:50:00.000Z",
      endedAt: "2026-09-24T04:00:00.000Z",
    }],
    createdAt: "2026-09-24T03:50:00.000Z",
    updatedAt: "2026-09-24T04:00:00.000Z",
    finishedAt: "2026-09-24T04:00:00.000Z",
  } as unknown as FreeReviewRun;
}

const opened: string[] = [];
(window as unknown as { __opened: string[] }).__opened = opened;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div style={{ background: "var(--bg)" }}>
      <section className="open-fixture">
        <ConversationFeed
          task={task} items={items} questionHistory={[]} sessions={[session]} loading={false} error={null}
          reviews={[run(null)]}
          onOpenReviewPanel={() => opened.push("review")}
        />
      </section>
      <section className="resolved-fixture">
        <ConversationFeed
          task={task} items={items} questionHistory={[]} sessions={[session]} loading={false} error={null}
          reviews={[run("deferred")]}
          onOpenReviewPanel={() => opened.push("review")}
        />
      </section>
      <section className="held-fixture">
        <ConversationFeed
          task={task} items={heldItems} questionHistory={[]} sessions={[session]} loading={false} error={null}
          reviews={[run(null)]}
          onOpenReviewPanel={() => opened.push("held")}
        />
      </section>
      <section className="accepted-fixture">
        <ConversationFeed
          task={acceptedTask} items={heldItems} questionHistory={[]} sessions={[session]} loading={false} error={null}
          reviews={[run(null)]}
          onOpenReviewPanel={() => opened.push("accepted")}
        />
      </section>
      <section className="accepted-alone-fixture">
        <ConversationFeed
          task={acceptedTask} items={items} questionHistory={[]} sessions={[session]} loading={false} error={null}
          reviews={[run(null)]}
          onOpenReviewPanel={() => opened.push("accepted")}
        />
      </section>
      <section className="readonly-fixture">
        <ConversationFeed
          task={task} items={items} questionHistory={[]} sessions={[session]} loading={false} error={null}
          reviews={[run(null)]}
        />
      </section>
    </div>
  </StrictMode>,
);
