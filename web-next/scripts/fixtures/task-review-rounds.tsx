import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { TaskReviewRound } from "@harness/shared";
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

// 侧边栏在页面右侧，左边是主工作区——抽屉贴着侧边栏左边缘展开，所以位置断言要有这块留白。
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div style={{ display: "flex", height: 640 }}>
      <div style={{ flex: 1 }} />
      <aside className="inspector-host" style={{ width: 360, minWidth: 360 }}>
        <div className="review-inspector">
          <TaskReviewRounds
            taskId="t1"
            state={{ info: { reviewRequested: true, rounds }, loading: false, error: null, reload: async () => undefined }}
            emptyMessage="尚无验证记录。"
            onOpenTask={(taskId) => opened.push(taskId)}
          />
        </div>
      </aside>
    </div>
  </StrictMode>,
);
