// 回合头上的「起因」（turnCause）：不是你发话起头的回合，头上写明是谁让它接着跑的。
//
//   ① 系统续跑带着缘由：它起头的那一回合头上写对应那一句；那条「〔系统〕继续（从中断处）」不再作为
//      回执收进上一回合的「N 条记录」，也不在原处另画一行。落盘重建和直播到达两路结果一样，每种缘由都是。
//   ② 老记录没有缘由：写「系统续跑」。
//   ③ 你发话起头的回合没有起因；哨兵叫醒的回合仍是「被哨兵叫醒」。
//   ④ 旁路回合起的续跑（审查、就地验证、辩论那一段）、审查者那一侧的回合不加这一句，记录照旧是回执。
//   ⑤ 审查段的起止认法不变：真实历史会话夹具里的续跑记录带上缘由前后，审查段一模一样。
//   ⑥ 团队页同一套：头上有那一句，那条记录不再单独一行。
//   ⑦ 几条会话交错续跑（先后起跑、稍后才各自开口）：每条会话认自己的那一条，别的会话的续跑、输入、
//      旁路续跑都碰不到它；落盘重建和直播到达一样，任务页和团队页一样。
import assert from "node:assert/strict";
import type { Session } from "@ash/shared";
import { appendMonitorWake, type MonitorWakeEvent } from "@ash/shared/monitor-wake";
import { RESUME_REASONS, type ResumeReason, type SystemResume } from "@ash/shared/system-resume";
import { readSource } from "../../scripts/read-source.mjs";
import { buildConversationItems, type ConversationItem, type TimelineEntry } from "../src/task-detail/conversationModel.ts";
import { foldMonitorWakes } from "../src/task-detail/monitorWakeTurns.ts";
import { conversationFeedRows } from "../src/task-detail/conversationReviewLanes.ts";
import { conversationDebateRows } from "../src/task-detail/conversationDebateRows.ts";
import { conversationSystemRows } from "../src/task-detail/conversationSystemRows.ts";
import { turnCauseText } from "../src/task-detail/turnCause.ts";
import { teamFeedRows } from "../src/team/teamModel.ts";

type Agent = Extract<ConversationItem, { kind: "agent" }>;
const MARKER = "〔系统〕继续（从中断处）";
const T0 = Date.parse("2026-11-13T12:00:00.000Z");
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString();
const session = (extra: Partial<Session> = {}) => ({
  id: "s1", taskId: "t1", agentType: "claude", executor: "claude@nodemach", role: "single",
  startedAt: at(0), endedAt: at(60), ...extra,
}) as unknown as Session;
const line = (turn: Record<string, unknown>) => `\n\x1e${JSON.stringify(turn)}\n`;
const end = (minute: number) => line({ t: "agentEnd", at: at(minute) });
const run = (minute: number) => ({ at: at(minute), turnStartedAt: at(minute), event: { kind: "run", model: "claude-opus-5-5", reasoningEffort: "high" } });
const text = (minute: number, turn: number, body: string) => ({ at: at(minute), turnStartedAt: at(turn), event: { kind: "text", text: body } });
const agents = (items: readonly ConversationItem[]) => items.filter((item): item is Agent => item.kind === "agent");
const resumeEvents = (items: readonly ConversationItem[]) => items.filter((item) => item.kind === "event" && item.text.includes(MARKER));

/** 会话页那一条流水线（同 ConversationFeed）：哨兵并回 → 审查段 → 辩论 → 回执归属。 */
function feed(items: ConversationItem[]) {
  const folded = foldMonitorWakes(items);
  const display = conversationSystemRows(conversationDebateRows(conversationFeedRows(folded)));
  const turns = display.rows.flatMap((row) => row.kind === "item" && row.item.kind === "agent" ? [row.item] : []);
  return {
    causes: turns.map((turn) => turnCauseText(turn)),
    // 回合边界（「本回合结束」）只有直播那一路有，落盘重建本来就没有，与这里无关，不比。
    receipts: turns.map((turn) => (display.receipts.get(turn.id) ?? [])
      .filter((receipt) => receipt.item?.variant !== "boundary").map((receipt) => receipt.item?.text ?? receipt.id)),
    inline: display.rows.flatMap((row) => row.kind === "item" && row.item.kind === "event" ? [row.item.text] : []),
    orphan: display.rows.flatMap((row) => row.kind === "footnote" ? row.receipts.map((receipt) => receipt.item?.text ?? receipt.id) : []),
  };
}

