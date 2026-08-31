import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ConversationItem, AgentContentSegment } from "../../src/task-detail/conversationModel.ts";
import { AgentTurnBody } from "../../src/components/AgentTurnBody.tsx";
import { ConversationFeed } from "../../src/task-detail/ConversationFeed.tsx";
import { TeamFeed } from "../../src/team/TeamFeed.tsx";
import "../../src/styles/global.css";

// 一条典型的长回合：边干边说 → 最后一次动手 → 结论 → 记账（complete_task）→ 收尾。
const segments: AgentContentSegment[] = [
  { id: "s0", markdown: "我会先确认第 1 轮缺陷对应的新提交是否真正修复。\n", events: [], attachments: [] },
  { id: "s1", markdown: "", events: [{ kind: "tool", label: "Bash", detail: "npm run build" }], attachments: [] },
  { id: "s2", markdown: "真实页面已在后台标签打开并操作，附件数量可见。\n", events: [], attachments: [] },
  {
    id: "s3",
    markdown: "第 2 轮结论：verify_failed，已上报。\n",
    events: [{ kind: "tool", label: "Read", detail: "report.md" }],
    attachments: [],
  },
  { id: "s4", markdown: "", events: [{ kind: "tool", label: "mcp__harness__complete_task" }], attachments: [] },
  { id: "s5", markdown: "工作树保持干净。\n", events: [], attachments: [] },
];

// 未确认完成的失败回合：server 在正文写完之后补一条 settled.note —— .md 里是一段引用、
// trace 里是一条 error（single-run.ts）。整篇回答必须留在外面，别跟着它折进过程。
const failedSegments: AgentContentSegment[] = [
  {
    id: "f0",
    markdown: "答（只回答，未改代码）：会覆盖，而且只有一个槽。\n",
    events: [{ kind: "tool", label: "Bash", detail: "grep -rn 预约" }],
    attachments: [],
  },
  {
    id: "f1",
    markdown: "> 回合正常结束,但本回合内没有收到 complete_task 的完成确认。\n",
    events: [{ kind: "error", label: "回合正常结束,但本回合内没有收到 complete_task 的完成确认" }],
    attachments: [],
  },
];

// 真会话流（不是直接摆 AgentTurnBody）：钉的是两个 feed 自己怎么判「链路停没停」——
// 只钉 nextProcessFoldOpen 的话，喂给它的那个布尔算错了照样红不了。
//
// 走的是真实时序：回合先在飞，然后收口（endedAt 落下来），而任务这时还卡在审查门上 /
// 团队执行者还在干活。气泡 id 全程不变，跟直播一致（这两档都不触发快照重拉）。
const feedTurn = (endedAt: string | null): ConversationItem => ({
  kind: "agent",
  id: "feed-turn",
  sessionId: "s1",
  label: "codex",
  at: "2026-08-10T03:23:00.000Z",
  endedAt,
  markdown: "改完了，等审查。",
  segments: [
    { id: "g0", markdown: "", events: [{ kind: "tool", label: "Bash", detail: "npm run build" }], attachments: [] },
    { id: "g1", markdown: "改完了，等审查。\n", events: [], attachments: [] },
  ],
});

const feedTask = (status: string) => ({
  id: "t1",
  title: "审查门前的回合",
  status,
  mode: "single",
  agentType: "codex",
  executorLabel: "codex@cpa·gpt-5.6-sol",
}) as never;

/** 单飞：跑 → 回合收口且任务进审查门（不许折）→ 真收尾（这一下才折）。 */
function SingleFeed() {
  const [phase, setPhase] = useState<"running" | "gate" | "done">("running");
  const status = phase === "running" ? "running" : phase === "gate" ? "awaiting_review" : "done";
  return (
    <div data-case="feed-single">
      <button type="button" data-role="to-gate" onClick={() => setPhase("gate")}>进审查门</button>
      <button type="button" data-role="to-done" onClick={() => setPhase("done")}>收尾</button>
      <ConversationFeed
        task={feedTask(status)}
        items={[feedTurn(phase === "running" ? null : "2026-08-10T03:40:00.000Z")]}
        sessions={[]}
        loading={false}
        error={null}
      />
    </div>
  );
}

