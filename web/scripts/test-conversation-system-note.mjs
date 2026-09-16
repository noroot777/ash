// 任务时间线旁注（预约审查、验收阶段更新…）落在回合中间时，会话该怎么排。
//
// 病症一（用户 2026-08-29 报的 1qsWWVsvfIvT）：agent 刚吐出一个「我」字，「已预约完成后
// 审查」这条旁注就落了盘。.md 在 sentinel 处把正文切成两段 agent，trace 却没跟着切 ——
// 于是那颗只有一个字的气泡领走了整组 trace（236 次工具、7 张附件），真正写了 2700 字
// 报告的那一段一个事件都没有。
//
// 病症二（用户 2026-09-14 报的）：被劈出来的上半截**本来就不是一条回复**，却照样拿到了
// 结束时刻 —— 于是提前折叠、还挂出「派生新任务」（派生要拿整条回复当上下文，半截不算）。
// 根因是拿旁注当了回合边界：它不是说给 agent 听的话，落在哪一秒纯属偶然。
//
// 现在的排法：旁注**不切回合、不定回合起止**，上下两截并回同一颗气泡，旁注自己排在这
// 一回合后面。真正的回合起点（「继续（从中断处）」）和落在两回合之间的旁注不受影响。
import assert from "node:assert/strict";
import { buildConversationItems } from "../src/task-detail/conversationModel.ts";

const SESSION_STARTED = "2026-08-29T05:30:56.111Z";
const NOTE_AT = "2026-08-29T05:31:03.481Z";
const TEXT_AT = "2026-08-29T05:31:04.413Z";

const session = {
  id: "s1",
  taskId: "t1",
  agentType: "claude",
  role: "single",
  executor: "claude@ccb",
  startedAt: SESSION_STARTED,
  endedAt: "2026-08-29T06:15:15.000Z",
};

const sentinel = (payload) => `\n\x1e${JSON.stringify(payload)}\n`;
const traced = (at, event, turnStartedAt = SESSION_STARTED) => ({ at, turnStartedAt, event });
const agents = (items) => items.filter((item) => item.kind === "agent");
const events = (items) => items.filter((item) => item.kind === "event");

// .md：「我」→ 旁注 → 剩下的正文。trace：一条跨了旁注的合并正文事件 + 两次工具。
const output = [
  "我",
  sentinel({ t: "system", agent: "claude", text: "已预约完成后审查：5.5审查。", at: NOTE_AT }),
  "先看这两张图。\n\n改完了：三处都换成了新判据。\n",
].join("");
const trace = [
  traced(TEXT_AT, { kind: "text", text: "我先看这两张图。\n\n" }),
  traced("2026-08-29T05:31:05.000Z", { kind: "tool", name: "Read", detail: "a.png" }),
  traced("2026-08-29T05:31:06.000Z", { kind: "attachment", path: "shot.png" }),
  traced("2026-08-29T05:40:00.000Z", { kind: "tool", name: "Edit", detail: "x.ts" }),
  traced("2026-08-29T05:41:00.000Z", { kind: "text", text: "改完了：三处都换成了新判据。\n" }),
];

const items = buildConversationItems([{ session, output, trace }], [session], []);
const bubbles = agents(items);
assert.equal(bubbles.length, 1, "旁注不该把一条回复劈成两颗气泡");

const [turn] = bubbles;
// 1. 事件、附件都在这一回合里，一件不落（原来它们全被那颗「我」气泡领走了）。
assert.deepEqual(turn.segments.flatMap((s) => s.events).map((e) => e.label), ["Read", "Edit"]);
assert.deepEqual(turn.segments.flatMap((s) => s.attachments), ["shot.png"]);

