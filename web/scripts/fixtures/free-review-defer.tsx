// 驳回卡上第三个出口（转为独立任务）的 DOM fixture：三种驳回形态并排挂出来。
//
// 只提转出 / 只驳不成立 / 两者都提——这三种是执行者在**一次**交接里可能落下的全部
// 形态，卡片对它们的标题、理由分块和出口集合各不相同，所以三种都得摆出来看。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { FreeReviewRound, FreeReviewRun } from "@ash/shared";
import { FreeReviewDisputeCard } from "../../src/free-workflow/FreeReviewDisputeCard.tsx";
import "../../src/styles/global.css";

const run: FreeReviewRun = {
  id: "run-1",
  reviewerId: null,
  reviewerName: "逻辑审查者",
  agentType: "codex",
  executorId: null,
  executorLabel: null,
  model: null,
  reasoningEffort: null,
  checkMode: "logic",
  note: null,
  retryLimit: 1,
  currentRound: 1,
  status: "stopped",
  rounds: [],
  createdAt: "2026-09-24T00:00:00.000Z",
  updatedAt: "2026-09-24T00:10:00.000Z",
  finishedAt: "2026-09-24T00:10:00.000Z",
};

function round(dispute: { reason: string; deferReason: string | null }): FreeReviewRound {
  return {
    round: 1,
    status: "failed",
    conclusion: "verify_failed",
    reviewedCommit: "commit-reviewed",
    reportMarkdown: "# 报告",
    screenshots: [],
    dispute: {
      ...dispute,
      at: "2026-09-24T00:12:00.000Z",
      resolution: null,
      resolvedAt: null,
      deferredTaskId: null,
      debates: [],
    },
    startedAt: "2026-09-24T00:00:00.000Z",
    endedAt: "2026-09-24T00:10:00.000Z",
  };
}

const deferOnly = round({
  reason: "",
  deferReason: "第 2、3 条成立，但都是第 1 轮按意见修复时引入的并发保护，超出原任务边界。",
});
const reasonOnly = round({ reason: "第 1 条读错了行号：那一行是生成代码。", deferReason: null });
const mixed = round({
  reason: "第 1 条读错了行号：那一行是生成代码。",
  deferReason: "第 4 条成立，但它是第 2 轮修复引入的，建议单独做。",
});

const state = { taskId: "defer-task", stateVersion: 2 } as never;
const deferredTask = { id: "derived-1", title: "承接第 1 轮审查的越界意见：原任务" };

const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url, window.location.origin);
  if (url.pathname.endsWith("/free-workflow/review/dispute/resolution") && init?.method === "POST") {
    const body = JSON.parse(String(init.body ?? "{}"));
    const log = window as Window & { __resolutions?: string[] };
    log.__resolutions = [...(log.__resolutions ?? []), body.resolution];
    return Promise.resolve(new Response(JSON.stringify({
      resolution: body.resolution,
      repairError: null,
      deferredTask: body.resolution === "deferred" ? deferredTask : null,
      state,
    }), { status: 200, headers: { "content-type": "application/json" } }));
  }
  return nativeFetch(input, init);
};

function Card({ label, data }: { label: string; data: FreeReviewRound }) {
  return (
    <div className={label} style={{ width: 420, marginBottom: 16 }}>
      <FreeReviewDisputeCard
        taskId="defer-task"
        run={run}
        round={data}
        onChanged={() => {}}
        notify={(message) => {
          const log = window as Window & { __notices?: string[] };
          log.__notices = [...(log.__notices ?? []), message];
        }}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Card label="defer-only-fixture" data={deferOnly} />
    <Card label="reason-only-fixture" data={reasonOnly} />
    <Card label="mixed-fixture" data={mixed} />
  </StrictMode>,
);
