// 实时到达的步骤和正文归到**它到达时所在的那一回合**，下一回合开始之后也不改归属。
//
// 现场（2026-11-13，会话 b87DDpNK5rP6）：页面在回合中途读过一次盘，回合中间落了「哨兵已起」
// 「哨兵结束」两条记录，回合暂停后被哨兵叫醒、没经重读就接着看。实时那几步原来每次重排都
// 拿会话行上**此刻最新**那一回合的起点去认：叫醒一到，那个起点挪到了新回合，上一回合落在
// 记录之后的那一截就跨不回自己那颗气泡，另起一颗，时间还标成了新回合的开始（05:58:30，0 秒）。
//
// 这里照那一回合的时间线造夹具，按三种读盘时刻 × 两个阶段重排，断言上一回合的气泡划分、
// 每颗的起点在下一回合开始前后完全一致。孤儿气泡（回合中间的记录把一步切成没人认领的
// 一颗）有没有不归这里管，只比「前后是不是同一颗」。
//
// 结束时刻只断言「有、且不晚于下一回合」：实时流里的回合边界事件不带时刻，上一回合收在哪
// 一刻叫醒前取的是会话行上的 endedAt（它只描述最新那一回合），叫醒后取的是下面那条结算
// 说明 —— 差的是这两份记录之间那几毫秒，跟气泡归属无关。
import assert from "node:assert/strict";
import { buildConversationItems } from "../src/task-detail/conversationModel.ts";

const SESSION_ID = "b87DDpNK5rP6";
const FIRST_START = "2026-11-13T05:40:00.000Z";
const FIRST_END = "2026-11-13T05:41:12.000Z";
const T1 = "2026-11-13T05:55:05.331Z";
const PAUSED_AT = "2026-11-13T05:58:30.010Z";
const T2 = "2026-11-13T05:58:30.314Z";

const sentinel = (payload) => `\n\x1e${JSON.stringify(payload)}\n`;
const agents = (items) => items.filter((item) => item.kind === "agent");
const steps = (item) => item.segments.flatMap((segment) => segment.events).map((event) => event.label);
const at = (base, seconds) => new Date(Date.parse(base) + seconds * 1000).toISOString();

const sessionRow = (patch) => ({
  id: SESSION_ID,
  taskId: "Kzgtd-qMcMto",
  agentType: "claude",
  executor: "claude@ccb",
  role: "single",
  startedAt: FIRST_START,
  ...patch,
});

/* 一条会话上发生过的事，每件同时说清它在 .md、trace、实时流三处各留下什么。夹具里的读盘
   快照 = 这串里不晚于读盘时刻的那些（落盘那两份），实时流 = 晚于它的那些。 */