// 2. 正文：旁注前后两截接回一整段，且一个字不重（trace 那条正文多出来的「我」已由上半截
//    显示过）。分段拼回去必须跟气泡正文**一个字不丢不重**——复制/派生读 markdown，渲染读
//    segments，两者不能漂（接缝处的空白不算：每一段各自渲染成独立的块）。
assert.equal(turn.markdown, "我\n\n先看这两张图。\n\n改完了：三处都换成了新判据。");
const compact = (text) => text.replace(/\s+/g, "");
assert.equal(
  compact(turn.segments.map((s) => s.markdown).join("")),
  compact(turn.markdown),
  "分段拼回去必须等于气泡正文",
);
assert.equal(turn.segments.filter((s) => s.markdown.includes("我")).length, 1, "「我」被重复渲染了一遍");

// 3. 对齐成功才有交错结构可切；否则整条回合退回单段，折叠无从下手。
assert.ok(turn.segments.length > 1, "该切成多段,而不是退回单段兜底");

// 4. 旁注自己排在这一回合**后面**，并且带着 aside 标（展示端据此贴成回合的尾注）。
const [note] = events(items);
assert.equal(note.aside, true, "落在回合中间的旁注应标成 aside");
assert.ok(items.indexOf(note) > items.indexOf(turn), "旁注应排在被它砸中的那一回合后面");

// 5. 旁注后面没有正文时同样不多出气泡：那一组 trace 无人认领会掉进「无正文兜底气泡」。
const trailing = agents(buildConversationItems([{
  session,
  output: ["第一回合说的话。", sentinel({ t: "system", agent: "claude", text: "已预约完成后审查。", at: NOTE_AT })].join("\n"),
  trace: [
    traced("2026-08-29T05:31:00.000Z", { kind: "text", text: "第一回合说的话。" }),
    traced("2026-08-29T05:31:20.000Z", { kind: "tool", name: "exec", detail: "检查布局" }),
  ],
}], [session], []));
assert.equal(trailing.length, 1, "旁注后面没正文时不该多出一颗气泡");
assert.deepEqual(trailing[0].segments.flatMap((s) => s.events).map((e) => e.label), ["exec"]);

// 6. 还在飞的回合不许被旁注按上结束时刻：一按上就当场折叠、还挂出「派生新任务」，
//    而那半截根本不是一条完整回复。
const liveSession = { ...session, endedAt: null, turnStartedAt: SESSION_STARTED };
const live = buildConversationItems([], [liveSession], [
  { kind: "server", id: "e1", event: { taskId: "t1", sessionId: "s1", agentType: "claude", event: { kind: "text", text: "我" } } },
  { kind: "server", id: "e2", event: { taskId: "t1", sessionId: "s1", agentType: "claude", event: { kind: "system", text: "已预约审查：5.5审查。", at: NOTE_AT, aside: true } } },
  { kind: "server", id: "e3", event: { taskId: "t1", sessionId: "s1", agentType: "claude", event: { kind: "text", text: "先看这两张图。" } } },
]);
const [liveTurn] = agents(live);
assert.equal(agents(live).length, 1, "直播里旁注本来就不拆气泡");
assert.equal(liveTurn.endedAt, null, "回合还在飞，旁注不能替它宣布结束");
assert.equal(liveTurn.markdown, "我先看这两张图。");

// 7. 真正的回合起点（系统对 agent 说的「继续（从中断处）」）照旧切：它的时刻**恰好等于**
//    下一组 trace 的 turnStartedAt，跟砸进回合中间的旁注不是一回事。
const RESUMED_AT = "2026-08-29T05:50:00.000Z";
const resumed = agents(buildConversationItems([{
  session,
  output: [
    "第一回合说的话。",
    sentinel({ t: "system", agent: "claude", text: "〔系统〕继续（从中断处）", at: RESUMED_AT }),
    "第二回合说的话。",
  ].join("\n"),
  trace: [
    traced("2026-08-29T05:31:00.000Z", { kind: "text", text: "第一回合说的话。" }),
    traced("2026-08-29T05:31:20.000Z", { kind: "tool", name: "exec", detail: "看一眼" }),
    traced(RESUMED_AT, { kind: "run", model: "claude-opus-5", reasoningEffort: "high" }, RESUMED_AT),
    traced("2026-08-29T05:50:10.000Z", { kind: "text", text: "第二回合说的话。" }, RESUMED_AT),
  ],
}], [session], []));
assert.equal(resumed.length, 2, "回合起点仍然是切点");
assert.equal(resumed[0].markdown, "第一回合说的话。");
assert.equal(resumed[1].markdown, "第二回合说的话。");

