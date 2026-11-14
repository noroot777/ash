// 普通回合（续聊、自由工作流的自动修复）异常结束以后，失败那句话和「重试这一回合」的样子。
//
// 能不能重来是服务端判的（server/src/task-retry-turn.ts，随「此刻能做什么」下发），每一份带着它那一刻
// 服务端会给的结论，照 TaskDetail 那条链路接成动作（retryTurnActions → 普通档 → ConversationFeed 的
// turnRetry）；任务头照样摆出来，好看它头上没有回合级的那颗图标：
//   persisted 刷新以后：会话行带着服务端判的「怎么断的」，那句话从会话行补出来；
//   live      开着页面看：会话行还是老的，原因跟着直播那条结尾事件（done.interruption）到；
//   legacy    老记录：没有原因，那句话照老样子，动作照样在；
//   no-end    会话行已判失败、却还没有收尾时刻和退出码（读到一半落了收口的那种快照）：那句话和动作照样在；
//   later     崩过以后又跑过一回合（别的会话）：那句话还在，动作不在；
//   retried   同一条会话失败一回合、重试成功（刷新以后）：前一回合那句话和原因还在原处，动作不在；
//   retried-live  同上，开着页面看；
//   retried-tools 同一条会话，失败那一回合只跑了工具、没来得及说话，重试成功（刷新以后）：那句话和原因照样在；
//   woken-retried 挂了哨兵等构建，被叫醒后那一回合失败（回复并回等它的那一回合），重试成功（刷新以后）：那句话和
//                 叫醒那一回合自己的原因照样在；
//   stopped   手动停止的（非零退出）：不算异常，什么都不补；
//   running   任务在跑：那句话在，动作不在；
//   blocked   服务端说此刻重来不了（所在分组暂停着）：动作灰着，指上去说原因，点了不走。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { RetryTurnAction, Session, Task, TurnInterruption } from "@ash/shared";
import { appendMonitorWake } from "@ash/shared/monitor-wake";
import { ConversationFeed } from "../../src/task-detail/ConversationFeed.tsx";
import { TaskHeader } from "../../src/task-detail/TaskHeader.tsx";
import { buildConversationItems, type PersistedConversation, type TimelineEntry } from "../../src/task-detail/conversationModel.ts";
import { retryTurnActions } from "../../src/task-detail/turnRetry.ts";
import "../../src/styles/global.css";

const at = "2026-11-13T12:00:00.000Z";
const end = "2026-11-13T12:03:00.000Z";
const CAUSE: TurnInterruption = {
  reason: "模型上游连不上（503）",
  detail: "模型上游连不上（状态码 503），执行器以 exit 1 结束，执行器的原话：「unexpected status 503 Service Unavailable」",
};

const log = window as unknown as { __retried: string[] };
log.__retried = [];

const at2 = "2026-11-13T12:10:00.000Z";
const end2 = "2026-11-13T12:12:00.000Z";
const mark = (turn: Record<string, unknown>) => `\n\x1e${JSON.stringify(turn)}\n`;

const session = (taskId: string, id: string, over: Partial<Session> = {}) => ({
  id, taskId, agentType: "codex", role: "single", executor: "codex", startedAt: at, turnStartedAt: at, endedAt: end,
  exitStatus: 1, turnOutcome: "failed", ...over,
}) as unknown as Session;
const live = (taskId: string, sessionId: string, id: string, event: unknown, turnStartedAt?: string): TimelineEntry => ({
  kind: "server", id, event: { type: "agent.event", taskId, sessionId, role: "single", agentType: "codex", event, turnStartedAt },
} as never);
/** 同一条会话重试成功以后的会话行：最后一回合正常收口，前一回合的结局和原因按回合带着。 */
const retried = (taskId: string) => session(taskId, "s1", {
  turnStartedAt: at2, endedAt: end2, exitStatus: 0, turnOutcome: "completed",
  turnOutcomes: { [at]: "failed", [at2]: "completed" }, turnInterruptions: { [at]: CAUSE },
});

