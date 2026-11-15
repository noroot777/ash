// 回复框里 `@` 一个人：框顶那一行定它来做什么（问一句 / 派出去），胶囊换成它，发送键写这一按的名字。
// 每一份是各自的任务（草稿按任务存）。「问一句」走的是任务页同一条 onSend（这里只记下发出去的参数）；
// 「派出去」走的是任务页同一份 replyDispatch——建任务、起跑都打到接口上，由测试那一侧接住记账。
// 有一份带着等裁定的驳回（跟任务页一样把 useDisputeRulingDock 交给回复框），一份在问你（接着答题卡）。
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { FreeReviewDispute, FreeReviewRun, Task } from "@ash/shared";
import { useDisputeRulingDock } from "../../src/free-workflow/DisputeRulingDock.tsx";
import { DraftProvider } from "../../src/lib/DraftStore.tsx";
import { ReplyBox } from "../../src/task-detail/ReplyBox.tsx";
import { replyDispatch } from "../../src/task-detail/replyDispatch.ts";
import "../../src/styles/global.css";

const store = window as unknown as Record<string, unknown[]>;
const log = (name: string, value: unknown) => { (store[name] ??= []).push(value); };

const baseTask = {
  projectId: "p1", groupId: null, parentId: null, title: "叫人", body: "把登录页改成新样式", mode: "single",
  status: "idle", stage: null, archived: false, handoff: null, question: null, workflowMode: "free", useWorktree: true,
  labels: [], dependsOn: [], resumeDependsOn: [], agentType: "claude", reviewOf: null,
  createdAt: "2026-11-15T00:00:00.000Z", updatedAt: "2026-11-15T00:00:00.000Z",
} as unknown as Task;

const DISPUTE = {
  summary: "第 1 条读错了代码。", reason: "第 1 条：那段只在单线程里跑。", deferReason: "",
  at: "2026-11-15T01:00:00.000Z", resolution: null, resolvedAt: null, resolutionNote: null,
  deferredTaskId: null, supersededAt: null, debates: [],
} as unknown as FreeReviewDispute;

const disputed = [{
  id: "run-1", reviewerId: null, reviewerName: "顶级审查", agentType: "codex", executorId: null, executorLabel: null,
  model: null, reasoningEffort: null, checkMode: "logic", note: null, retryLimit: 3, currentRound: 1, status: "stopped",
  rounds: [{ round: 1, status: "failed", conclusion: "verify_failed", reviewedCommit: "c1", reportMarkdown: "# 报告", screenshots: [],
    dispute: DISPUTE, startedAt: "2026-11-15T00:30:00.000Z", endedAt: "2026-11-15T00:50:00.000Z" }],
  createdAt: "2026-11-15T00:30:00.000Z", updatedAt: "2026-11-15T01:00:00.000Z", finishedAt: "2026-11-15T00:50:00.000Z",
}] as unknown as FreeReviewRun[];

function Stage({ name, task: patch = {}, reviews: initial = [], dispatch = true }: {
  name: string;
  task?: Partial<Task>;
  reviews?: FreeReviewRun[];
  /** 这里派不派得出去（团队执行者、审查任务派不出去）。 */
  dispatch?: boolean;
}) {
  // id 前 8 个字就是它的 worktree 分支名（ash/<前 8 个字>），测试那一侧按它给分支列表。
  const task = { ...baseTask, ...patch, id: `t-${name}` } as Task;
  const [reviews, setReviews] = useState(initial);
  const override = useDisputeRulingDock({
    task, reviews, known: true, onChanged: (state) => setReviews(state.reviews), notify: (message) => log(`__notices_${name}`, message),
  });
  return (
    <section className={`${name}-fixture`} style={{ margin: "0 0 28px" }}>
      <ReplyBox
        task={task}
        hasConversation
        override={reviews.length ? override : undefined}
        onSend={async (text, _attachments, options) => {
          log(`__sent_${name}`, { text, agent: options.agent ?? null, executorId: options.executorId ?? null,
            model: options.model ?? null, reasoningEffort: options.reasoningEffort ?? null });
          return { started: true } as never;
        }}
        onAnswer={task.question ? async (answer) => { log(`__answered_${name}`, answer); } : undefined}
        onDispatch={dispatch ? replyDispatch({ task, onCreated: (created) => log(`__created_${name}`, created.id), notify: (message) => log(`__notices_${name}`, message) }) : undefined}
      />
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DraftProvider>
      {/* 上方留白给 @ 菜单：它锚在输入框上沿往上弹。 */}
      <main style={{ width: "min(860px, 100%)", margin: "320px auto 40px", background: "var(--bg)" }}>
        <Stage name="ask" />
        <Stage name="self" />
        <Stage name="keep" />
        <Stage name="send" />
        <Stage name="running" task={{ status: "running" }} />
        <Stage name="fail" />
        <Stage name="ruling" reviews={disputed} />
        <Stage name="question" task={{ question: "先停一下吗？" } as Partial<Task>} />
        <Stage name="member" task={{ parentId: "team-1" }} dispatch={false} />
        <Stage name="slash" />
        <Stage name="flaky" task={{ projectId: "p2" }} />
        <Stage name="slow" />
      </main>
    </DraftProvider>
  </StrictMode>,
);