// 8. 落在两个回合**之间**的旁注（「第 N 轮验证开始」就是这种：写完才起验证回合）不合并：
//    合了就是把实现者和审查者的发言粘成同一条。
const VERIFY_NOTE_AT = "2026-08-29T05:55:00.000Z";
const VERIFY_TURN_AT = "2026-08-29T05:55:30.000Z";
const verify = agents(buildConversationItems([{
  session,
  output: [
    "实现完了。",
    sentinel({ t: "system", agent: "claude", text: "第 2 轮验证开始：就在这个任务的工作目录里跑。", at: VERIFY_NOTE_AT, aside: true }),
    "第 2 轮结论：verified。",
  ].join("\n"),
  trace: [
    traced("2026-08-29T05:54:00.000Z", { kind: "text", text: "实现完了。" }),
    traced(VERIFY_TURN_AT, { kind: "run", model: "claude-opus-5", reasoningEffort: "high", verifyRound: 2 }, VERIFY_TURN_AT),
    traced("2026-08-29T05:56:00.000Z", { kind: "text", text: "第 2 轮结论：verified。" }, VERIFY_TURN_AT),
  ],
}], [session], []));
assert.equal(verify.length, 2, "验证轮是另一个人在说话，不能并进实现回合");
assert.equal(verify[1].reviewer?.round, 2);

// 9. trace 整条缺失时（没落盘 / 写盘失败，服务端把 trace 写失败当非致命处理）认服务端的
//    aside 标：此时两截连 run 身份都读不出来，劈开只剩坏处 —— 上半截凭空得到结束时刻，
//    于是提前折叠、还挂出「派生新任务」。
const NO_TRACE_NOTE_AT = "2026-09-14T00:01:00.000Z";
const noTrace = buildConversationItems([{
  session: { ...session, endedAt: null, turnStartedAt: SESSION_STARTED },
  output: [
    "上半截",
    sentinel({ t: "system", agent: "claude", text: "已预约审查：5.5审查。", at: NO_TRACE_NOTE_AT, aside: true }),
    "下半截",
  ].join("\n"),
  trace: [],
}], [{ ...session, endedAt: null, turnStartedAt: SESSION_STARTED }], []);
assert.equal(agents(noTrace).length, 1, "trace 缺失时 aside 标也该把两截并回一颗气泡");
assert.equal(agents(noTrace)[0].markdown, "上半截\n\n下半截");
assert.equal(agents(noTrace)[0].endedAt, null, "回合还在飞，旁注不能替它宣布结束");
assert.equal(events(noTrace)[0].aside, true);

// 10. 同样缺 trace、但**没有** aside 标的老会话（2026-09-14 之前）无证据可依，维持老排法：
//     无端合并会把落在两回合之间的旁注也吃掉，把两轮发言粘成一条。
const legacy = agents(buildConversationItems([{
  session,
  output: [
    "上半截",
    sentinel({ t: "system", agent: "claude", text: "已预约审查：5.5审查。", at: NO_TRACE_NOTE_AT }),
    "下半截",
  ].join("\n"),
  trace: [],
}], [session], []));
assert.equal(legacy.length, 2, "老会话没有 aside 标也没有 trace，不猜，维持原样");

// 11. trace 哑了的时候，aside 标只说「这不是回合起点」，**不说「回合还在飞」**。落在两
//     回合之间的那类旁注必须另有证据挡住，否则审查者的结论会被并进被审的实现回合。
//     两样证据都跟 trace 各走各路：
//     a) 旁注自己就是「第 N 轮验证开始」—— 它开的是另一个人的一轮；
//     b) 上一段正文已经落了 agentEnd —— 这一回合真收口了（服务端 writeTurnEnd 写的）。
const agentEnd = (at) => `\n\x1e${JSON.stringify({ t: "agentEnd", at })}\n`;
const noTraceBoundary = (noteText, closeTurn) => agents(buildConversationItems([{
  session,
  output: [
    "实现完了。",
    closeTurn ? agentEnd("2026-09-14T00:05:00.000Z") : "",
    sentinel({ t: "system", agent: "claude", text: noteText, at: "2026-09-14T00:10:00.000Z", aside: true }),
    "第 2 轮结论：verified。",
  ].join("\n"),
  trace: [],
}], [session], []));
assert.equal(noTraceBoundary("第 2 轮验证开始：就在这个任务的工作目录里跑。", false).length, 2,
  "「第 N 轮验证开始」开的是另一个人的一轮，trace 缺失也不能并");