function happenings({ role = "single", stamp = true } = {}) {
  const list = [];
  const live = (turn, event, extra = {}) => ({
    kind: "server",
    event: {
      type: "agent.event", taskId: "Kzgtd-qMcMto", sessionId: SESSION_ID, role, agentType: "claude",
      model: "claude-opus-5-5", reasoningEffort: "high",
      ...(stamp && turn ? { turnStartedAt: turn } : {}),
      ...extra,
      event,
    },
  });
  const user = (time, text, turn, extra = {}) => list.push({
    at: time,
    md: sentinel({ t: "user", agent: "claude", text, at: time, ...(extra.bySystem ? { by: "system" } : {}) }),
    trace: [{ at: time, turnStartedAt: turn, event: { kind: "run", model: "claude-opus-5-5", reasoningEffort: "high" } }],
    live: {
      kind: "user", text, attachments: [], at: time, sessionId: SESSION_ID, sessionRole: role, source: "server",
      ...(extra.bySystem ? { bySystem: true } : {}),
      ...(extra.monitorWake ? { monitorWake: extra.monitorWake } : {}),
    },
  });
  const text = (time, body, turn) => list.push({
    at: time, md: body, trace: [{ at: time, turnStartedAt: turn, event: { kind: "text", text: body } }],
    live: live(turn, { kind: "text", text: body }),
  });
  const tool = (time, name, turn) => list.push({
    at: time, md: "", trace: [{ at: time, turnStartedAt: turn, event: { kind: "tool", name, detail: name } }],
    live: live(turn, { kind: "tool", name, detail: name }),
  });
  const aside = (time, body, notice) => list.push({
    at: time,
    md: sentinel({ t: "system", agent: "claude", text: body, aside: true, notice, at: time }),
    trace: [],
    // 时间线旁注不在任何一回合里，服务端也不给它带回合。
    live: live(null, { kind: "system", text: body, at: time, aside: true, notice }),
  });
  const settle = (time, body, turn) => list.push({
    at: time,
    md: sentinel({ t: "system", agent: "claude", text: body, level: "notice", at: time }),
    trace: [],
    live: live(turn, { kind: "system", text: body, at: time, level: "notice" }),
  });
  const usage = (time, turn) => {
    const event = { kind: "usage", usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: null, turns: 1 }, accounting: "incremental" };
    list.push({ at: time, md: "", trace: [{ at: time, turnStartedAt: turn, event }], live: live(turn, event) });
  };
  // 常驻调度台的 turnEnd 服务端只拿来收回合、不往前端播（team/session-consumer.ts），实时流里
  // 那一回合的结尾什么都没有；单飞的回合结束就是进程结束，播 done。
  const end = (time, turn) => list.push({
    at: time, md: sentinel({ t: "agentEnd", at: time }), trace: [],
    live: role === "lead" ? null : live(turn, { kind: "done", exitStatus: 0 }),
  });
  return { list, user, text, tool, aside, settle, usage, end };
}

/** 那一回合本身（之前另有一回合已经说完，于是它不是会话的第一回合）。 */
function singleScript(options) {
  const h = happenings(options);
  h.user(FIRST_START, "先看看仓库。", FIRST_START);
  h.text(at(FIRST_START, 30), "看完了。\n", FIRST_START);
  h.list.push({ at: FIRST_END, md: sentinel({ t: "agentEnd", at: FIRST_END }), trace: [], live: null });

  h.user(T1, "排查项目目录体积", T1);
  h.text(at(T1, 4), "先看一下各目录的大小。\n\n", T1);
  for (let index = 0; index < 18; index += 1) h.tool(at(T1, 10 + index * 8), `Bash ${index + 1}`, T1);
  h.text("2026-11-13T05:57:55.000Z", "Committed the cleanup script; the retention test will run.", T1);
  h.aside("2026-11-13T05:58:03.001Z", "哨兵已起：原始事件流保留期回归", { kind: "monitor.started", description: "原始事件流保留期回归" });
  h.tool("2026-11-13T05:58:03.005Z", "mcp__ash__start_monitor", T1);
  h.aside("2026-11-13T05:58:05.563Z", "哨兵结束：原始事件流保留期回归", { kind: "monitor.finished", description: "原始事件流保留期回归" });
  h.text("2026-11-13T05:58:06.200Z", "Meanwhile, estimate how much the runs directory will shrink.\n\n", T1);
  h.tool("2026-11-13T05:58:09.818Z", "Bash tail", T1);
  h.tool("2026-11-13T05:58:20.049Z", "mcp__ash__pause_task", T1);
  h.text("2026-11-13T05:58:28.494Z", "已挂哨兵等回归结果，先暂停。", T1);
  h.usage("2026-11-13T05:58:28.500Z", T1);
  h.settle("2026-11-13T05:58:29.992Z", "本轮已暂停：等哨兵结果。", T1);
  h.aside("2026-11-13T05:58:30.005Z", "本轮已暂停：等哨兵结果。", { kind: "receipt" });
  h.end(PAUSED_AT, T1);
  const pausedCount = h.list.length;

  h.user(T2, "哨兵回来了：回归通过。", T2, {
    bySystem: true,
    monitorWake: { version: 1, events: [{ kind: "ended", monitorId: "m1", source: "原始事件流保留期回归", body: "EXIT=0" }], omittedEvents: 0 },
  });
  h.tool("2026-11-13T05:58:35.000Z", "Bash du", T2);
  h.tool("2026-11-13T05:58:40.000Z", "Read report", T2);
  h.text("2026-11-13T05:58:45.000Z", "回归通过，目录体积降到原来的三成。", T2);
  return { list: h.list, pausedCount };
}