/** 服务端此刻对「重试这一回合」的结论；不给 = 服务端判了不能重来（不出）。 */
const RETRYABLE: RetryTurnAction = { ok: true, kind: "turn", sessionId: "s1" };
type Scene = { status?: Task["status"]; sessions: Session[]; persisted: PersistedConversation[]; timeline?: TimelineEntry[]; retry?: RetryTurnAction };
const SCENES: Record<string, (id: string) => Scene> = {
  persisted: (id) => {
    const s = session(id, "s1", { turnInterruptions: { [at]: CAUSE } });
    return { sessions: [s], persisted: [{ session: s, output: "按意见改一下构建脚本。", trace: [] }], retry: RETRYABLE };
  },
  live: (id) => {
    const s = session(id, "s1");
    return {
      sessions: [s], persisted: [],
      timeline: [
        live(id, "s1", "live:text", { kind: "text", text: "按意见改一下构建脚本。" }),
        live(id, "s1", "live:done", { kind: "done", exitStatus: 1, turnOutcome: "failed", interruption: CAUSE }),
      ],
      retry: RETRYABLE,
    };
  },
  legacy: (id) => {
    const s = session(id, "s1", { turnOutcome: null });
    return { sessions: [s], persisted: [{ session: s, output: "按意见改一下构建脚本。", trace: [] }], retry: RETRYABLE };
  },
  "no-end": (id) => {
    const s = session(id, "s1", { endedAt: null, exitStatus: null });
    return { sessions: [s], persisted: [{ session: s, output: "按意见改一下构建脚本。", trace: [] }], retry: RETRYABLE };
  },
  later: (id) => {
    const crashed = session(id, "s1", { turnInterruptions: { [at]: CAUSE } });
    const next = session(id, "s2", { startedAt: "2026-11-13T12:10:00.000Z", turnStartedAt: "2026-11-13T12:10:00.000Z", endedAt: "2026-11-13T12:12:00.000Z", exitStatus: 0, turnOutcome: "completed" });
    return {
      sessions: [crashed, next],
      persisted: [{ session: crashed, output: "按意见改一下构建脚本。", trace: [] }, { session: next, output: "又跑了一回合，好了。", trace: [] }],
    };
  },
  retried: (id) => {
    const s = retried(id);
    const output = [
      mark({ t: "user", text: "按意见改一下构建脚本。", at }), "改到一半。", mark({ t: "agentEnd", at: end }),
      mark({ t: "user", text: "按意见改一下构建脚本。", at: at2 }), "重试好了。", mark({ t: "agentEnd", at: end2 }),
    ].join("");
    const trace = [
      { at: "2026-11-13T12:01:00.000Z", turnStartedAt: at, event: { kind: "tool", name: "Edit", detail: "{}" } },
      { at: "2026-11-13T12:11:00.000Z", turnStartedAt: at2, event: { kind: "tool", name: "Edit", detail: "{}" } },
    ];
    return { sessions: [s], persisted: [{ session: s, output, trace: trace as never }] };
  },
  "retried-tools": (id) => {
    const s = retried(id);
    const output = [
      mark({ t: "user", text: "按意见改一下构建脚本。", at }),
      mark({ t: "user", text: "按意见改一下构建脚本。", at: at2 }), "重试好了。", mark({ t: "agentEnd", at: end2 }),
    ].join("");
    const trace = [
      { at: "2026-11-13T12:01:00.000Z", turnStartedAt: at, event: { kind: "tool", name: "Read", detail: "{\"file_path\":\"/repo/build.sh\"}" } },
      { at: "2026-11-13T12:11:00.000Z", turnStartedAt: at2, event: { kind: "tool", name: "Edit", detail: "{}" } },
    ];
    return { sessions: [s], persisted: [{ session: s, output, trace: trace as never }] };
  },
  "woken-retried": (id) => {
    const woke = "2026-11-13T12:05:00.000Z";
    const s = session(id, "s1", {
      turnStartedAt: at2, endedAt: end2, exitStatus: 0, turnOutcome: "completed",
      turnOutcomes: { [at]: "completed", [woke]: "failed", [at2]: "completed" }, turnInterruptions: { [woke]: CAUSE },
    });
    const event = { kind: "output" as const, monitorId: "m1", source: "构建", body: "BUILD FAILED" };
    const output = [
      mark({ t: "user", text: "按意见改一下构建脚本。", at }), "改好了，挂哨兵等构建。", mark({ t: "agentEnd", at: "2026-11-13T12:02:00.000Z" }),
      mark({ t: "user", text: `【哨兵事件】构建（monitorId=m1）\nBUILD FAILED`, monitorWake: appendMonitorWake(null, event), by: "system", at: woke }),
      "构建挂了，接着看。",
      mark({ t: "user", text: "按意见改一下构建脚本。", at: at2 }), "重试好了。", mark({ t: "agentEnd", at: end2 }),
    ].join("");
    const trace = [
      { at: "2026-11-13T12:01:00.000Z", turnStartedAt: at, event: { kind: "tool", name: "mcp__ash__start_monitor", detail: JSON.stringify({ description: "构建", command: "npm run build" }) } },
      { at: "2026-11-13T12:06:00.000Z", turnStartedAt: woke, event: { kind: "tool", name: "Read", detail: "{}" } },
      { at: "2026-11-13T12:11:00.000Z", turnStartedAt: at2, event: { kind: "tool", name: "Edit", detail: "{}" } },
    ];
    return { sessions: [s], persisted: [{ session: s, output, trace: trace as never }] };
  },
  "retried-live": (id) => {
    const s = retried(id);
    return {
      sessions: [s], persisted: [],
      timeline: [
        live(id, "s1", "live:text", { kind: "text", text: "改到一半。" }, at),
        live(id, "s1", "live:done", { kind: "done", exitStatus: 1, turnOutcome: "failed", interruption: CAUSE }, at),
        live(id, "s1", "live:text2", { kind: "text", text: "重试好了。" }, at2),
        live(id, "s1", "live:done2", { kind: "done", exitStatus: 0, turnOutcome: "completed" }, at2),
      ],
    };
  },
  stopped: (id) => {
    const s = session(id, "s1", { stoppedAs: "canceled", turnOutcome: "stopped" });
    return { sessions: [s], persisted: [{ session: s, output: "按意见改一下构建脚本。", trace: [] }] };
  },
  running: (id) => {
    const s = session(id, "s1", { turnInterruptions: { [at]: CAUSE } });
    return { status: "running", sessions: [s], persisted: [{ session: s, output: "按意见改一下构建脚本。", trace: [] }] };
  },
  blocked: (id) => {
    const s = session(id, "s1", { turnInterruptions: { [at]: CAUSE } });
    return {
      sessions: [s], persisted: [{ session: s, output: "按意见改一下构建脚本。", trace: [] }],
      retry: { ok: false, reason: "所在分组已暂停，先恢复分组再重试这一回合", kind: "turn", sessionId: "s1" },
    };
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
  // TaskDetail 同一条接法。
  const { turn: turnRetry } = retryTurnActions(scene.retry, async () => { log.__retried.push(id); });
  const noop = () => {};
  return (
    <section className={`${id}-fixture`} style={{ marginBottom: 24 }}>
      <TaskHeader task={task} actions={null} allTasks={[task]} conversationMarkdown="" busy={false} refreshing={false} reviewOpen={false}
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
