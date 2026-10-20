// 驳回卡上第三个出口（转为独立任务）的 DOM fixture：三种驳回形态并排挂出来。
//
// 只提转出 / 只驳不成立 / 两者都提——这三种是执行者在**一次**交接里可能落下的全部
// 形态，卡片对它们的标题、理由分块和出口集合各不相同，所以三种都得摆出来看。第四张挂
// 一场辩完的辩论，那是「用这段作要点」唯一出现的场合。
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { FreeReviewDebate, FreeReviewRound, FreeReviewRun } from "@ash/shared";
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

function round(
  dispute: { summary?: string | null; reason: string; deferReason: string | null },
  debates: FreeReviewDebate[] = [],
): FreeReviewRound {
  return {
    round: 1,
    status: "failed",
    conclusion: "verify_failed",
    reviewedCommit: "commit-reviewed",
    reportMarkdown: "# 报告",
    screenshots: [],
    dispute: {
      summary: null,
      ...dispute,
      at: "2026-09-24T00:12:00.000Z",
      resolution: null,
      resolvedAt: null,
      resolutionNote: null,
      deferredTaskId: null,
      debates,
    },
    startedAt: "2026-09-24T00:00:00.000Z",
    endedAt: "2026-09-24T00:10:00.000Z",
  };
}

// 辩完的一场：收尾那段（第 3 段，审查者）里写着「我建议你现在怎么裁定」——用户要做的
// 就是把它交给执行者，所以引用按钮得能把它整段灌进要点栏。
const finishedDebate: FreeReviewDebate = {
  id: "debate-1",
  status: "finished",
  exchanges: 1,
  currentSide: null,
  verdict: "upheld",
  startedAt: "2026-09-24T00:20:00.000Z",
  finishedAt: "2026-09-24T00:30:00.000Z",
  turns: [
    { seq: 1, side: "reviewer", summary: "我坚持这一条：那行代码是手写的。", status: "done", statement: "审查者第 1 段：那一行不是生成代码。", startedAt: "2026-09-24T00:20:00.000Z", endedAt: "2026-09-24T00:23:00.000Z" },
    // 第 2 段故意不给摘要：加这个字段之前落的老发言就是这个样子，界面要把正文摊开兜住。
    { seq: 2, side: "executor", summary: null, status: "done", statement: "执行者第 2 段：我核对了，确实不是。", startedAt: "2026-09-24T00:23:00.000Z", endedAt: "2026-09-24T00:26:00.000Z" },
    { seq: 3, side: "reviewer", summary: "建议：让它按我们刚谈定的方案改，不要按报告里那版。", status: "done", statement: "收尾：我建议你让它按新方案改，别按报告里那版。", startedAt: "2026-09-24T00:26:00.000Z", endedAt: "2026-09-24T00:30:00.000Z" },
  ],
};

const deferOnly = round({
  summary: "这两条我认，但它们是上一轮照意见改出来的新问题，建议另开一个任务做。",
  reason: "",
  deferReason: "第 2、3 条成立，但都是第 1 轮按意见修复时引入的并发保护，超出原任务边界。",
});
// 这一张**故意不给摘要**：加这个字段之前落的那些驳回就是这个样子，此时正文必须默认
// 摊开（折起来就成了「什么都没有」）。
const reasonOnly = round({ reason: "第 1 条读错了行号：那一行是生成代码。", deferReason: null });
const mixed = round({
  summary: "第 1 条我不认（它看的那行是生成出来的）；第 4 条我认，但建议另开任务做。",
  reason: "第 1 条读错了行号：那一行是生成代码。",
  deferReason: "第 4 条成立，但它是第 2 轮修复引入的，建议单独做。",
});
const debated = round({
  summary: "报告挑的那一行是生成出来的，不是我写的，这条我不认。",
  reason: "第 1 条读错了行号：那一行是生成代码。",
  deferReason: null,
}, [finishedDebate]);

// 同一个卡片位置先后挂两轮材料（见下面 SwitchHarness）。两段正文**必须不一样**：
// 折叠状态是按内容认的，一样的正文算同一份内容，本来就该共用展开状态。
const switchNew = round({
  summary: "这条我不认：那个并发窗口在基线上就有。",
  reason: "新那轮的依据：基线提交上就已经有这个并发窗口，不是本轮改出来的。",
  deferReason: null,
});
// 切过去的那一轮**故意没有摘要**：它的默认档是「摊开」，与上一轮正好相反。
const switchOld = round({ reason: "老那轮的依据：第 3 条读错了配置文件。", deferReason: null });

const state = { taskId: "defer-task", stateVersion: 2 } as never;
const deferredTask = { id: "derived-1", title: "原任务 · 承接第 1 轮审查的越界意见" };

const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url, window.location.origin);
  if (url.pathname.endsWith("/free-workflow/review/dispute/resolution") && init?.method === "POST") {
    const body = JSON.parse(String(init.body ?? "{}"));
    const log = window as Window & { __resolutions?: string[]; __notes?: (string | null)[] };
    log.__resolutions = [...(log.__resolutions ?? []), body.resolution];
    // 裁定要点单独记一条：三档裁定表达不了的结论全靠它送出去，漏传的话界面看不出异样。
    log.__notes = [...(log.__notes ?? []), body.note ?? null];
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

// 历史报告抽屉切换轮次时，复用的就是**同一个卡片位置**（审查记录里的 reason/defer 两块
// 同理）。这张 fixture 把那件事摆成一颗按钮：换一轮 = 同一个位置换一份内容。
function SwitchHarness() {
  const [old, setOld] = useState(false);
  return (
    <div className="switch-fixture" style={{ width: 420, marginBottom: 16 }}>
      <button type="button" onClick={() => setOld(!old)}>换一轮</button>
      <FreeReviewDisputeCard
        taskId="defer-task"
        run={run}
        round={old ? switchOld : switchNew}
        onChanged={() => {}}
        notify={() => {}}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Card label="defer-only-fixture" data={deferOnly} />
    <Card label="reason-only-fixture" data={reasonOnly} />
    <Card label="mixed-fixture" data={mixed} />
    <Card label="debated-fixture" data={debated} />
    <SwitchHarness />
  </StrictMode>,
);