/** 在 `readAt` 那一刻读盘，再把之后到达的那段按阶段接上去重排。 */
function replay(script, { readAt, phase, sessionAtRead, sessionNow }) {
  const upTo = phase === "paused" ? script.list.slice(0, script.pausedCount) : script.list;
  const persistedPart = script.list.filter((entry) => entry.at <= readAt);
  const livePart = upTo.filter((entry) => entry.at > readAt && entry.live);
  const output = persistedPart.map((entry) => entry.md).join("");
  const trace = persistedPart.flatMap((entry) => entry.trace);
  const persisted = output.trim() || trace.length ? [{ session: sessionAtRead, output, trace }] : [];
  const timeline = livePart.map((entry, index) => ({ ...entry.live, id: `live-${index}` }));
  return buildConversationItems(persisted, [sessionNow], timeline);
}

/* 下一回合开始之前的那一截：每颗气泡的身份、起止时刻、正文和那几步。 */
function previousTurnShape(items, nextTurnAt) {
  const wake = items.findIndex((item) => item.kind === "user" && item.at === nextTurnAt);
  const before = wake < 0 ? items : items.slice(0, wake);
  return agents(before).map((item) => ({
    id: item.id, at: item.at, markdown: item.markdown, steps: steps(item),
  }));
}

function assertPreviousTurnsClosed(items, nextTurnAt, label) {
  const wake = items.findIndex((item) => item.kind === "user" && item.at === nextTurnAt);
  for (const item of agents(wake < 0 ? items : items.slice(0, wake))) {
    assert.ok(item.endedAt, `${label}：上一回合的气泡 ${item.id} 没有收口`);
    assert.ok(Date.parse(item.endedAt) <= Date.parse(nextTurnAt), `${label}：上一回合的气泡收在了下一回合之后 ${item.endedAt}`);
  }
}

const owner = (shape, needle) => shape.find((bubble) => bubble.steps.includes(needle) || bubble.markdown.includes(needle))?.id;

const pausedRow = sessionRow({ turnStartedAt: T1, endedAt: PAUSED_AT });
const wokenRow = sessionRow({ turnStartedAt: T2, endedAt: null });
const readMoments = [
  { name: "回合开始之前读盘（全程实时）", readAt: "2026-11-13T05:55:00.000Z", sessionAtRead: sessionRow({ turnStartedAt: FIRST_START, endedAt: FIRST_END }) },
  { name: "回合中间、两条记录之前读盘", readAt: "2026-11-13T05:57:58.000Z", sessionAtRead: sessionRow({ turnStartedAt: T1, endedAt: null }) },
  { name: "回合中间、两条记录之后读盘", readAt: "2026-11-13T05:58:07.000Z", sessionAtRead: sessionRow({ turnStartedAt: T1, endedAt: null }) },
];