/** 团队：调度台说完话就落回 idle，可执行者还在干活 —— 那时候折等于折在半路上。 */
function TeamLeadFeed() {
  const [phase, setPhase] = useState<"running" | "dispatched" | "settled">("running");
  const worker = (status: string) => ({ id: "w1", title: "执行者 1", status, mode: "single", parentId: "lead", agentType: "codex" }) as never;
  const lead = {
    id: "lead",
    title: "调度台",
    status: phase === "running" ? "running" : "idle",
    mode: "team",
    parentId: null,
    agentType: "claude",
  } as never;
  return (
    <div data-case="feed-team">
      <button type="button" data-role="to-dispatched" onClick={() => setPhase("dispatched")}>派完活</button>
      <button type="button" data-role="to-settled" onClick={() => setPhase("settled")}>全队收工</button>
      <TeamFeed
        task={lead}
        rows={[{ kind: "conv", key: "r1", item: feedTurn(phase === "running" ? null : "2026-08-10T03:40:00.000Z") }]}
        workers={[worker(phase === "settled" ? "done" : phase === "dispatched" ? "running" : "backlog")]}
        onOpenWorker={() => undefined}
        onAskLead={() => undefined}
        delegatingIds={new Set()}
        indicatorForTask={() => null as never}
      />
    </div>
  );
}

function Turn({
  name,
  initialRunning,
  initialTaskLive = initialRunning,
  turnSegments = segments,
}: {
  name: string;
  initialRunning: boolean;
  /** 整个任务还在跑。缺省跟着回合走（回合在飞，任务当然在跑）。 */
  initialTaskLive?: boolean;
  turnSegments?: AgentContentSegment[];
}) {
  const [running, setRunning] = useState(initialRunning);
  const [taskLive, setTaskLive] = useState(initialTaskLive);
  const [nonce, setNonce] = useState(0);
  return (
    <div className="task-message task-message--agent" data-case={name}>
      <span className="task-message-avatar" aria-hidden="true">A</span>
      <div className="task-message-content">
        {/* 回合收口但任务还在跑：换下一轮、就地验证、会话行落 endedAt 都长这样。 */}
        <button type="button" data-role="end-turn" onClick={() => setRunning(false)}>结束回合</button>
        {/* 最后一步确认执行完了：任务不跑了。 */}
        <button
          type="button"
          data-role="end-task"
          onClick={() => { setRunning(false); setTaskLive(false); }}
        >
          结束任务
        </button>
        <button
          type="button"
          data-role="restart-turn"
          onClick={() => { setRunning(true); setTaskLive(true); }}
        >
          重新开跑
        </button>
        <button type="button" data-role="repaint" onClick={() => setNonce(nonce + 1)}>触发重绘 {nonce}</button>
        <AgentTurnBody segments={turnSegments} running={running} taskLive={taskLive} />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* 正在跑的回合 */}
    <Turn name="live" initialRunning />
    {/* 刷新页面后读到的历史回合：一上来就该是折好的 */}
    <Turn name="persisted" initialRunning={false} />
    {/* 任务还在跑，但这一条是它上一轮的回合：不许被自动掀开 */}
    <Turn name="history" initialRunning={false} initialTaskLive />
    {/* 未确认完成而记 failed 的回合：结算那条异常不许把整篇回答折进过程 */}
    <Turn name="failed" initialRunning={false} turnSegments={failedSegments} />
    {/* 回合收口了，但任务卡在审查门上 / 团队执行者还在干活：链路没停，不许折 */}
    <SingleFeed />
    <TeamLeadFeed />
  </StrictMode>,
);
