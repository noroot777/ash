// 哨兵叫醒并回等它的那一回合（monitorWakeTurns）：归属按段、按哨兵身份认，开着页面看和刷新以后看一样。
//
//   ① 按审查意见修复的那一回合挂了哨兵、暂停、被叫醒：还是一个回合（旧判据靠全局开关，审查意见进来时
//      上一个哨兵还「在等」，于是认成「等的时候有人插话」，另起了「被哨兵叫醒」的回合）。回合外面只留
//      醒来后那段话，暂停前写的那段收进执行过程。中间那条引了哨兵描述（「第 1 轮审查修复后重跑…」）的
//      记录不是审查轮的起止。
//   ② 等的时候你插了话：另起；同一条哨兵后面的叫醒并进另起的那一回合（按 id 认）。
//   ③ 三档身份：id、描述（空白归一，claude 内置 Monitor 也认）、没有结构化来源的老叫醒。
//   ④ 异常结束之后来的叫醒不并；正常结束的回合边界不挡、并进去以后拿掉。
//   ⑤ 落盘重建和直播到达两条路，并出来的回合一样——叫醒到了、回复还没来时也一样。
//   ⑥ 审查会话的叫醒、审查者正在说话时的叫醒不并。
//   ⑦ 并出来的回合带着原来几条的出处；id 是最后那一截，派生按它截上下文带得上醒来后的话。
import assert from "node:assert/strict";
import type { Session } from "@ash/shared";
import { appendMonitorWake, type MonitorWakeEvent } from "@ash/shared/monitor-wake";
import { buildConversationItems, type ConversationItem, type TimelineEntry } from "../src/task-detail/conversationModel.ts";
import { foldMonitorWakes } from "../src/task-detail/monitorWakeTurns.ts";
import { verifyNoteOf } from "../src/task-detail/conversationNotes.ts";
import { turnLayout } from "../src/task-detail/turnFold.ts";

type Agent = Extract<ConversationItem, { kind: "agent" }>;
const T0 = Date.parse("2026-11-13T02:00:00.000Z");
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString();
const session = (extra: Partial<Session> = {}) => ({
  id: "s1", taskId: "t1", agentType: "claude", executor: "claude@cpa", role: "single",
  startedAt: at(0), endedAt: at(60), ...extra,
}) as unknown as Session;
const event = (source: string, monitorId: string, kind: MonitorWakeEvent["kind"] = "output"): MonitorWakeEvent => ({
  kind, monitorId, source, body: kind === "ended" ? "退出码 0。命令自己跑完了" : "OK",
});
const wakeOf = (events: MonitorWakeEvent[]) => ({
  text: events.map((e) => `【哨兵${e.kind === "output" ? "事件" : "结束"}】${e.source}（monitorId=${e.monitorId}）\n${e.body}`).join("\n\n"),
  monitorWake: events.reduce<ReturnType<typeof appendMonitorWake> | null>((data, e) => appendMonitorWake(data, e), null)!,
});
const line = (turn: Record<string, unknown>) => `\n\x1e${JSON.stringify(turn)}\n`;
const wakeLine = (minute: number, events: MonitorWakeEvent[]) => line({ t: "user", ...wakeOf(events), by: "system", at: at(minute) });
const end = (minute: number) => line({ t: "agentEnd", at: at(minute) });
const tool = (minute: number, turn: number, name: string, input: Record<string, unknown>) => ({
  at: at(minute), turnStartedAt: at(turn), event: { kind: "tool", name, detail: JSON.stringify(input) },
});
const monitor = (minute: number, turn: number, description: string) => tool(minute, turn, "mcp__ash__start_monitor", { description, command: "npm test" });
const edit = (minute: number, turn: number) => tool(minute, turn, "Edit", { file_path: "/repo/a.ts" });
const persisted = (output: string, trace: object[], extra: Partial<Session> = {}) => {
  const s = session(extra);
  return buildConversationItems([{ session: s, output, trace: trace as never }], [s], []);
};
const agents = (items: ConversationItem[]) => items.filter((item): item is Agent => item.kind === "agent");
const wakes = (items: ConversationItem[]) => items.filter((item) => item.kind === "user" && item.bySystem && item.text.includes("【哨兵"));