const script = singleScript();
for (const moment of readMoments) {
  const pausedItems = replay(script, { ...moment, phase: "paused", sessionNow: pausedRow });
  const wokenItems = replay(script, { ...moment, phase: "woken", sessionNow: wokenRow });
  const paused = previousTurnShape(pausedItems, T2);
  const woken = previousTurnShape(wokenItems, T2);
  // 1. 叫醒前后，上一回合的气泡划分、每颗的起点、正文与步骤一模一样。
  assert.deepEqual(woken, paused, `${moment.name}：下一回合一开始，上一回合的气泡就变了`);
  assertPreviousTurnsClosed(pausedItems, T2, `${moment.name}（刚暂停）`);
  assertPreviousTurnsClosed(wokenItems, T2, `${moment.name}（被叫醒）`);
  // 2. 实时到达的那几步和收尾正文，叫醒前后落在同一颗气泡里（且前后都有归属）。
  for (const needle of ["Bash tail", "mcp__ash__pause_task", "已挂哨兵等回归结果"]) {
    assert.ok(owner(paused, needle), `${moment.name}：「${needle}」没有落进任何气泡`);
    assert.equal(owner(woken, needle), owner(paused, needle), `${moment.name}：「${needle}」在叫醒之后换了气泡`);
  }
  // 3. 上一回合的气泡不拿下一回合的起点当时间。
  for (const bubble of woken) {
    assert.ok(Date.parse(bubble.at) < Date.parse(T2), `${moment.name}：上一回合的气泡被标成了下一回合的起点 ${bubble.at}`);
  }
  // 4. 新回合自己另起一颗，时间是它自己的起点。
  const next = agents(wokenItems).find((item) => steps(item).includes("Bash du"));
  assert.ok(next && !woken.some((bubble) => bubble.id === next.id), `${moment.name}：新回合被并进了上一回合`);
  assert.equal(next.at, T2, `${moment.name}：新回合的气泡时间该是它自己的起点`);
}

// 5. 全程实时、读盘在回合中间两种都该只有一颗上一回合的气泡（记录不拆气泡）。
{
  const shape = previousTurnShape(replay(script, { ...readMoments[1], phase: "woken", sessionNow: wokenRow }), T2);
  const turn = shape.filter((bubble) => Date.parse(bubble.at) >= Date.parse(T1));
  assert.equal(turn.length, 1, "回合中间落下的记录不该把这一回合劈开");
  assert.equal(turn[0].at, T1);
}

// ── 真边界照旧拆 ────────────────────────────────────────────────────────────

const liveEvent = (event, extra = {}) => ({
  kind: "server",
  id: `e-${Math.random().toString(36).slice(2)}`,
  event: {
    type: "agent.event", taskId: "t", sessionId: SESSION_ID, role: "single", agentType: "claude",
    model: "claude-opus-5-5", reasoningEffort: "high", turnStartedAt: T1, ...extra, event,
  },
});
const asideNote = (time, body = "已预约完成后审查") => liveEvent({ kind: "system", text: body, at: time, aside: true }, { turnStartedAt: undefined });
const liveUser = (time, text, extra = {}) => ({
  kind: "user", id: `u-${time}`, text, attachments: [], at: time, sessionId: SESSION_ID, sessionRole: "single", source: "server", ...extra,
});
const midTurnPersisted = () => {
  const session = sessionRow({ turnStartedAt: T1, endedAt: null });
  return [{
    session,
    output: sentinel({ t: "user", agent: "claude", text: "排查项目目录体积", at: T1 }) + "先看一下各目录的大小。\n",
    trace: [
      { at: T1, turnStartedAt: T1, event: { kind: "run", model: "claude-opus-5-5", reasoningEffort: "high" } },
      { at: at(T1, 4), turnStartedAt: T1, event: { kind: "text", text: "先看一下各目录的大小。\n" } },
    ],
  }];
};

// 6. 真人插话之后（同一回合、没开新回合）：插话后面的话另起一颗，时间是插话那一刻。
{
  const interject = at(T1, 60);
  const items = buildConversationItems(midTurnPersisted(), [sessionRow({ turnStartedAt: T1, endedAt: null })], [
    liveEvent({ kind: "tool", name: "Bash", detail: "du" }),
    asideNote(at(T1, 50)),
    liveUser(interject, "顺便看看 node_modules"),
    liveEvent({ kind: "tool", name: "Bash", detail: "du node_modules" }),
    asideNote(at(T1, 70)),
    liveEvent({ kind: "text", text: "node_modules 占了大头。" }),
  ]);
  const bubbles = agents(items);
  assert.equal(bubbles.length, 2, "真人插话后面的话该另起一颗");
  assert.deepEqual(steps(bubbles[0]), ["Bash"]);
  assert.deepEqual(steps(bubbles[1]), ["Bash"]);
  assert.match(bubbles[1].markdown, /node_modules 占了大头/);
  assert.equal(bubbles[1].at, interject);
}

