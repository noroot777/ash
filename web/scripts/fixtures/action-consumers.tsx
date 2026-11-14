import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Task, TaskListItem, TaskReviewRound } from "@ash/shared";
import { LaterSendKey, useLaterSend } from "../../src/components/LaterSend.tsx";
import { ReviewDispatchControl } from "../../src/review/ReviewDispatchControl.tsx";
import { TaskReviewInspector } from "../../src/task-detail/TaskReviewInspector.tsx";
import { blocker, shown, useTaskActions } from "../../src/lib/useTaskActions.ts";
import "../../src/styles/global.css";

// 消费了服务端「此刻能做什么」之后，表面不许再按本地状态另判一次（第 1 轮审查 F2）。真组件、真
// useTaskActions、真 GET /api/tasks/:id/actions；测试进程只换掉服务端那一侧。
//  · 回复框的发送键：停止键出不出只看服务端的停止结论，跟「回复会不会排队」无关；
//  · 两处派验证入口：本地 rounds 里有一轮在验，也不另推「验证正在进行」，照服务端的 verify。

const noop = () => undefined;

/** 停在检查点上、带着待启动请求的任务（回复不排队），服务端说能停：照 TaskDetail → ReplyBox 的接法。 */
function ReplyKey({ name, taskId, empty, queueing }: { name: string; taskId: string; empty: boolean; queueing: boolean }) {
  const later = useLaterSend({ later: null, setLater: noop });
  const stop = useTaskActions(taskId)?.stop;
  return (
    <div data-reply={name}>
      <LaterSendKey later={later} action="发送回复" empty={empty} queueing={queueing}
        onSend={noop} onStop={shown(stop) ? noop : undefined} stopBlocked={blocker(stop)}
        tasks={[]} projectId="p1" taskId={taskId} />
    </div>
  );
}

const round: TaskReviewRound = {
  round: 1, where: "inline", reviewTaskId: null, reviewTaskStatus: "running", conclusion: null as never,
  reportMarkdown: "", screenshots: [],
};
const listItem = { id: "t-verify", projectId: "p1", title: "被验的任务", mode: "single", status: "done", agentType: "claude",
  executorId: null, model: null, reasoningEffort: null, archived: false, parentId: null } as unknown as TaskListItem;
const task = { ...listItem, body: "", stage: null, reviewRequested: false } as unknown as Task;

function Board() {
  return (
    <main>
      <ReplyKey name="paused-empty" taskId="t-pending" empty queueing={false} />
      <ReplyKey name="paused-typed" taskId="t-pending" empty={false} queueing={false} />
      <ReplyKey name="running-unstoppable" taskId="t-nostop" empty queueing />
      <section data-surface="dispatch">
        <ReviewDispatchControl task={listItem} rounds={[round]} notify={noop} onRefresh={noop} />
      </section>
      <section data-surface="inspector">
        <TaskReviewInspector task={task} allTasks={[listItem]} onOpenTask={noop} onOpenReview={noop}
          onTaskUpdated={noop} notify={noop} />
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Board /></StrictMode>);