// ① 修复回合 ────────────────────────────────────────────────────────────────────
{
  const A = event("全量回归", "mA");
  const B = event("第 1 轮审查修复后重跑：web/scripts/test-accept-gate-dom.mjs", "mB");
  const items = persisted([
    line({ t: "user", text: "改一下按钮", at: at(0) }),
    "改好了，挂哨兵 A 跑回归。", end(5),
    wakeLine(10, [A]), "A 有输出了，接着等。", end(11),
    line({ t: "user", text: "【自由工作流审查未通过 · 第 1 轮】\n请按报告修复。", by: "system", at: at(20) }),
    "照意见修好了，挂哨兵 B 重跑，暂停等结果。", end(25),
    line({ t: "system", text: "本回合要落的终态被拦下，改为检查点暂停：完成确认被拦下：你名下还有 1 个哨兵还在盯着（第 1 轮审查修复后重跑：web/scripts/test-accept-gate-dom.mjs）。", at: at(25), aside: true, level: "notice" }),
    wakeLine(40, [B]), "B 过了，修复完成。", end(42),
  ].join(""), [
    edit(2, 0), monitor(4, 0, A.source),
    edit(22, 20), monitor(24, 20, B.source),
    edit(41, 40),
  ]);
  const note = items.find((item) => item.kind === "event" && item.text.startsWith("本回合要落的终态被拦下"));
  assert.equal(note && note.kind === "event" && note.verify, false, "引了哨兵描述的记录被认成了审查轮的起止");
  assert.equal(verifyNoteOf("自由工作流第 1 轮审查未通过，意见已发回会话；修复回合正常结束后自动复审。")?.phase, "end");
  const folded = foldMonitorWakes(items);
  const turns = agents(folded);
  assert.equal(turns.length, 2, "按审查意见修复的那一回合被哨兵切成了两段");
  assert.equal(turns.some((turn) => turn.wokenByMonitor), false);
  assert.equal(wakes(folded).length, 0);
  const fix = turns[1]!;
  assert.match(fix.markdown, /照意见修好了[\s\S]*B 过了，修复完成。/);
  // 外面只留醒来后那段话，暂停前写的那段收进执行过程。
  const { process, conclusion } = turnLayout(fix.segments, { live: false });
  assert.deepEqual(conclusion.map((segment) => segment.markdown.trim()).filter(Boolean), ["B 过了，修复完成。"]);
  assert.match(process.map((segment) => segment.markdown).join(""), /照意见修好了/);
  assert.ok(process.some((segment) => segment.events.some((e) => e.label.endsWith("monitor_wake"))), "叫醒那一下不在执行过程里");
  // ⑦ 出处与 id：删除照旧定位得到每一截，派生截到最后那一截。
  const sources = (fix.sources ?? []).map((source) => "index" in source ? source.index : -1);
  const wakeIndex = items.findIndex((item) => item.kind === "user" && item.text.includes("mB"));
  const replyItem = items.slice(wakeIndex).find((item) => item.kind === "agent")!;
  assert.equal(fix.id, replyItem.id, "并出来的回合 id 不是最后那一截，派生截不到醒来后的话");
  for (const piece of [items.find((item) => item.kind === "agent" && item.markdown.startsWith("照意见"))!, items[wakeIndex]!, replyItem]) {
    for (const source of piece.sources ?? []) assert.ok("index" in source && sources.includes(source.index), "并出来的回合丢了某一截的出处，删除定位不到");
  }
}

// ② 等的时候你插了话 ──────────────────────────────────────────────────────────────
{
  const A = event("等部署", "mA");
  const items = persisted([
    "挂哨兵等部署。", end(2),
    line({ t: "user", text: "顺便看下日志", at: at(5) }),
    "日志没问题。", end(6),
    wakeLine(10, [A]), "部署有进展。", end(11),
    // 同一条哨兵后面的叫醒：来源改了名也按 id 认得出。
    wakeLine(20, [{ ...A, source: "等部署（续）", kind: "ended" }]), "部署完成。", end(21),
  ].join(""), [monitor(1, 0, A.source)]);
  const turns = agents(foldMonitorWakes(items));
  assert.deepEqual(turns.map((turn) => !!turn.wokenByMonitor), [false, false, true], "插话之后的叫醒该另起一回合");
  assert.match(turns[2]!.markdown, /部署有进展。[\s\S]*部署完成。/, "同一条哨兵后面的叫醒没并进另起的那一回合");
}

// ③ 三档身份 ─────────────────────────────────────────────────────────────────────
{
  const legacyText = "【哨兵事件】全量回归（monitorId=old）\nOK";
  const legacy = (trace: object[]) => agents(foldMonitorWakes(persisted([
    "挂上了。", end(2), line({ t: "user", text: legacyText, by: "system", at: at(10) }), "收到。", end(11),
  ].join(""), trace)));
  assert.equal(legacy([monitor(1, 0, "随便什么")]).length, 1, "没有结构化来源的老叫醒：这一段挂过哨兵就该并");
  assert.equal(legacy([]).at(-1)!.wokenByMonitor, true, "这一段一条哨兵都没挂过，老叫醒不该并");
  const byText = (trace: object[], source: string) => agents(foldMonitorWakes(persisted([
    "挂上了。", end(2), wakeLine(10, [event(source, "m1")]), "收到。", end(11),
  ].join(""), trace))).length;
  assert.equal(byText([monitor(1, 0, "全量  回归\n")], "全量 回归"), 1, "描述的空白没归一");
  assert.equal(byText([tool(1, 0, "Monitor", { description: "等回归", command: "until …" })], "等回归"), 1, "claude 内置 Monitor 改道过来的没认出来");
  assert.equal(byText([tool(1, 0, "mcp__ash__start_monitor", { command: "npm  test" })], "npm test"), 1, "没写描述时服务端拿命令顶上，没认出来");
  assert.equal(byText([monitor(1, 0, "别的哨兵")], "全量回归"), 2, "不是这一段挂的哨兵被并了进来");
}