// 7. done 之后的新回合（CLI 自己续跑、没有用户条目）：不并进上一回合。
{
  const items = buildConversationItems([], [sessionRow({ turnStartedAt: T2, endedAt: null })], [
    liveUser(T1, "排查项目目录体积"),
    liveEvent({ kind: "text", text: "第一回合。" }),
    liveEvent({ kind: "done", exitStatus: 0 }),
    asideNote(at(T2, -0.2)),
    liveEvent({ kind: "text", text: "第二回合。" }, { turnStartedAt: T2 }),
  ]);
  const bubbles = agents(items);
  assert.equal(bubbles.length, 2, "done 之后的新回合该另起一颗");
  assert.equal(bubbles[1].markdown, "第二回合。");
  assert.equal(bubbles[1].at, T2);
}

// 8. 非 aside 的系统注记开的新一轮：中间没有回合边界事件（页面在上一回合中途读的盘），
//    会话行也还没刷到新回合 —— 只凭事件自己带的回合，就不许把新一轮接进旧气泡。
for (const rowTurn of [T1, T2]) {
  const items = buildConversationItems(midTurnPersisted(), [sessionRow({ turnStartedAt: rowTurn, endedAt: null })], [
    liveEvent({ kind: "system", text: "继续（从中断处）", at: T2 }, { turnStartedAt: T2 }),
    liveEvent({ kind: "tool", name: "Bash", detail: "du" }, { turnStartedAt: T2 }),
  ]);
  const bubbles = agents(items);
  assert.equal(bubbles.length, 2, `会话行停在 ${rowTurn}：非 aside 系统注记开的新一轮不该接进旧气泡`);
  assert.deepEqual(steps(bubbles[0]), []);
  assert.equal(bubbles[1].at, T2);
}

// 9. 换了身份（就地验证复用同一条会话）：审查者的话不写进实现者的气泡。
{
  const VERIFY_AT = at(T1, 120);
  const items = buildConversationItems(midTurnPersisted(), [sessionRow({ turnStartedAt: VERIFY_AT, endedAt: null })], [
    liveEvent({ kind: "tool", name: "Bash", detail: "du" }),
    asideNote(at(T1, 110), "第 2 轮验证开始"),
    liveEvent({ kind: "tool", name: "Bash", detail: "npm test" }, { turnStartedAt: VERIFY_AT, verifyRound: 2 }),
    asideNote(at(T1, 130)),
    liveEvent({ kind: "text", text: "验证通过。" }, { turnStartedAt: VERIFY_AT, verifyRound: 2 }),
  ]);
  const bubbles = agents(items);
  assert.equal(bubbles.length, 2, "换了身份该另起一颗");
  assert.equal(bubbles[1].reviewer?.round, 2);
  assert.deepEqual(steps(bubbles[1]), ["Bash"]);
  assert.equal(bubbles[1].markdown, "验证通过。");
  assert.equal(bubbles[1].at, VERIFY_AT);
}

// 10. 没带回合的事件（服务端还没升级）退回按会话行认：叫醒之前照旧并回同一颗。
{
  const legacy = singleScript({ stamp: false });
  const shape = previousTurnShape(replay(legacy, { ...readMoments[1], phase: "paused", sessionNow: pausedRow }), T2);
  assert.equal(owner(shape, "Bash tail"), owner(shape, "Committed the cleanup script"));
}