assert.equal(noTraceBoundary("预览已停止。", true).length, 2,
  "上一段已落 agentEnd = 回合收口了，后面的话是新一轮，trace 缺失也不能并");
// 反面对照：同样缺 trace，回合没收口、旁注也不开新一轮 —— 这才是该并的那种（第 9 条）。
assert.equal(noTraceBoundary("预览已停止。", false).length, 1, "回合还在飞的旁注照旧并回一颗气泡");

// 12. 旁注落在**本回合任何正文之前**（回合先连着跑了半小时工具、一个字没吐，于是旁注
//     占了 .md 的第一行）。用户 2026-09-16 报的：这种回合在 agent 终于吐字的那一刻会
//     「当场变形」—— 吐字前是一颗完整气泡、旁注贴在后面；吐字后旁注就插到了中间，上半截
//     还平白拿到结束时刻。两个时刻必须长得一样：整组 trace 归这一回合，旁注排在它后面。
const LEAD_NOTE_AT = "2026-09-16T01:57:12.776Z";
const leadSession = { ...session, endedAt: null, turnStartedAt: SESSION_STARTED };
const leadNote = sentinel({
  t: "system", agent: "claude", text: "已预约审查：5.5审查 · 逻辑检查 · 自动复审 7 轮。", at: LEAD_NOTE_AT, aside: true,
});
const leadTrace = [
  traced("2026-09-16T01:31:00.000Z", { kind: "tool", name: "Read", detail: "a.png" }),
  traced("2026-09-16T01:40:00.000Z", { kind: "tool", name: "Edit", detail: "b.ts" }),
  traced("2026-09-16T01:58:00.000Z", { kind: "tool", name: "Bash", detail: "node repro.mjs" }),
  traced("2026-09-16T01:59:00.000Z", { kind: "text", text: "复现了，现在改：" }),
];
const lead = (output) => buildConversationItems([{ session: leadSession, output, trace: leadTrace }], [leadSession], []);
for (const [label, output] of [
  ["旁注后面还没有正文", leadNote],
  ["旁注后面吐出了正文", [leadNote, "复现了，现在改："].join("")],
]) {
  const items = lead(output);
  const bubbles = agents(items);
  assert.equal(bubbles.length, 1, `${label}：旁注前面没有正文时不该劈成两颗气泡`);
  assert.deepEqual(bubbles[0].segments.flatMap((s) => s.events).map((e) => e.label), ["Read", "Edit", "Bash"],
    `${label}：整组 trace 该归这一回合，不该有半组落进兜底气泡`);
  assert.equal(bubbles[0].endedAt, null, `${label}：回合还在飞，旁注不能替它宣布结束`);
  assert.ok(items.indexOf(events(items)[0]) > items.indexOf(bubbles[0]), `${label}：旁注应排在这一回合后面`);
}

