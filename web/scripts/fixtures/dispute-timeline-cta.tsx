// 「执行者驳回了、等你裁定」那条时间线旁注上的「去裁定」按钮。
//
// 三种形态并排：**挂着未裁定驳回**（该有按钮）、**已裁定**（同一条旁注还在，按钮必须
// 没了——它指向的那张卡已经不在了）、**没有 onOpenReviewPanel**（只读会话视图、团队
// 时间线那种场合，给一颗点了没反应的按钮比不给更糟）。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { FreeReviewRun, Session, Task } from "@ash/shared";
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
  "执行者认可这一轮意见，但提出它们超出本任务边界，建议转独立任务（第 2 轮 · 顶级审查）："
  + "第 2、3 条都是第 1 轮修复引入的并发保护…；自动复审已取消。"
  + "现在由你裁定：可以让双方辩一轮，也可以直接采纳执行者的说法、维持审查意见让它照改，"
  + "或者把越界的那几条转成一个独立任务。";

const output = [
  "已按第 1 轮意见修好，并把另外两条的越界依据逐条写下了。",
  turn("system", DISPUTE_NOTE, "2026-09-24T04:00:00.000Z"),
].join("\n");

const items = buildConversationItems([{ session, output, trace: [] }], [session], [] as never);

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
      <section className="readonly-fixture">
        <ConversationFeed
          task={task} items={items} questionHistory={[]} sessions={[session]} loading={false} error={null}
          reviews={[run(null)]}
        />
      </section>
    </div>
  </StrictMode>,
);
