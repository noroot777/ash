// 讨论：会话里那颗气泡、就地摊开的每段一行、左侧抽屉里的完整记录、右侧「审议」格里那一段，以及回复框里怎么发起。
//
// 每一份摆成线上的样子：中间那一栏（`.task-detail`，抽屉的定位基准）装会话和回复框；有「审议」格的那几份右边一条
// FreeReviewPane，跟任务页一样经 InspectorNav 收「打开哪一场」的请求（气泡点过去走的就是这一条）。
// 审议格的数据由测试那一侧接住 `/tasks/:id/free-workflow` 交过来（同任务页：它自己拉）。
import { StrictMode, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Session, Task, TaskDiscussion } from "@ash/shared";
import { LeftDrawerProvider, useLeftDrawerHost } from "../../src/components/LeftDrawer.tsx";
import { FreeReviewPane } from "../../src/free-workflow/FreeReviewPane.tsx";
import { InspectorNavProvider, type InspectorNav } from "../../src/inspector/nav.tsx";
import { DraftProvider } from "../../src/lib/DraftStore.tsx";
import { reviewTargetRequest } from "../../src/review/reviewTarget.ts";
import { ConversationFeed } from "../../src/task-detail/ConversationFeed.tsx";
import { buildConversationItems } from "../../src/task-detail/conversationModel.ts";
import { ReplyBox } from "../../src/task-detail/ReplyBox.tsx";
import { replyDiscuss } from "../../src/task-detail/replyDiscuss.ts";
import { TASK_INSPECTORS } from "../../src/task-detail/taskInspectors.tsx";
import "../../src/styles/global.css";

const store = window as unknown as Record<string, unknown>;
const log = (name: string, value: unknown) => { ((store[name] as unknown[] | undefined) ?? (store[name] = []) as unknown[]).push(value); };
store.__tabTitles = TASK_INSPECTORS.map((item) => item.title);

const at = (minute: number) => `2026-11-15T10:${String(minute).padStart(2, "0")}:00.000Z`;
const session = { id: "s1", taskId: "t1", agentType: "claude", role: "main", executor: "claude@local", startedAt: at(0), endedAt: at(30) } as unknown as Session;
const baseTask = {
  projectId: "p1", groupId: null, parentId: null, title: "讨论", body: "把幽灵回合锁的处理方案定下来", mode: "single",
  status: "done", stage: null, archived: false, handoff: null, question: null, workflowMode: "free", useWorktree: false,
  labels: [], dependsOn: [], resumeDependsOn: [], agentType: "claude", reviewOf: null, createdAt: at(0), updatedAt: at(30),
} as unknown as Task;

const note = (text: string, minute: number, notice?: unknown) => `\x1e${JSON.stringify({ t: "system", text, at: at(minute), aside: true, notice })}`;
/** 讨论的结构那几句：带着是哪一场（服务端 discussion.ts 就这么写）。 */
const mark = (id: string, phase: string, text: string, minute: number) => note(text, minute, { kind: "discussion", discussionId: id, phase });
/** 系统替你说的一句（每一段的提示词、交给主执行器写合稿的那一句），各起一个回合。 */
const prompt = (text: string, minute: number) => `\n\x1e${JSON.stringify({ t: "user", text, at: at(minute), by: "system" })}\n`;
const end = (minute: number) => `\n\x1e${JSON.stringify({ t: "agentEnd", at: at(minute) })}\n`;
const participants = [
  { agentType: "codex", executorId: null, model: null, reasoningEffort: null, host: false },
  { agentType: "claude", executorId: null, model: null, reasoningEffort: null, host: true },
];
const turn = (seq: number, speaker: string, status: string, summary: string | null = null, agreed: boolean | null = null) => ({
  seq, speaker, status, summary, agreed,
  // 发言写长一些：抽屉要滚得动，才量得出「停在那一段」。
  statement: status === "done"
    ? `${summary}\n\n## 依据\n\n第 ${seq} 段的完整发言：读了 turn-lock.ts，收尾那几步各自带时限。\n\n${Array.from({ length: 14 }, (_, i) => `${i + 1}. 第 ${i + 1} 条理由，展开写一行。`).join("\n")}`
    : "",
  startedAt: at(seq), endedAt: status === "speaking" ? null : at(seq + 1),
});
export const discussionOf = (id: string, patch: Partial<TaskDiscussion>): TaskDiscussion => ({
  id, status: "running", topic: "幽灵回合锁走哪条路？手动放开还是让持有者自己有界？", rounds: 2, participants, attachments: [], lostBackground: [], turns: [],
  outcome: null, note: null, startedAt: at(1), finishedAt: null, ...patch,
} as TaskDiscussion);