// 13. 真人在回合中途插一句（消息直接投进正在跑的会话，服务端**不开新回合**，会话行上的
//     turnStartedAt 原地不动），随后旁注落盘、工具继续直播上报。直播那一路要认得出「插话
//     之后那颗气泡就是还在飞的这一轮」——认不出就会被旁注一劈另开一颗，而且上半截会拿到
//     一个比自己起点还早的结束时刻（显示成「0s 用时」、当场折叠、挂出「派生新任务」）。
const REPLY_AT = "2026-09-15T13:45:32.742Z";
const MID_NOTE_AT = "2026-09-15T13:47:43.167Z";
const midSession = {
  ...session, startedAt: "2026-09-15T13:44:00.730Z", turnStartedAt: "2026-09-15T13:44:00.730Z", endedAt: null,
};
const midTraced = (at, event) => ({ at, turnStartedAt: midSession.startedAt, event });
const mid = buildConversationItems([{
  session: midSession,
  output: [
    sentinel({ t: "user", agent: "claude", text: "宽度限制？我是说侧边栏没必要加那么多限制", at: REPLY_AT }),
    "改回归断言：\n",
    sentinel({ t: "system", agent: "claude", text: "已预约审查：5.5审查。", at: MID_NOTE_AT, aside: true }),
  ].join(""),
  trace: [
    midTraced("2026-09-15T13:44:10.000Z", { kind: "tool", name: "Read", detail: "a.ts" }),
    midTraced("2026-09-15T13:46:30.000Z", { kind: "text", text: "改回归断言：\n" }),
    midTraced("2026-09-15T13:47:00.000Z", { kind: "tool", name: "Edit", detail: "test-chat.ts" }),
  ],
}], [midSession], [
  { kind: "server", id: "live-1", event: { taskId: "t1", sessionId: "s1", agentType: "claude", event: { kind: "tool", name: "Bash", detail: "ls node_modules" } } },
]);
const midTurn = agents(mid).at(-1);
assert.deepEqual(midTurn.segments.flatMap((s) => s.events).map((e) => e.label), ["Edit", "Bash"],
  "旁注之后直播上报的工具该写回插话后那一回合");
assert.equal(agents(mid).length, 2, "只该有「插话前的工具」和「插话后这一轮」两颗气泡");
assert.equal(midTurn.endedAt, null, "回合还在飞，不能被旁注后面那颗气泡按上结束时刻");

// 14. 兜底不变量：推断出来的收口时刻一律不早于回合起点。真结束（markerEndedAt）不受限。
for (const item of agents(mid).concat(agents(lead(leadNote)))) {
  if (!item.endedAt || !item.at) continue;
  assert.ok(Date.parse(item.endedAt) >= Date.parse(item.at), "回合不可能在开始之前就结束");
}

// 15. 「第 N 轮验证开始」落在 .md 的**第一行**（独立验证、或新会话一上来就先写这条）。
//     它跟第 12 条长得很像——前面都没有本回合正文——但它是落在两个回合**之间**的真边界，
//     必须照切不误。判据只能问 trace（下一组正从这一刻起头 = boundary），不能问服务端那个
//     aside 标：appendTaskTimeline 写的旁注全带标，这一条也带。拿标当判据就会把它一起挡掉，
//     审查者的正文退回普通气泡——丢掉 reviewer 身份，验证开始旁注还被排到正文后面
//     （第 1 轮审查报的）。
//
//     旁注跟真起跑之间**差多久都得一样**：服务端是先写这条旁注，再去等会话空闲、动态
//     import、查冻结、解析执行器、prepareResume，最后才生成 turnStart 落进 trace。几秒钟
//     是正常路径，不是构造出来的极端值。差出兜底窗口时正文就领不到自己那组事件，工具掉进
//     一颗空正文兜底气泡，同一轮又被拆成两颗（第 2 轮审查报的）。
const VERIFY_LEAD_SESSION = "2026-09-16T01:00:00.000Z";
const VERIFY_LEAD_NOTE_AT = "2026-09-16T01:05:00.000Z";
const VERIFY_LEAD_TURN_AT = "2026-09-16T01:05:00.400Z";
const verifyLeadCase = (turnAt, gap) => {
  const s = { ...session, startedAt: VERIFY_LEAD_SESSION, turnStartedAt: turnAt, endedAt: null };
  const items = buildConversationItems([{
    session: s,
    output: [
      sentinel({ t: "system", agent: "claude", text: "第 1 轮验证开始：就在这个任务的工作目录里跑。", at: VERIFY_LEAD_NOTE_AT, aside: true }),
      "第 1 轮结论：verified。",
    ].join(""),
    trace: [
      traced(turnAt, { kind: "run", model: "claude-opus-5", reasoningEffort: "high", verifyRound: 1 }, turnAt),
      traced("2026-09-16T01:06:00.000Z", { kind: "tool", name: "Bash", detail: "npm test" }, turnAt),
      traced("2026-09-16T01:07:00.000Z", { kind: "text", text: "第 1 轮结论：verified。" }, turnAt),
    ],
  }], [s], []);
  const [turn] = agents(items);
  assert.equal(agents(items).length, 1, `验证轮只该有审查者这一颗气泡（起跑晚 ${gap}）`);
  assert.equal(turn.reviewer?.round, 1, `开头那条「第 N 轮验证开始」是真边界，切掉就丢了审查者身份（起跑晚 ${gap}）`);
  assert.ok(items.indexOf(events(items)[0]) < items.indexOf(turn),
    `验证开始旁注开的是下一轮，该排在审查者发言**前面**（起跑晚 ${gap}）`);
  assert.deepEqual(turn.segments.flatMap((seg) => seg.events).map((e) => e.label), ["Bash"],
    `审查者该认领自己那一组 trace（起跑晚 ${gap}）`);
  assert.deepEqual(turn.run, { model: "claude-opus-5", reasoningEffort: "high" }, `run 该跟着 trace 走（起跑晚 ${gap}）`);
  assert.ok(turn.markdown.includes("第 1 轮结论"), `正文该留在审查者这颗气泡里（起跑晚 ${gap}）`);
};
verifyLeadCase(VERIFY_LEAD_TURN_AT, "0.4 秒");
verifyLeadCase("2026-09-16T01:05:05.000Z", "5 秒");
verifyLeadCase("2026-09-16T01:05:45.000Z", "45 秒");
const verifyLeadSession = { ...session, startedAt: VERIFY_LEAD_SESSION, turnStartedAt: VERIFY_LEAD_TURN_AT, endedAt: null };

