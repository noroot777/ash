import { StrictMode, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import type { TaskReviewRound } from "@ash/shared";
import { LeftDrawerProvider, useLeftDrawerHost } from "../../src/components/LeftDrawer.tsx";
import { TaskReviewRounds } from "../../src/review/TaskReviewRounds.tsx";
import "../../src/styles/global.css";

// 「打开审查任务」的出口只有历史的独立审查轮才有，测试据此断言就地验证那几轮不长这个按钮。
const opened: string[] = [];
(window as unknown as { __openedTasks: string[] }).__openedTasks = opened;

function round(partial: Partial<TaskReviewRound> & Pick<TaskReviewRound, "round" | "where">): TaskReviewRound {
  return {
    reviewTaskId: null,
    reviewTaskStatus: "done",
    conclusion: null,
    reportMarkdown: "",
    screenshots: [],
    ...partial,
  };
}

const rounds: TaskReviewRound[] = [
  round({
    round: 1,
    where: "task",
    reviewTaskId: "rev-1",
    conclusion: "verify_failed",
    reportMarkdown: "第 1 轮的验证报告",
    screenshots: ["fail.png"],
  }),
  // 进行中的一轮：还没有结论，列表里不该先给它标红。
  round({ round: 2, where: "inline", reviewTaskStatus: "running" }),
  round({
    round: 3,
    where: "inline",
    conclusion: "verified",
    reportMarkdown: "第 3 轮的验证报告",
    screenshots: ["one.png", "two.png", "three.png", "four.png", "five.png", "six.png", "seven.png", "eight.png"],
  }),
];

// 摆成线上的骨架（InspectorHost 那几层）：左边是主区（`.task-detail`，读全文那一屉的定位基准），右边是
// 侧边栏。窄屏时侧边栏盖在主区上（inspector.css），那一屉得盖在它上面。
function Page() {
  const host = useLeftDrawerHost({ resetKey: "t1" });
  return (
    <LeftDrawerProvider value={host.api}>
      <div className="inspector-layout" style={{ height: 640 }}>
        <div className="inspector-layout__main">
          <div className="task-detail"><p style={{ padding: 16 }}>会话</p>{host.drawer}</div>
        </div>
        <aside className="inspector-host" style={{ "--inspector-width": "360px" } as CSSProperties}>
          <div className="insp-pane review-pane" style={{ overflow: "auto", height: "100%", flex: 1 }}>
            <TaskReviewRounds
              taskId="t1"
              state={{ info: { reviewRequested: true, rounds }, loading: false, error: null, reload: async () => undefined }}
              emptyMessage="尚无验证记录。"
              onOpenTask={(taskId) => opened.push(taskId)}
            />
          </div>
        </aside>
      </div>
    </LeftDrawerProvider>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Page /></StrictMode>);
