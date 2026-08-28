// 原生引导（steer）落进会话流的形状。
//
// 引导不结束回合：sentinel 之后的事件仍带着老的 turnStartedAt 落 trace，而 .md 那边已经
// 被切成「引导前 / 引导后」两段。真实现场里引导几乎总落在 agent 连着跑工具、一个字还没
// 吐的时候 —— 那一段没有 .md 正文，读端若只在渲染 agent 段时才顺手切 trace，就永远切不
// 动，整组连正文带工具落进「无正文兜底气泡」，跟引导后那段 .md 正文重复渲染一遍。
// 用户看到的症状：自己发的引导消息上下各挂着一份一模一样的回复。
import assert from "node:assert/strict";
import { buildConversationItems } from "../src/task-detail/conversationModel.ts";

const SESSION_STARTED = "2026-08-27T11:04:20.900Z";
const FIRST_ENDED = "2026-08-27T11:09:21.940Z";
const TURN_STARTED = "2026-08-27T11:28:28.797Z";
const STEER_AT = "2026-08-27T11:29:07.193Z";
const TURN_ENDED = "2026-08-27T11:43:45.231Z";
const FIRST_REPLY = "先看了一圈代码。";
const REPLY = "改好了：两处调用点都换成了新的判据。";

const turn = (payload) => `\n\x1e${JSON.stringify(payload)}\n`;
const output = [
  `${FIRST_REPLY}\n`,
  turn({ t: "agentEnd", at: FIRST_ENDED }),
  turn({ t: "user", agent: "claude", text: "先纠正你一个错误。", at: TURN_STARTED }),
  turn({ t: "user", agent: "claude", text: "对了，你先把刚才那个任务改成能预约审核的状态", at: STEER_AT }),
  `${REPLY}\n`,
  turn({ t: "agentEnd", at: TURN_ENDED }),
].join("");

const session = {
  id: "sess",
  taskId: "task",
  agentType: "claude",
  executor: "claude@ccb",
  role: "single",
  startedAt: SESSION_STARTED,
  endedAt: TURN_ENDED,
  turnStartedAt: TURN_STARTED,
};

// 引导所在的那一轮：整组 trace 全挂在引导前的 turnStartedAt 上 —— 服务端就是这么落盘的。
const trace = [
  { at: "2026-08-27T11:04:21.000Z", turnStartedAt: SESSION_STARTED, event: { kind: "tool", name: "Glob" } },
  { at: FIRST_ENDED, turnStartedAt: SESSION_STARTED, event: { kind: "text", text: FIRST_REPLY } },
  { at: "2026-08-27T11:28:28.805Z", turnStartedAt: TURN_STARTED, event: { kind: "run", model: "claude-opus-5", reasoningEffort: "high" } },
  { at: "2026-08-27T11:28:40.000Z", turnStartedAt: TURN_STARTED, event: { kind: "tool", name: "Read" } },
  { at: "2026-08-27T11:29:00.000Z", turnStartedAt: TURN_STARTED, event: { kind: "tool", name: "Grep" } },
  { at: "2026-08-27T11:35:46.559Z", turnStartedAt: TURN_STARTED, event: { kind: "tool", name: "Edit" } },
  { at: "2026-08-27T11:43:44.485Z", turnStartedAt: TURN_STARTED, event: { kind: "text", text: REPLY } },
  {
    at: "2026-08-27T11:43:44.485Z",
    turnStartedAt: TURN_STARTED,
    event: {
      kind: "usage",
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: null, turns: 1 },
      accounting: "incremental",
    },
  },
];

const items = buildConversationItems([{ session, output, trace }], [session], []);
const agents = items.filter((item) => item.kind === "agent");
const users = items.filter((item) => item.kind === "user");

assert.equal(users.length, 2, "两条真人消息（原追问 + 引导）都该各自成一个气泡");
assert.equal(
  agents.filter((item) => item.markdown.includes(REPLY)).length,
  1,
  "引导后的回复只能出现一次 —— 兜底气泡不得把同一段正文再渲染一遍",
);

// 顺序：首轮 → 追问 → 引导前的执行过程 → 引导 → 引导后的回复。
assert.deepEqual(
  items.map((item) => (item.kind === "user" ? `user:${item.at}` : `agent:${item.at}`)),
  [
    `agent:${SESSION_STARTED}`,
    `user:${TURN_STARTED}`,
    `agent:${TURN_STARTED}`,
    `user:${STEER_AT}`,
    `agent:${STEER_AT}`,
  ],
);

const [, before, after] = agents;
assert.equal(before.markdown, "", "引导前那一段只跑了工具，没有正文");
assert.deepEqual(
  before.segments.flatMap((segment) => segment.events.map((event) => event.label)),
  ["Read", "Grep"],
  "引导前的工具调用留在引导前那个气泡里",
);
assert.equal(before.endedAt, STEER_AT, "引导前那一段收口在引导时刻，用时才算得对");
assert.deepEqual(
  after.segments.flatMap((segment) => segment.events.map((event) => event.label)),
  ["Edit"],
  "引导后的工具调用跟着引导后那段正文走",
);
assert.equal(after.markdown, REPLY);
assert.equal(after.usage?.output, 2, "本轮用量跟着正文所在的气泡");

console.log("conversation-steer ok");