/** 第一回合说完 → 系统续跑（带不带缘由由 marker 定）→ 第二回合，落盘一份。 */
function persistedResume(marker: string, extra: Partial<Session> = {}) {
  const s = session(extra);
  const output = [
    line({ t: "user", agent: "claude", text: "把按钮改一下", at: at(0) }),
    "改好了，暂停等结果。", end(5),
    marker,
    "接着跑完了。", end(12),
  ].join("");
  const trace = [run(0), text(1, 0, "改好了，暂停等结果。"), run(10), text(11, 10, "接着跑完了。")];
  return buildConversationItems([{ session: s, output, trace: trace as never }], [s], []);
}

/** 同一件事，开着页面看：第一回合已落盘，续跑那一刻起全是直播到达的事件。 */
function liveResume(resume: SystemResume | undefined) {
  const s = session({ endedAt: null });
  const output = [line({ t: "user", agent: "claude", text: "把按钮改一下", at: at(0) }), "改好了，暂停等结果。", end(5)].join("");
  const ev = (id: string, event: Record<string, unknown>, turnStartedAt?: string): TimelineEntry => ({
    kind: "server", id,
    event: { taskId: "t1", sessionId: "s1", role: "single", agentType: "claude", ...(turnStartedAt ? { turnStartedAt } : {}), event } as never,
  });
  const timeline: TimelineEntry[] = [
    ev("e0", { kind: "turnEnd" }),
    ev("e1", { kind: "system", text: MARKER, at: at(10), ...(resume ? { resume } : {}) }),
    ev("e2", { kind: "run", model: "claude-opus-5-5", reasoningEffort: "high" }, at(10)),
    ev("e3", { kind: "text", text: "接着跑完了。" }, at(10)),
    ev("e4", { kind: "turnEnd" }),
  ];
  return buildConversationItems([{ session: s, output, trace: [run(0), text(1, 0, "改好了，暂停等结果。")] as never }], [s], timeline);
}

const EXPECTED: Record<ResumeReason, string> = {
  queue: "队列续跑", run: "手动续跑", retry: "你点了重试", group: "分组运行", wake: "上游完成后续跑", repair: "打回重做",
};

// ① 每种缘由，两路各一遍 ────────────────────────────────────────────────────────
for (const reason of RESUME_REASONS) {
  const resume = { reason };
  const persisted = persistedResume(line({ t: "system", agent: "claude", text: MARKER, resume, at: at(10) }));
  assert.equal(agents(persisted).length, 2, `${reason}：续跑没把两回合分开`);
  assert.deepEqual(agents(persisted).map((turn) => turn.resumeCause?.reason ?? null), [null, reason]);
  const fromDisk = feed(persisted);
  assert.deepEqual(fromDisk.causes, [null, EXPECTED[reason]], `${reason}：落盘重建的回合头不对`);
  assert.equal(fromDisk.receipts.flat().some((receipt) => receipt.includes(MARKER)), false, `${reason}：续跑记录还在上一回合的记录里`);
  assert.equal(fromDisk.inline.some((note) => note.includes(MARKER)), false, `${reason}：续跑记录还在原处单独画了一行`);
  assert.equal(fromDisk.orphan.some((note) => note.includes(MARKER)), false, `${reason}：续跑记录落进了原处的「N 条记录」`);
  // 记录本身还在条目表里（审查段的起止认它），只是不再画。
  assert.equal(resumeEvents(persisted).length, 1);

  const live = feed(liveResume(resume));
  assert.deepEqual(live, fromDisk, `${reason}：开着页面看和刷新以后不一样`);
}