// ── 团队页：常驻会话连着两回合 ────────────────────────────────────────────────
//
// 调度台的会话行上记的是「最近一次投入」，时间线上用户那句话按他说话的时刻落、回合按
// 投递口那一刻起算，两者差着一截；任务一直 running，页面不会自己重读。
{
  const LEAD_T1 = "2026-11-13T06:00:00.120Z";
  const LEAD_T1_SAID = "2026-11-13T06:00:00.000Z";
  const LEAD_T2 = "2026-11-13T06:10:00.120Z";
  const LEAD_T2_SAID = "2026-11-13T06:10:00.000Z";
  const h = happenings({ role: "lead" });
  h.list.push({
    at: LEAD_T1_SAID,
    md: sentinel({ t: "user", agent: "claude", text: "拆成三块派出去", at: LEAD_T1_SAID }),
    trace: [{ at: LEAD_T1, turnStartedAt: LEAD_T1, event: { kind: "run", model: "claude-opus-5-5", reasoningEffort: "high" } }],
    live: { kind: "user", text: "拆成三块派出去", attachments: [], at: LEAD_T1_SAID, sessionId: SESSION_ID, sessionRole: "lead", source: "server" },
  });
  h.text(at(LEAD_T1, 3), "先看一下仓库结构。\n\n", LEAD_T1);
  h.tool(at(LEAD_T1, 10), "Glob", LEAD_T1);
  h.aside(at(LEAD_T1, 20), "已派出 3 个执行者", { kind: "receipt" });
  h.tool(at(LEAD_T1, 21), "mcp__ash__dispatch", LEAD_T1);
  h.text(at(LEAD_T1, 30), "派好了，等它们回话。", LEAD_T1);
  h.end(at(LEAD_T1, 31), LEAD_T1);
  const pausedCount = h.list.length;
  h.list.push({
    at: LEAD_T2_SAID,
    md: sentinel({ t: "user", agent: "claude", text: "进度怎么样", at: LEAD_T2_SAID }),
    trace: [],
    live: { kind: "user", text: "进度怎么样", attachments: [], at: LEAD_T2_SAID, sessionId: SESSION_ID, sessionRole: "lead", source: "server" },
  });
  h.tool(at(LEAD_T2, 2), "mcp__ash__list_tasks", LEAD_T2);
  h.text(at(LEAD_T2, 5), "两个做完了。", LEAD_T2);
  const team = { list: h.list, pausedCount };
  const lead = (patch) => sessionRow({ role: "lead", startedAt: LEAD_T1, ...patch });
  const moment = { readAt: at(LEAD_T1, 12), sessionAtRead: lead({ turnStartedAt: LEAD_T1, endedAt: null }) };
  const idle = previousTurnShape(replay(team, { ...moment, phase: "paused", sessionNow: lead({ turnStartedAt: LEAD_T1, endedAt: null }) }), LEAD_T2_SAID);
  const next = previousTurnShape(replay(team, { ...moment, phase: "woken", sessionNow: lead({ turnStartedAt: LEAD_T2, endedAt: null }) }), LEAD_T2_SAID);
  assert.deepEqual(next, idle, "团队调度台：下一回合一开始，上一回合的气泡就变了");
  assert.equal(owner(next, "mcp__ash__dispatch"), owner(next, "Glob"), "团队调度台：记录之后那几步该留在这一回合的气泡里");
  assert.equal(owner(next, "派好了"), owner(next, "Glob"));
}

