// 常驻会话被 CLI 自己唤醒续跑时，这一轮在会话流里长什么样。
//
// 现场（2026-09-11，团队调度台 uAzoSgyu-23h）：调度台挂了后台监控，通知一到就接着跑
// 工具，而 harness 一条消息都没 send 过 —— 服务端那会儿还没给这种自发回合补回合起点，
// 每条事件只能拿自己的时刻当 turnStartedAt 落 trace。读端于是把一个回合拆成十几颗
// 「执行过程 · 1 工具」的空气泡，每颗都没正文；用时更离谱：这些气泡都没有回合结束
// 标记，一路兜底到整条会话的 endedAt，于是排出 1m51s → 1m36s → … → 44s → 0s 这样一列
// 「离会话结束还剩多久」。夹在中间的 text 事件还会把 .md 里已经渲染过的正文再说一遍。
//
// 服务端已经补上回合起点（server/src/team/session-consumer.ts），但**老数据仍是碎的**，
// 所以读端这两道兜底得一直留着。
import assert from "node:assert/strict";
import { buildConversationItems } from "../src/task-detail/conversationModel.ts";

const STARTED = "2026-09-11T04:00:00.000Z";
const FIRST_ENDED = "2026-09-11T04:05:00.000Z";
const ENDED = "2026-09-11T04:20:00.000Z";
const FIRST_REPLY = "先看一圈现状。";
const SECOND_REPLY = "监听回来了，接着核对。";

const turn = (payload) => `\n\x1e${JSON.stringify(payload)}\n`;
const session = (id, endedAt) => ({
  id,
  taskId: "task",
  agentType: "claude",
  executor: "claude@ccb",
  role: "lead",
  startedAt: STARTED,
  endedAt,
  turnStartedAt: STARTED,
});
const agents = (items) => items.filter((item) => item.kind === "agent");
const toolCount = (item) => item.segments.reduce((total, segment) => total + segment.events.length, 0);

// ── ① 碎成一条条的自发回合:粘回同一颗气泡,正文不复读 ─────────────────────────
{
  const output = [
    `${FIRST_REPLY}\n`,
    turn({ t: "agentEnd", at: FIRST_ENDED }),
    `${SECOND_REPLY}\n`,
    turn({ t: "agentEnd", at: ENDED }),
  ].join("");
  const trace = [
    { at: "2026-09-11T04:00:01.000Z", turnStartedAt: STARTED, event: { kind: "run", model: "claude-fable-5", reasoningEffort: "xhigh" } },
    { at: "2026-09-11T04:00:30.000Z", turnStartedAt: STARTED, event: { kind: "tool", name: "Glob" } },
    { at: FIRST_ENDED, turnStartedAt: STARTED, event: { kind: "text", text: FIRST_REPLY } },
    // 这里往下是自发续跑的那一轮，老数据里每条事件都自成一个「回合」。
    { at: "2026-09-11T04:06:00.000Z", turnStartedAt: "2026-09-11T04:06:00.000Z", event: { kind: "text", text: SECOND_REPLY } },
    { at: "2026-09-11T04:07:00.000Z", turnStartedAt: "2026-09-11T04:07:00.000Z", event: { kind: "tool", name: "Bash" } },
    { at: "2026-09-11T04:08:00.000Z", turnStartedAt: "2026-09-11T04:08:00.000Z", event: { kind: "tool", name: "Bash" } },
    { at: "2026-09-11T04:09:00.000Z", turnStartedAt: "2026-09-11T04:09:00.000Z", event: { kind: "tool", name: "Bash" } },
  ];
  const row = session("sess-fragmented", ENDED);
  const items = agents(buildConversationItems([{ session: row, output, trace }], [row], []));

  assert.equal(items.length, 3, `自发回合的每条事件各成一颗气泡了(共 ${items.length} 颗) —— 页面上就是一串「1 工具」的空壳`);
  const leftover = items.filter((item) => item.id.startsWith("persisted:trace:"));
  assert.equal(leftover.length, 1, "无人认领的那些工具要粘成一颗气泡");
  assert.equal(toolCount(leftover[0]), 3, "粘起来的气泡要带上这一轮全部工具");
  assert.equal(leftover[0].markdown, "", ".md 已经渲染过这段正文了,兜底气泡再说一遍就是同一段话连出两遍");
  assert.equal(leftover[0].at, "2026-09-11T04:07:00.000Z", "起点取第一条实质事件,别把模型写字那几分钟算进执行过程的用时");
  assert.equal(
    items.filter((item) => item.markdown.includes(SECOND_REPLY)).length,
    1,
    "自发回合的正文被渲染了两遍",
  );
  console.log("   ✓ 碎成一条条的自发回合粘回同一颗气泡,正文不复读");
}

// ── ② 没有回合结束标记时,用时不许按会话结束时刻倒推 ─────────────────────────
{
  // 两轮都只有工具、没有正文（.md 里一个字都没有）。第一轮的结束时刻只能靠推断 ——
  // 推成整条会话的 endedAt 的话，它的「用时」就成了「离会话结束还剩多久」。
  const trace = [
    { at: "2026-09-11T04:02:00.000Z", turnStartedAt: "2026-09-11T04:02:00.000Z", event: { kind: "run", model: "claude-fable-5", reasoningEffort: "xhigh" } },
    { at: "2026-09-11T04:02:10.000Z", turnStartedAt: "2026-09-11T04:02:00.000Z", event: { kind: "tool", name: "Bash" } },
    { at: "2026-09-11T04:10:00.000Z", turnStartedAt: "2026-09-11T04:10:00.000Z", event: { kind: "run", model: "claude-fable-5", reasoningEffort: "xhigh" } },
    { at: "2026-09-11T04:10:10.000Z", turnStartedAt: "2026-09-11T04:10:00.000Z", event: { kind: "tool", name: "Bash" } },
  ];
  const row = session("sess-no-marker", ENDED);
  const items = agents(buildConversationItems([{ session: row, output: "", trace }], [row], []));

  assert.equal(items.length, 2, "两轮各带自己的 run,不该被粘成一颗");
  assert.equal(
    items[0].endedAt,
    "2026-09-11T04:10:00.000Z",
    "上一轮的结束时刻要收在下一轮开口之前,不能一路兜底到整条会话的 endedAt",
  );
  assert.equal(items[1].endedAt, ENDED, "最后一轮没有下一条发言,兜底到会话结束是对的");
  console.log("   ✓ 没有回合结束标记时,用时收在下一条发言之前");
}

console.log("conversation self-started turn ok");