// 回复还没来（CLI 正在起）：记录还没有回合可认，先留着当回执，不凭空消失。
{
  const s = session({ endedAt: null });
  const items = buildConversationItems([{
    session: s,
    output: [line({ t: "user", agent: "claude", text: "把按钮改一下", at: at(0) }), "改好了。", end(5)].join(""),
    trace: [run(0), text(1, 0, "改好了。")] as never,
  }], [s], [{ kind: "server", id: "e1", event: { taskId: "t1", sessionId: "s1", agentType: "claude", event: { kind: "system", text: MARKER, at: at(10), resume: { reason: "queue" } } } as never }]);
  assert.deepEqual(feed(items).receipts, [[MARKER]]);
}

// ② 老记录 ────────────────────────────────────────────────────────────────────
{
  const sentinel = feed(persistedResume(line({ t: "system", agent: "claude", text: MARKER, at: at(10) })));
  assert.deepEqual(sentinel.causes, [null, "系统续跑"]);
  assert.equal(sentinel.receipts.flat().some((receipt) => receipt.includes(MARKER)), false);
  // 更老的整行原文（没有 sentinel、没有时刻）：读得出来，不出错。它没有时刻，排序时本来就落在最后，
  // 认不到回合，照旧是一条记录。
  assert.equal(resumeEvents(persistedResume(`\n${MARKER}\n`)).length, 1);
  // 形状不对的缘由按老记录读，不报错。
  const broken = feed(persistedResume(line({ t: "system", agent: "claude", text: MARKER, resume: { reason: "nope" }, at: at(10) })));
  assert.deepEqual(broken.causes, [null, "系统续跑"]);
  assert.deepEqual(feed(liveResume(undefined)).causes, [null, "系统续跑"]);
}

// ③ 你发话起头的、哨兵叫醒的 ──────────────────────────────────────────────────────
{
  const s = session();
  const wake: MonitorWakeEvent = { kind: "output", monitorId: "mX", source: "全量回归", body: "OK" };
  const output = [
    line({ t: "user", agent: "claude", text: "把按钮改一下", at: at(0) }),
    "改好了。", end(5),
    line({ t: "user", agent: "claude", text: `【哨兵事件】全量回归（monitorId=mX）\nOK`, by: "system", monitorWake: appendMonitorWake(null, wake), at: at(10) }),
    "回归过了。", end(12),
    line({ t: "user", agent: "claude", text: "再看看颜色", at: at(20) }),
    "颜色也改了。", end(22),
  ].join("");
  const trace = [run(0), text(1, 0, "改好了。"), run(10), text(11, 10, "回归过了。"), run(20), text(21, 20, "颜色也改了。")];
  const items = buildConversationItems([{ session: s, output, trace: trace as never }], [s], []);
  assert.deepEqual(feed(items).causes, [null, "被哨兵叫醒", null]);
}

// ④ 旁路回合起的续跑、审查者那一侧 ────────────────────────────────────────────────
{
  const side = feed(persistedResume(line({ t: "system", agent: "claude", text: MARKER, resume: { reason: "run", side: true }, at: at(10) })));
  assert.deepEqual(side.causes, [null, null], "旁路回合起的续跑不该在回合头上写起因");
  assert.ok(side.receipts.flat().some((receipt) => receipt.includes(MARKER)), "旁路回合的续跑记录照旧是一条回执");
  // 自由派审另开的 reviewer 会话，checkpoint 续跑回来：仍是审查者那一侧。
  const reviewer = persistedResume(line({ t: "system", agent: "claude", text: MARKER, at: at(10) }), { role: "reviewer" } as Partial<Session>);
  assert.equal(agents(reviewer).some((turn) => turn.resumeCause), false, "审查者的回合头上不加起因");
}

