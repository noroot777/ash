// 普通回合（续聊、自由工作流的自动修复）异常结束以后，失败那句话和「重试这一回合」的样子。
//
// 每一份都照 TaskDetail 那条链路推出动作（turnRetryTarget → 普通档 → ConversationFeed 的 turnRetry），
// 任务头照样摆出来，好看它头上没有回合级的那颗图标：
//   persisted 刷新以后：会话行带着服务端判的「怎么断的」，那句话从会话行补出来；
//   live      开着页面看：会话行还是老的，原因跟着直播那条结尾事件（done.interruption）到；
//   legacy    老记录：没有原因，那句话照老样子，动作照样在；
//   later     崩过以后又跑过一回合（别的会话）：那句话还在，动作不在；
//   stopped   手动停止的（非零退出）：不算异常，什么都不补；
//   running   任务在跑：那句话在，动作不在。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Session, Task, TurnInterruption } from "@ash/shared";
import { ConversationFeed } from "../../src/task-detail/ConversationFeed.tsx";
import { TaskHeader } from "../../src/task-detail/TaskHeader.tsx";
import { buildConversationItems, type PersistedConversation, type TimelineEntry } from "../../src/task-detail/conversationModel.ts";
import { turnRetryTarget, type TurnRetryAction } from "../../src/task-detail/turnRetry.ts";
import "../../src/styles/global.css";

const at = "2026-11-13T12:00:00.000Z";
const end = "2026-11-13T12:03:00.000Z";
const CAUSE: TurnInterruption = {
  reason: "模型上游连不上（503）",
  detail: "模型上游连不上（状态码 503），执行器以 exit 1 结束，执行器的原话：「unexpected status 503 Service Unavailable」",
};

const log = window as unknown as { __retried: string[] };
log.__retried = [];

const session = (taskId: string, id: string, over: Partial<Session> = {}) => ({
  id, taskId, agentType: "codex", role: "single", executor: "codex", startedAt: at, turnStartedAt: at, endedAt: end,
  exitStatus: 1, turnOutcome: "failed", ...over,
}) as unknown as Session;
const live = (taskId: string, sessionId: string, id: string, event: unknown): TimelineEntry => ({
  kind: "server", id, event: { type: "agent.event", taskId, sessionId, role: "single", agentType: "codex", event },
} as never);

type Scene = { status?: Task["status"]; sessions: Session[]; persisted: PersistedConversation[]; timeline?: TimelineEntry[] };
const SCENES: Record<string, (id: string) => Scene> = {
  persisted: (id) => {
    const s = session(id, "s1", { turnInterruption: CAUSE });
    return { sessions: [s], persisted: [{ session: s, output: "按意见改一下构建脚本。", trace: [] }] };
  },
  live: (id) => {
    const s = session(id, "s1");
    return {
      sessions: [s], persisted: [],
      timeline: [
        live(id, "s1", "live:text", { kind: "text", text: "按意见改一下构建脚本。" }),
        live(id, "s1", "live:done", { kind: "done", exitStatus: 1, turnOutcome: "failed", interruption: CAUSE }),
      ],
    };
  },
  legacy: (id) => {
    const s = session(id, "s1", { turnOutcome: null });
    return { sessions: [s], persisted: [{ session: s, output: "按意见改一下构建脚本。", trace: [] }] };
  },
  later: (id) => {
    const crashed = session(id, "s1", { turnInterruption: CAUSE });
    const next = session(id, "s2", { startedAt: "2026-11-13T12:10:00.000Z", turnStartedAt: "2026-11-13T12:10:00.000Z", endedAt: "2026-11-13T12:12:00.000Z", exitStatus: 0, turnOutcome: "completed" });
    return {
      sessions: [crashed, next],
      persisted: [{ session: crashed, output: "按意见改一下构建脚本。", trace: [] }, { session: next, output: "又跑了一回合，好了。", trace: [] }],
    };
  },
  stopped: (id) => {
    const s = session(id, "s1", { stoppedAs: "canceled", turnOutcome: "stopped" });
    return { sessions: [s], persisted: [{ session: s, output: "按意见改一下构建脚本。", trace: [] }] };
  },
  running: (id) => {
    const s = session(id, "s1", { turnInterruption: CAUSE });
    return { status: "running", sessions: [s], persisted: [{ session: s, output: "按意见改一下构建脚本。", trace: [] }] };
  },
};

function Case({ name }: { name: string }) {
  const id = `t-${name}`;
  const scene = SCENES[name]!(id);
  const task = {
    id, title: id, body: "", mode: "single", status: scene.status ?? "done", agentType: "codex", workflowMode: "free",
    archived: false, stage: null, parentId: null, queueId: null, handoff: null, question: null, resumePrompt: null, verifyRound: null,
  } as unknown as Task;
  const items = buildConversationItems(scene.persisted, scene.sessions, scene.timeline ?? []);
  // TaskDetail 同一条推法。
  const target = turnRetryTarget(task, items, { sessions: scene.sessions });
  const turnRetry: TurnRetryAction | null = target?.kind === "turn"
    ? { sessionId: target.sessionId, run: async () => { log.__retried.push(id); } }
    : null;
  const noop = () => {};
  return (
    <section className={`${id}-fixture`} style={{ marginBottom: 24 }}>
      <TaskHeader task={task} allTasks={[task]} conversationMarkdown="" busy={false} refreshing={false} reviewOpen={false}
        onTitle={async () => {}} onTogglePin={async () => {}} onPrimary={noop} onRequeue={noop} onArchive={noop} onRefresh={noop}
        onReview={noop} onOpenTask={noop} onDelete={noop} notify={noop} />
      <div className="feed"><ConversationFeed task={task} items={items} sessions={scene.sessions} questionHistory={[]} loading={false} error={null}
        turnRetry={turnRetry} /></div>
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div style={{ background: "var(--bg)", padding: 16, width: 900 }}>
      {Object.keys(SCENES).map((name) => <Case key={name} name={name} />)}
    </div>
  </StrictMode>,
);