// ── 团队调度台被后台通知叫醒、自己开的下一轮 ─────────────────────────────────
//
// 没有输入、实时流里也没有回合边界：只凭事件自己带的回合把两轮分开。
{
  const LEAD_T1 = "2026-11-13T06:00:00.120Z";
  const LEAD_T1_SAID = "2026-11-13T06:00:00.000Z";
  const LEAD_T2 = "2026-11-13T06:10:00.000Z";
  const leadRow = (patch) => sessionRow({ role: "lead", startedAt: LEAD_T1, ...patch });
  const leadEvent = (event, turn) => ({ ...liveEvent(event, { role: "lead", turnStartedAt: turn }) });
  const persistedT1 = (ended) => [{
    session: leadRow({ turnStartedAt: LEAD_T1, endedAt: null }),
    output: sentinel({ t: "user", agent: "claude", text: "拆成三块派出去", at: LEAD_T1_SAID })
      + "第一回合：已派出执行者，等待结果。"
      + (ended ? sentinel({ t: "agentEnd", at: "2026-11-13T06:01:00.000Z" }) : ""),
    trace: [
      { at: LEAD_T1, turnStartedAt: LEAD_T1, event: { kind: "run", model: "claude-opus-5-5", reasoningEffort: "high" } },
      { at: at(LEAD_T1, 5), turnStartedAt: LEAD_T1, event: { kind: "tool", name: "Glob", detail: "Glob" } },
      { at: at(LEAD_T1, 9), turnStartedAt: LEAD_T1, event: { kind: "text", text: "第一回合：已派出执行者，等待结果。" } },
    ],
  }];
  const spontaneous = [
    leadEvent({ kind: "tool", name: "mcp__ash__list_tasks", detail: "list" }, LEAD_T2),
    leadEvent({ kind: "text", text: "第二回合：后台任务通知唤醒，开始汇总结果。" }, LEAD_T2),
  ];
  const assertSplit = (items, label) => {
    const bubbles = agents(items);
    assert.equal(bubbles.length, 2, `${label}：自己开的下一轮被接进了上一轮`);
    const [previous, next] = bubbles;
    assert.ok(!previous.markdown.includes("第二回合"), `${label}：上一轮的气泡里混进了下一轮的话`);
    assert.ok(!steps(previous).includes("mcp__ash__list_tasks"), `${label}：上一轮的气泡里混进了下一轮的步骤`);
    assert.equal(next.at, LEAD_T2, `${label}：下一轮的气泡该从它自己的起点算`);
    assert.equal(next.continuation, false, `${label}：下一轮要重新报身份，不画成上一段的下半截`);
    return previous;
  };

  // 1. 页面在上一轮中途读的盘：记录之后那几步还留在上一轮，下一轮另起一颗。
  {
    const items = buildConversationItems(persistedT1(false), [leadRow({ turnStartedAt: LEAD_T2, endedAt: null })], [
      asideNote(at(LEAD_T1, 20), "已派出 3 个执行者"),
      leadEvent({ kind: "tool", name: "mcp__ash__dispatch", detail: "dispatch" }, LEAD_T1),
      leadEvent({ kind: "text", text: "派好了。" }, LEAD_T1),
      ...spontaneous,
    ]);
    const previous = assertSplit(items, "中途读盘");
    assert.deepEqual(steps(previous), ["Glob", "mcp__ash__dispatch"]);
    assert.match(previous.markdown, /派好了/);
  }
  // 2. 上一轮已经落盘收口（读盘那时调度台正待命）：同样另起一颗，上一轮的用时不变。
  {
    const items = buildConversationItems(persistedT1(true), [leadRow({ turnStartedAt: LEAD_T2, endedAt: null })], spontaneous);
    const previous = assertSplit(items, "上一轮已收口");
    assert.equal(previous.endedAt, "2026-11-13T06:01:00.000Z");
  }
  // 3. 全程实时：两轮都没落盘、中间什么都没有。
  {
    const items = buildConversationItems([], [leadRow({ turnStartedAt: LEAD_T2, endedAt: null })], [
      liveUser(LEAD_T1_SAID, "拆成三块派出去", { sessionRole: "lead" }),
      leadEvent({ kind: "text", text: "第一回合：已派出执行者，等待结果。" }, LEAD_T1),
      ...spontaneous,
    ]);
    assertSplit(items, "全程实时");
  }
}

// ── 身份对不上就不认，时刻再像也不行 ───────────────────────────────────────────
//
// 跨记录回捞到的那颗记着自己是另一回合的，哪怕它的 `at`（被插话推晚了）不早于这条事件
// 的回合起点，也不能接进去。
{
  const OTHER = at(T1, -600);
  const items = buildConversationItems(midTurnPersisted(), [sessionRow({ turnStartedAt: T1, endedAt: null })], [
    asideNote(at(T1, 30)),
    liveEvent({ kind: "text", text: "另一回合的话。" }, { turnStartedAt: OTHER }),
  ]);
  const bubbles = agents(items);
  assert.equal(bubbles.length, 2, "回合身份不同的气泡不该被接上");
  assert.equal(bubbles[1].markdown, "另一回合的话。");
}

console.log("conversation live turn owner: ok");