// ⑤ 审查段的起止认法不变（真实历史会话夹具，带缘由前后对比）────────────────────────
{
  const lanes = (output: string) => {
    const s = session({ id: "legacy", startedAt: "2026-08-05T14:21:48.822Z", endedAt: "2026-08-06T04:05:45.485Z" });
    const items = buildConversationItems([{ session: s, output, trace: [] }], [s], []);
    return {
      reviewers: agents(items).map((turn) => turn.reviewer?.round ?? null),
      lanes: conversationFeedRows(items).map((row) => row.kind === "review-lane"
        ? { round: row.round, conclusion: row.conclusion, complete: row.complete, items: row.items.map((item) => item.id) }
        : row.kind),
    };
  };
  for (const name of ["legacy-verify-session.md", "legacy-answer-verify-session.md"]) {
    const original = readSource(new URL(`./fixtures/${name}`, import.meta.url));
    assert.ok(original.includes(MARKER), `${name} 里应有续跑记录`);
    const before = lanes(original);
    assert.ok(before.lanes.some((row) => typeof row === "object"), `${name} 里应认出审查段`);
    for (const resume of [{ reason: "run" }, { reason: "queue" }, { reason: "run", side: true }]) {
      const tagged = original.replace(/"text":"〔系统〕继续（从中断处）"/g, `"text":"${MARKER}","resume":${JSON.stringify(resume)}`);
      assert.notEqual(tagged, original);
      assert.deepEqual(lanes(tagged), before, `${name}：续跑记录带上缘由（${JSON.stringify(resume)}）后审查段变了`);
    }
  }
}

// ⑥ 团队页 ────────────────────────────────────────────────────────────────────
{
  const rows = teamFeedRows(persistedResume(line({ t: "system", agent: "claude", text: MARKER, resume: { reason: "queue" }, at: at(10) })), []);
  const conv = rows.flatMap((row) => row.kind === "conv" ? [row.item] : []);
  assert.deepEqual(agents(conv).map((turn) => turnCauseText(turn)), [null, "队列续跑"]);
  assert.equal(resumeEvents(conv).length, 0, "团队页的续跑记录还单独画了一行");
  const legacy = teamFeedRows(persistedResume(line({ t: "system", agent: "claude", text: MARKER, at: at(10) })), []);
  assert.deepEqual(agents(legacy.flatMap((row) => row.kind === "conv" ? [row.item] : [])).map((turn) => turnCauseText(turn)), [null, "系统续跑"]);
}

