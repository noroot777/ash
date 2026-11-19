// 会话里那颗辩论气泡、它就地摊开的概览、左侧抽屉里的完整记录，和审查格那一轮下面的辩论那一段。
//
// 辩完那一场是线上任务 g6wp5QSD2N6Y 那场辩论的**真实落库记录**（7 段、7032 字，见同目录
// debate-bubble.data.json）——加「每段一句」字段之前落的老记录，正好拿来钉「没有那一句时拿完整
// 发言的开头顶上」。造一份短的假数据测不出这件事：真发言很长、而 agent 在对话里只交代了一句。
//
// 每一份都摆成线上的样子：中间那一栏（`.task-detail`，抽屉的定位基准）+ 右边一条审查格。
import { StrictMode, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { FreeReviewDebate, FreeReviewDispute, FreeReviewRun, Session, Task } from "@navi/shared";
import { LeftDrawerProvider, useLeftDrawerHost } from "../../src/components/LeftDrawer.tsx";
import { useDisputeRulingDock } from "../../src/free-workflow/DisputeRulingDock.tsx";
import { FreeReviewRoundBody } from "../../src/free-workflow/FreeReviewRoundBody.tsx";
import { DraftProvider } from "../../src/lib/DraftStore.tsx";
import { ConversationFeed } from "../../src/task-detail/ConversationFeed.tsx";
import { buildConversationItems } from "../../src/task-detail/conversationModel.ts";
import { ReplyBox } from "../../src/task-detail/ReplyBox.tsx";
import debateData from "./debate-bubble.data.json" with { type: "json" };
import "../../src/styles/global.css";

const finished = debateData as unknown as FreeReviewDebate;

const session = {
  id: "s1", taskId: "t1", agentType: "claude", role: "main", executor: "claude@ccb",
  startedAt: "2026-09-24T11:45:00.000Z", endedAt: "2026-09-24T14:45:42.000Z",
} as unknown as Session;

const baseTask = {
  id: "t1", projectId: "p1", groupId: null, parentId: null, title: "辩论气泡", body: "", mode: "single",
  status: "paused", stage: null, archived: false, handoff: null, question: null, workflowMode: "free",
  labels: [], dependsOn: [], resumeDependsOn: [], agentType: "claude",
  createdAt: "2026-09-24T11:45:00.000Z", updatedAt: "2026-09-24T14:45:42.000Z",
} as unknown as Task;

const note = (text: string, at: string) => `\x1e${JSON.stringify({ t: "system", text, at, aside: true })}`;
const START = (round: number, exchanges: number) =>
  `开始辩论第 ${round} 轮审查意见：${exchanges} 个来回，审查者（顶级审查）先答辩，最后由它收尾给出立场；结论仍由你裁定。`;

// 服务端那七句原文（free-review-debate.ts）。执行者那几段本来是普通气泡，混在旁注中间。
const finishedOutput = [
  note("执行者认可这一轮意见，但提出它们超出本任务边界，建议转独立任务（第 1 轮 · 顶级审查）：只转出一项。现在由你裁定：可以让双方辩一轮，也可以直接采纳执行者的说法。", "2026-09-24T13:31:36.345Z"),
  note(START(1, 3), "2026-09-24T14:29:37.993Z"),
  note("辩论第 1/7 段：轮到审查者发言（顶级审查）。", "2026-09-24T14:29:38.000Z"),
  note("辩论第 2/7 段：轮到执行者发言。", "2026-09-24T14:32:02.745Z"),
  "第 2 段已交卷（seq: 2），未动任何代码。这一段我没有分歧要争——审查者接受了代理超时的转出。",
  ...[3, 4, 5, 6, 7].map((seq) => note(`辩论第 ${seq}/7 段：轮到${seq % 2 ? "审查者" : "执行者"}发言。`, `2026-09-24T14:4${seq - 3}:00.000Z`)),
  note("辩论结束，审查者收尾立场：维持原意见。这只是它自己的立场，结论仍由你裁定：采纳执行者，或维持审查意见让它照改。", "2026-09-24T14:45:42.686Z"),
].join("\n");

// 辩到一半：三段里第 1 段说完、第 2 段正在说、第 3 段还没轮到。
const runningOutput = [
  note(START(1, 1), "2026-09-24T15:10:00.000Z"),
  note("辩论第 1/3 段：轮到审查者发言（顶级审查）。", "2026-09-24T15:10:00.100Z"),
  note("辩论第 2/3 段：轮到执行者发言。", "2026-09-24T15:12:40.000Z"),
].join("\n");
const running = {
  id: "running-1", status: "running", exchanges: 1, currentSide: "executor", verdict: null,
  startedAt: "2026-09-24T15:10:00.000Z", finishedAt: null,
  turns: [
    { seq: 1, side: "reviewer", summary: "我坚持这一条：超时那一处必须在这个任务里修。", status: "done", statement: "审查者第 1 段。", startedAt: "2026-09-24T15:10:00.100Z", endedAt: "2026-09-24T15:12:39.000Z" },
    { seq: 2, side: "executor", summary: null, status: "speaking", statement: "", startedAt: "2026-09-24T15:12:40.000Z", endedAt: null },
  ],
} as unknown as FreeReviewDebate;

// 中途断了：第 2 段执行者没能发言。
const brokenOutput = [
  note(START(1, 1), "2026-09-24T16:00:00.000Z"),
  note("辩论第 1/3 段：轮到审查者发言（顶级审查）。", "2026-09-24T16:00:00.100Z"),
  note("辩论第 2/3 段没能起跑，辩论已中止；可以重新发起。", "2026-09-24T16:03:00.000Z"),
].join("\n");
const broken = {
  id: "broken-1", status: "failed", exchanges: 1, currentSide: null, verdict: null,
  startedAt: "2026-09-24T16:00:00.000Z", finishedAt: "2026-09-24T16:03:00.000Z",
  turns: [
    { seq: 1, side: "reviewer", summary: "这一条成立。", status: "done", statement: "审查者第 1 段。", startedAt: "2026-09-24T16:00:00.100Z", endedAt: "2026-09-24T16:02:00.000Z" },
    { seq: 2, side: "executor", summary: null, status: "error", statement: "", startedAt: "2026-09-24T16:02:00.000Z", endedAt: "2026-09-24T16:03:00.000Z" },
  ],
} as unknown as FreeReviewDebate;

function runOf(debate: FreeReviewDebate, patch: Partial<FreeReviewDispute> = {}): FreeReviewRun {
  return {
    id: "run-1", reviewerId: null, reviewerName: "顶级审查", agentType: "codex",
    executorId: null, executorLabel: null, model: "gpt-5.6-sol", reasoningEffort: "xhigh",
    checkMode: "logic", note: null, retryLimit: 9, currentRound: 1, status: "stopped",
    rounds: [{
      round: 1, status: "failed", conclusion: "verify_failed", reviewedCommit: "c1",
      reportMarkdown: "# 审查报告\n\n代理层缺有界超时。", screenshots: [],
      dispute: {
        summary: "这一条我认，但它该另开一个任务做，不属于这次要改的那件事。",
        reason: "", deferReason: "只转出一项：P1 修复方向里的「为代理层增加有界超时/可取消策略」。",
        at: "2026-09-24T13:31:36.345Z", resolution: null, resolvedAt: null, deferredTaskId: null,
        debates: [debate], ...patch,
      },
      startedAt: "2026-09-24T12:56:01.637Z", endedAt: "2026-09-24T13:13:57.975Z",
    }],
    createdAt: "2026-09-24T12:56:01.637Z", updatedAt: "2026-09-24T14:45:42.685Z",
    finishedAt: "2026-09-24T13:13:57.975Z",
  } as unknown as FreeReviewRun;
}

const items = (output: string) => buildConversationItems([{ session, output, trace: [] }], [session], [] as never);
const log = (name: string, value: unknown) => {
  const store = window as unknown as Record<string, unknown[]>;
  (store[name] ??= []).push(value);
};

/** 线上的骨架：中间那一栏装会话和回复框，抽屉从它左边推出来；右边一条审查格。 */
/** 每一份是各自的任务：要点草稿按任务存，同一个 id 会让「裁完了」那一份把「等你裁定」那一份的草稿当旧的清掉。 */
function Stage({ name, task: base, output, reviews, panel = true, inspector = true }: {
  name: string;
  task: Task;
  output: string;
  reviews: FreeReviewRun[] | null;
  panel?: boolean;
  inspector?: boolean;
}) {
  // 夹具上的一颗「任务状态变了」：另一个窗口把任务跑起来、归档这种事。
  const [patch, setPatch] = useState<Partial<Task>>({});
  (window as unknown as Record<string, unknown>)[`__task_${name}`] = setPatch;
  const task = { ...base, ...patch, id: `t-${name}` } as Task;
  const host = useLeftDrawerHost({ resetKey: name });
  const run = reviews?.[0];
  const round = run?.rounds[0];
  return (
    <section className={`${name}-fixture`} style={{ display: "flex", height: 760, marginBottom: 24, border: "1px solid var(--line)" }}>
      <LeftDrawerProvider value={host.api}>
        <div className="task-detail" style={{ flex: 1, minWidth: 0 }}>
          <div className="task-detail-body">
            <section className="task-detail-main">
              <ConversationFeed task={task} items={items(output)} questionHistory={[]} sessions={[session]} loading={false} error={null}
                reviews={reviews} onOpenReviewPanel={panel ? (target) => log(`__opened_${name}`, target) : undefined} />
              {reviews && <Reply task={task} reviews={reviews} />}
            </section>
          </div>
          {host.drawer}
        </div>
        {inspector && run && round && (
          <aside className="fixture-inspector" style={{ width: 320, flex: "none", overflow: "auto", borderLeft: "1px solid var(--line)", padding: 12 }}>
            <button type="button" className="fixture-inspector-probe" onClick={() => log(`__probe_${name}`, 1)}>审查格里的一颗键</button>
            <FreeReviewRoundBody taskId={task.id} run={run} round={round} dispute={{ task, reviews }} />
          </aside>
        )}
      </LeftDrawerProvider>
    </section>
  );
}

function Reply({ task, reviews }: { task: Task; reviews: FreeReviewRun[] }) {
  const override = useDisputeRulingDock({ task, reviews, known: true, onChanged: () => undefined, notify: () => undefined });
  return <ReplyBox task={task} hasConversation onSend={async () => ({ started: true }) as never} override={override} />;
}

function Page({ children }: { children: ReactNode }) {
  return <DraftProvider><div style={{ background: "var(--bg)" }}>{children}</div></DraftProvider>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Page>
      {/* 辩完、还等你裁定。 */}
      <Stage name="awaiting" task={baseTask} output={finishedOutput} reviews={[runOf(finished)]} />
      {/* 辩到一半。 */}
      <Stage name="live" task={baseTask} output={runningOutput} reviews={[runOf(running)]} />
      {/* 裁完以后。 */}
      <Stage name="settled" task={baseTask} output={finishedOutput}
        reviews={[runOf(finished, { resolution: "upheld", resolvedAt: "2026-09-24T15:00:00.000Z", resolutionNote: "照审查者第 7 段的方案改。" })]} />
      {/* 中途断了。 */}
      <Stage name="failed" task={baseTask} output={brokenOutput} reviews={[runOf(broken)]} />
      {/* 只读场合拿不到 reviews：配不到落盘记录，原始行原样摆出来兜底。 */}
      <Stage name="fallback" task={baseTask} output={finishedOutput} reviews={null} panel={false} />
    </Page>
  </StrictMode>,
);