const START = (id: string) => mark(id, "start", "开始讨论：claude 和 codex，2 轮。", 1);
const SEG = (id: string, seq: number, who: string, minute: number) => mark(id, "segment", `讨论第 ${seq}/4 段：轮到 ${who}。`, minute);
const STAGES = {
  blind: {
    discussion: discussionOf("d-blind", { turns: [turn(1, "codex", "speaking")] as never }),
    output: [START("d-blind"), SEG("d-blind", 1, "codex", 1), "（codex 在写第一段）"].join("\n"),
  },
  live: {
    discussion: discussionOf("d-live", { turns: [turn(1, "codex", "done", "让收尾每一步自己带时限"), turn(2, "claude", "speaking")] as never }),
    output: [START("d-live"), SEG("d-live", 1, "codex", 1), "第 1 段已交卷。", SEG("d-live", 2, "claude", 2), "我在看 turn-lock.ts"].join("\n"),
  },
  done: {
    discussion: discussionOf("d-done", {
      status: "finished", outcome: "agreed", finishedAt: at(9), attachments: ["/Users/u/ash/data/uploads/AbCdEfGhIjKl-方案草图.txt"], lostBackground: [{ agentType: "gemini", role: "single" }],
      turns: [turn(1, "codex", "done", "让收尾每一步自己带时限"), turn(2, "claude", "done", "也不赞成手动放开"),
        turn(3, "codex", "done", "补一条先修那处泄漏", true)] as never,
    }),
    output: [START("d-done"), SEG("d-done", 1, "codex", 1), prompt("【讨论】第 1 段", 1), "第 1 段已交卷。", end(2),
      SEG("d-done", 2, "claude", 2), prompt("【讨论】第 2 段", 2), "第 2 段交了。", end(3),
      SEG("d-done", 3, "codex", 3), prompt("【讨论】第 3 段", 3), "交了。", end(4),
      mark("d-done", "end", "讨论结束：claude 和 codex 谈了 3 段，谈拢了。", 5),
      prompt("【讨论说完了 · 写合稿】claude、codex 谈了 3 段，各方表态谈拢了。", 5),
      "合稿：先修泄漏，再给收尾每一步加时限；还留着的分歧：无。", end(6)].join("\n"),
  },
  failed: {
    discussion: discussionOf("d-failed", {
      status: "failed", note: "claude 第 2 段被停下或异常结束", finishedAt: at(4),
      turns: [turn(1, "codex", "done", "让收尾每一步自己带时限"), turn(2, "claude", "error")] as never,
    }),
    output: [START("d-failed"), SEG("d-failed", 1, "codex", 1), "第 1 段已交卷。", SEG("d-failed", 2, "claude", 2),
      mark("d-failed", "aborted", "讨论已中止：claude 第 2 段被停下或异常结束。可以再发起一次。", 4)].join("\n"),
  },
};
store.__discussions = Object.fromEntries(Object.entries(STAGES).map(([name, stage]) => [`t-${name}`, stage.discussion]));

const items = (output: string) => buildConversationItems([{ session, output, trace: [] }], [session], [] as never);

function Stage({ name, pane = false, task: patch = {} }: { name: keyof typeof STAGES | "start" | "busy"; pane?: boolean; task?: Partial<Task> }) {
  const task = { ...baseTask, ...patch, id: `t-${name}` } as Task;
  const stage = name in STAGES ? STAGES[name as keyof typeof STAGES] : null;
  const host = useLeftDrawerHost({ resetKey: name });
  const [request, setRequest] = useState<InspectorNav["request"]>(null);
  const nav: InspectorNav = {
    openTab: (id, params) => {
      log(`__opened_${name}`, { id, params });
      setRequest((current) => ({ id, params: params ?? {}, seq: (current?.seq ?? 0) + 1 }));
    },
    request,
    consume: (seq) => setRequest((current) => (current?.seq === seq ? null : current)),
  };
  return (
    <section className={`${name}-fixture`} style={{ display: "flex", height: 640, marginBottom: 24, border: "1px solid var(--line)" }}>
      <InspectorNavProvider value={nav}>
        <LeftDrawerProvider value={host.api}>
          <div className="task-detail" style={{ flex: 1, minWidth: 0 }}>
            <div className="task-detail-body">
              <section className="task-detail-main">
                <ConversationFeed task={task} items={items(stage?.output ?? "开始吧")} questionHistory={[]} sessions={[session]}
                  loading={false} error={null} reviews={[]} discussions={stage ? [stage.discussion] : []}
                  onOpenReviewPanel={pane ? (target) => nav.openTab("review", target ? reviewTargetRequest(target) : undefined) : undefined} />
                <ReplyBox task={task} hasConversation
                  onSend={async (text) => { log(`__sent_${name}`, text); return { started: true } as never; }}
                  onDispatch={async () => undefined}
                  onDiscuss={replyDiscuss({ task, onChanged: (state) => log(`__state_${name}`, state.discussions.length) })} />
              </section>
            </div>
            {host.drawer}
          </div>
          {pane && (
            <aside className="fixture-inspector" style={{ width: 340, flex: "none", overflow: "auto", borderLeft: "1px solid var(--line)", padding: 12 }}>
              <FreeReviewPane task={task} />
            </aside>
          )}
        </LeftDrawerProvider>
      </InspectorNavProvider>
    </section>
  );
}

function Page({ children }: { children: ReactNode }) {
  return <DraftProvider><main style={{ background: "var(--bg)", paddingTop: 300 }}>{children}</main></DraftProvider>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Page>
      <Stage name="start" />
      <Stage name="busy" task={{ status: "running" }} />
      <Stage name="blind" />
      <Stage name="live" pane />
      <Stage name="done" pane />
      <Stage name="failed" />
    </Page>
  </StrictMode>,
);
