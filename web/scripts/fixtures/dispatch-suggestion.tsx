// 回复框顶上那一行「可以派出去的活」，以及正文任何位置都能敲的 `/派`。每一份是各自的任务（草稿按任务存）；
// 派出去、叉掉都打到接口上，由测试那一侧接住记账。读全文的左抽屉照任务页挂一个宿主。
// 有一份带着等裁定的驳回（框顶那一行让给裁定），一份一件建议都没有（只看斜杠）。
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { FreeReviewDispute, FreeReviewRun, Task } from "@ash/shared";
import type { DispatchSuggestion } from "@ash/shared/dispatch-suggestion";
import { useDisputeRulingDock } from "../../src/free-workflow/DisputeRulingDock.tsx";
import { LeftDrawerProvider, useLeftDrawerHost } from "../../src/components/LeftDrawer.tsx";
import { DraftProvider } from "../../src/lib/DraftStore.tsx";
import { ReplyBox } from "../../src/task-detail/ReplyBox.tsx";
import { replyDispatch } from "../../src/task-detail/replyDispatch.ts";
import { replyDiscuss } from "../../src/task-detail/replyDiscuss.ts";
import "../../src/styles/global.css";

const store = window as unknown as Record<string, unknown[]>;
const log = (name: string, value: unknown) => { (store[name] ??= []).push(value); };

const baseTask = {
  projectId: "p1", groupId: null, parentId: null, title: "输入框随行数自动增高", body: "改输入框高度", mode: "single",
  status: "done", stage: null, archived: false, handoff: null, question: null, workflowMode: "free", useWorktree: true,
  labels: [], dependsOn: [], resumeDependsOn: [], agentType: "claude", reviewOf: null,
  createdAt: "2026-11-17T00:00:00.000Z", updatedAt: "2026-11-17T00:00:00.000Z",
} as unknown as Task;

const item = (id: string, title: string, extra: Partial<DispatchSuggestion> = {}): DispatchSuggestion => ({
  id, title, body: `## 目标\n${title}的完整说明`, note: `${title}：和这条任务改的东西无关`, target: null, base: "trunk",
  proposedAt: "2026-11-17T01:00:00.000Z", ...extra,
});

const DISPUTE = {
  summary: "第 1 条读错了代码。", reason: "第 1 条：那段只在单线程里跑。", deferReason: "",
  at: "2026-11-17T01:00:00.000Z", resolution: null, resolvedAt: null, resolutionNote: null,
  deferredTaskId: null, supersededAt: null, debates: [],
} as unknown as FreeReviewDispute;
const disputed = [{
  id: "run-1", reviewerId: null, reviewerName: "顶级审查", agentType: "codex", executorId: null, executorLabel: null,
  model: null, reasoningEffort: null, checkMode: "logic", note: null, retryLimit: 3, currentRound: 1, status: "stopped",
  rounds: [{ round: 1, status: "failed", conclusion: "verify_failed", reviewedCommit: "c1", reportMarkdown: "# 报告", screenshots: [],
    dispute: DISPUTE, startedAt: "2026-11-17T00:30:00.000Z", endedAt: "2026-11-17T00:50:00.000Z" }],
  createdAt: "2026-11-17T00:30:00.000Z", updatedAt: "2026-11-17T01:00:00.000Z", finishedAt: "2026-11-17T00:50:00.000Z",
}] as unknown as FreeReviewRun[];

function Stage({ name, suggestions = [], reviews: initial = [] }: { name: string; suggestions?: DispatchSuggestion[]; reviews?: FreeReviewRun[] }) {
  // id 前 8 个字就是它的 worktree 分支名（ash/<前 8 个字>），测试那一侧按它给分支列表。
  const task = { ...baseTask, id: `t-${name}`, dispatchSuggestions: suggestions } as Task;
  const [reviews, setReviews] = useState(initial);
  const override = useDisputeRulingDock({
    task, reviews, known: true, onChanged: (state) => setReviews(state.reviews), notify: (message) => log(`__notices_${name}`, message),
  });
  const host = useLeftDrawerHost({ resetKey: task.id });
  return (
    <LeftDrawerProvider value={host.api}>
      <section className={`${name}-fixture`} style={{ position: "relative", margin: "0 0 28px" }}>
        {host.drawer}
        <ReplyBox
          task={task}
          hasConversation
          override={reviews.length ? override : undefined}
          onSend={async (text) => { log(`__sent_${name}`, text); return { started: true } as never; }}
          onDiscuss={replyDiscuss({ task, onChanged: () => {} })}
          onDispatch={replyDispatch({ task, onCreated: (created) => log(`__created_${name}`, created.id), notify: (message) => log(`__notices_${name}`, message) })}
        />
      </section>
    </LeftDrawerProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DraftProvider>
      <main style={{ width: "min(860px, 100%)", margin: "320px auto 40px", background: "var(--bg)" }}>
        <Stage name="one" suggestions={[item("s-one", "修好斜杠菜单那条红测试")]} />
        <Stage name="arm" suggestions={[item("s-arm", "拖高回复框后切走再回来高度没记住")]} />
        <Stage name="three" suggestions={[item("s-a", "第一件"), item("s-b", "第二件", { base: "here" }), item("s-c", "第三件")]} />
        <Stage name="ruling" suggestions={[item("s-ruling", "让给裁定的那一件")]} reviews={disputed} />
        <Stage name="slash" />
      </main>
    </DraftProvider>
  </StrictMode>,
);