// ⑦ 几条会话交错续跑 ──────────────────────────────────────────────────────────────
{
  const s1 = session({ id: "s1", endedAt: null });
  const s2 = session({ id: "s2", agentType: "codex", executor: "codex@cpa", startedAt: at(1), endedAt: null } as Partial<Session>);
  const first = (id: string, minute: number) => [
    line({ t: "user", agent: "claude", text: `${id} 开工`, at: at(minute) }), `${id} 第一回合。`, end(minute + 2),
  ].join("");
  const firstTrace = (minute: number) => [run(minute), text(minute + 1, minute, "第一回合。")];
  const resumeLine = (minute: number, resume: SystemResume) => line({ t: "system", agent: "claude", text: MARKER, resume, at: at(minute) });
  // 在 s1 续跑之后、它开口之前，s2 那边可能发生的三件事。
  const between: Array<{ name: string; s2Line: string; s2Live: Record<string, unknown>; s2Cause: string | null }> = [
    { name: "s2 也续跑", s2Line: resumeLine(11, { reason: "retry" }), s2Live: { kind: "system", text: MARKER, at: at(11), resume: { reason: "retry" } }, s2Cause: "你点了重试" },
    { name: "s2 起了一次旁路续跑", s2Line: resumeLine(11, { reason: "run", side: true }), s2Live: { kind: "system", text: MARKER, at: at(11), resume: { reason: "run", side: true } }, s2Cause: null },
  ];
  for (const { name, s2Line, s2Live, s2Cause } of between) {
    const disk = buildConversationItems([
      { session: s1, output: [first("s1", 0), resumeLine(10, { reason: "queue" }), "s1 接着跑完了。", end(13)].join(""), trace: [...firstTrace(0), run(10), text(12, 10, "s1 接着跑完了。")] as never },
      { session: s2, output: [first("s2", 1), s2Line, "s2 接着跑完了。", end(15)].join(""), trace: [...firstTrace(1), run(11), text(14, 11, "s2 接着跑完了。")] as never },
    ], [s1, s2], []);
    const ev = (id: string, sessionId: string, event: Record<string, unknown>, turnStartedAt?: string): TimelineEntry => ({
      kind: "server", id,
      event: { taskId: "t1", sessionId, role: "single", agentType: sessionId === "s1" ? "claude" : "codex", ...(turnStartedAt ? { turnStartedAt } : {}), event } as never,
    });
    // 直播：两条续跑先后到达，回复要等第一条正文才成气泡。
    const live = buildConversationItems([
      { session: s1, output: first("s1", 0), trace: firstTrace(0) as never },
      { session: s2, output: first("s2", 1), trace: firstTrace(1) as never },
    ], [s1, s2], [
      ev("e1", "s1", { kind: "system", text: MARKER, at: at(10), resume: { reason: "queue" } }),
      ev("e2", "s2", s2Live),
      ev("e3", "s1", { kind: "text", text: "s1 接着跑完了。" }, at(10)),
      ev("e4", "s2", { kind: "text", text: "s2 接着跑完了。" }, at(11)),
    ]);
    for (const [path, items] of [["落盘重建", disk], ["直播到达", live]] as const) {
      const causeOf = (sessionId: string) => agents(items).filter((turn) => turn.sessionId === sessionId).map((turn) => turnCauseText(turn));
      assert.deepEqual(causeOf("s1"), [null, "队列续跑"], `${name}·${path}：s1 的起因被别的会话抹掉了`);
      assert.deepEqual(causeOf("s2"), [null, s2Cause], `${name}·${path}：s2 的起因不对`);
      const shown = feed(items);
      assert.equal(shown.receipts.flat().filter((receipt) => receipt.includes(MARKER)).length, s2Cause ? 0 : 1, `${name}·${path}：任务页的续跑记录数不对`);
      assert.equal(shown.inline.some((note) => note.includes(MARKER)), false, `${name}·${path}：续跑记录在原处单独画了一行`);
      const team = teamFeedRows(items, []).flatMap((row) => row.kind === "conv" ? [row.item] : []);
      assert.deepEqual(agents(team).map((turn) => turnCauseText(turn)).filter(Boolean), s2Cause ? ["队列续跑", s2Cause] : ["队列续跑"], `${name}·${path}：团队页起因不对`);
      assert.equal(resumeEvents(team).length, s2Cause ? 0 : 1, `${name}·${path}：团队页的续跑记录数不对`);
    }
  }
  // s1 续跑之后、开口之前，s2 收到一条输入：那是 s2 的事，s1 的待认领记录照旧在。
  const live = buildConversationItems([
    { session: s1, output: first("s1", 0), trace: firstTrace(0) as never },
    { session: s2, output: first("s2", 1), trace: firstTrace(1) as never },
  ], [s1, s2], [
    { kind: "server", id: "e1", event: { taskId: "t1", sessionId: "s1", role: "single", agentType: "claude", event: { kind: "system", text: MARKER, at: at(10), resume: { reason: "queue" } } } as never },
    { kind: "user", id: "u1", text: "s2 你看看这个", attachments: [], at: at(11), sessionId: "s2", sessionRole: "single", bySystem: true },
    { kind: "server", id: "e3", event: { taskId: "t1", sessionId: "s1", role: "single", agentType: "claude", turnStartedAt: at(10), event: { kind: "text", text: "s1 接着跑完了。" } } as never },
  ]);
  assert.deepEqual(agents(live).filter((turn) => turn.sessionId === "s1").map((turn) => turnCauseText(turn)), [null, "队列续跑"], "别的会话收到的输入抹掉了这条会话的起因");
  // 还没落到任何会话上的输入（你刚打的字）对每条会话都算插话：之后开口的不是续跑起的头。
  const typed = buildConversationItems([{ session: s1, output: first("s1", 0), trace: firstTrace(0) as never }], [s1], [
    { kind: "server", id: "e1", event: { taskId: "t1", sessionId: "s1", role: "single", agentType: "claude", event: { kind: "system", text: MARKER, at: at(10), resume: { reason: "queue" } } } as never },
    { kind: "user", id: "u1", text: "等等，先改颜色", attachments: [], at: at(11) },
    { kind: "server", id: "e3", event: { taskId: "t1", sessionId: "s1", role: "single", agentType: "claude", turnStartedAt: at(11), event: { kind: "text", text: "好的。" } } as never },
  ]);
  assert.equal(agents(typed).some((turn) => turn.resumeCause), false, "你插了话之后开口的回合不是续跑起的头");
}

console.log("turn-cause ok");