// ④⑤ 直播与落盘 ──────────────────────────────────────────────────────────────────
// 同一段会话：回合挂哨兵、正常结束 → 叫醒 → 回复。落盘那一路从 .md + trace 重建，直播那一路一条条到达。
const S = session({ endedAt: null, turnStartedAt: at(10) } as Partial<Session>);
const W = event("跑回归", "m1", "ended");
const liveEvent = (id: string, payload: Record<string, unknown>): TimelineEntry => ({
  kind: "server", id, event: { type: "agent.event", taskId: "t1", sessionId: S.id, agentType: "claude", event: payload } as never,
});
const liveWake: TimelineEntry = { kind: "user", id: "w1", at: at(10), attachments: [], bySystem: true, sessionId: S.id, ...wakeOf([W]) };
const live = (tail: TimelineEntry[], exitStatus = 0) => foldMonitorWakes(buildConversationItems([], [S], [
  liveEvent("e1", { kind: "text", text: "改好了，挂个哨兵跑回归。" }),
  liveEvent("e2", { kind: "tool", name: "mcp__ash__start_monitor", detail: JSON.stringify({ description: W.source }) }),
  liveEvent("e3", { kind: "done", exitStatus }),
  liveWake,
  ...tail,
]));
const reload = (output: string) => foldMonitorWakes(buildConversationItems([{
  session: S, output, trace: [monitor(1, 0, W.source)] as never,
}], [S], []));
const shape = (items: ConversationItem[]) => ({
  turns: agents(items).map((turn) => ({
    woken: !!turn.wokenByMonitor,
    markdown: turn.markdown.replace(/\s+/g, " ").trim(),
    steps: turn.segments.flatMap((segment) => segment.events.map((e) => e.label)),
    running: !turn.endedAt,
  })),
  cards: wakes(items).length,
  boundaries: items.filter((item) => item.kind === "event" && item.variant === "boundary").length,
});
{
  // 叫醒到了、回复还没来：已经是那一回合执行过程里的一步，回合回到「在跑」，没有单独的卡。
  const pendingLive = shape(live([]));
  const pendingReload = shape(reload(["改好了，挂个哨兵跑回归。", end(2), wakeLine(10, [W])].join("")));
  assert.deepEqual(pendingLive, pendingReload, "叫醒到了、回复没来时，直播和刷新以后画得不一样");
  assert.deepEqual(pendingLive.turns.map((turn) => [turn.woken, turn.running]), [[false, true]]);
  assert.equal(pendingLive.cards, 0);
  // 回复来了：接在同一回合后面。
  const repliedLive = live([liveEvent("e4", { kind: "text", text: "回归过了，改动完成。" })]);
  const repliedReload = reload(["改好了，挂个哨兵跑回归。", end(2), wakeLine(10, [W]), "回归过了，改动完成。"].join(""));
  assert.deepEqual(shape(repliedLive), shape(repliedReload), "回复来了以后，直播和刷新以后画得不一样");
  assert.equal(agents(repliedLive).length, 1);
  assert.equal(shape(repliedLive).boundaries, 0, "并进去以后，前一截那条正常结束的回合边界还留着");
  // 异常结束之后来的叫醒不并进它。
  const crashed = agents(live([liveEvent("e4", { kind: "text", text: "回归过了。" })], 1));
  assert.deepEqual(crashed.map((turn) => !!turn.wokenByMonitor), [false, true], "异常结束之后的叫醒被并进了那一回合");
}

// ⑥ 审查 ────────────────────────────────────────────────────────────────────────
{
  const reviewer = session({ id: "r1", role: "reviewer", startedAt: at(30) } as Partial<Session>);
  const main = session();
  const items = buildConversationItems([
    { session: main, output: ["挂上了。", end(2)].join(""), trace: [monitor(1, 0, "回归")] as never },
    { session: reviewer, output: ["审查者挂回归。", end(32), wakeLine(40, [event("回归", "mR")]), "回归绿了。"].join(""), trace: [] },
  ], [main, reviewer], []);
  const folded = foldMonitorWakes(items);
  assert.equal(wakes(folded).length, 1, "审查会话的叫醒被并走了，审查卡里看不见它");
  // 就地验证：审查者正在这条会话上说话，回复还没来的叫醒留给审查卡。
  const inline = buildConversationItems([{ session: main, output: [
    "挂上了。", end(2),
    line({ t: "system", text: "第 2 轮验证开始：就在这个任务的工作目录里跑。", at: at(5) }),
    "验证回合在说。", end(8),
    wakeLine(10, [event("回归", "mI")]),
  ].join(""), trace: [
    monitor(1, 0, "回归"),
    { at: at(5), turnStartedAt: at(5), event: { kind: "run", model: "m", reasoningEffort: null, verifyRound: 2 } },
  ] as never }], [main], []);
  assert.equal(wakes(foldMonitorWakes(inline)).length, 1, "审查者在说话时的叫醒被并进了执行回合");
}

console.log("✓ monitor wake fold: 修复回合不被切开、插话后另起并按 id 续并、三档身份、异常结束不并、直播与刷新一致（含回复未到）、审查叫醒不并、出处与派生落点");