// 16. 两种旁注前后脚落在同一条会话上：先是真边界（验证轮起头），紧接着审查者在自己回合里
//     一个字没吐就又落了一条任务时间线旁注。后者必须按第 12 条处理（不切），否则审查者
//     回合的前半截工具又会掉进一颗兜底气泡。
const mixed = buildConversationItems([{
  session: verifyLeadSession,
  output: [
    "实现完了。",
    sentinel({ t: "system", agent: "claude", text: "第 1 轮验证开始：就在这个任务的工作目录里跑。", at: VERIFY_LEAD_NOTE_AT, aside: true }),
    sentinel({ t: "system", agent: "claude", text: "预览已停止。", at: "2026-09-16T01:06:30.000Z", aside: true }),
    "第 1 轮结论：verified。",
  ].join("\n"),
  trace: [
    traced("2026-09-16T01:01:00.000Z", { kind: "text", text: "实现完了。" }, VERIFY_LEAD_SESSION),
    traced(VERIFY_LEAD_TURN_AT, { kind: "run", model: "claude-opus-5", reasoningEffort: "high", verifyRound: 1 }, VERIFY_LEAD_TURN_AT),
    traced("2026-09-16T01:06:00.000Z", { kind: "tool", name: "Bash", detail: "npm test" }, VERIFY_LEAD_TURN_AT),
    traced("2026-09-16T01:07:00.000Z", { kind: "tool", name: "Read", detail: "report.md" }, VERIFY_LEAD_TURN_AT),
    traced("2026-09-16T01:08:00.000Z", { kind: "text", text: "第 1 轮结论：verified。" }, VERIFY_LEAD_TURN_AT),
  ],
}], [verifyLeadSession], []);
assert.equal(agents(mixed).length, 2, "实现者一颗、审查者一颗，不该多出兜底气泡");
assert.equal(agents(mixed)[1].reviewer?.round, 1);
assert.deepEqual(agents(mixed)[1].segments.flatMap((s) => s.events).map((e) => e.label), ["Bash", "Read"],
  "审查者回合被旁注砸中的前半截工具要留在自己这颗气泡里");

console.log("conversation system-note tests passed");
