// 贴底跟随的判据（纯函数那一半；真实 DOM 那一半在 test-stick-to-bottom-dom.mjs）。
//
// 两个判据各管一头：
// - `stickStateAfterScroll`：这一次滚动之后，接下来还跟不跟。
// - `shouldStickToBottom`：这一次机会要不要真的动 scrollTop。
// - `contentVersion`：「多出要看的东西了」这个信号怎么算 —— 由拿着会话数据的人算，
//   不让贴底逻辑自己去 DOM 上猜（猜过一版，复制按钮闪一下就把人拽到底了）。
import assert from "node:assert/strict";
import { contentVersion, shouldStickToBottom, stickStateAfterScroll } from "../src/lib/useStickToBottom.ts";
import { conversationItemSize, executionEventSize } from "../src/task-detail/conversationContentSize.ts";
import { appendExecutionEvent } from "../src/lib/executionTrace.ts";
import { contentSegments, segmentHasVisibleContent } from "../src/task-detail/conversationSegments.ts";

// 用户从底部按住滚动条向上拖时，pointerdown 会建立 detaching user intent。
// 随后的 scroll 必须解除贴底；内容 resize/mutation 只能在 stuck=true 时补滚，
// 因而此状态会保持在历史位置，不被下一段流式输出抢回底部。
assert.equal(stickStateAfterScroll({
  stuck: true,
  nearBottom: false,
  programmatic: false,
  userDriven: true,
  detaching: true,
}), false);
assert.equal(stickStateAfterScroll({
  stuck: false,
  nearBottom: false,
  programmatic: false,
  userDriven: false,
  detaching: false,
}), false);

// 贴底的第二道闸:要不要真的动 scrollTop。用户手滚到离底 40px 停住,尾部没来新东西、
// 底边也没往下跑,这时候再 scrollTo 就是把他从停的位置拽到最底 —— 那一跳正是「快到底
// 时画面突然蹦一下」的来源,必须闸住。
const stick = (over) => shouldStickToBottom({ stuck: true, forced: false, tailAppended: false, atBottom: false, distance: 40, ...over });
assert.equal(stick({}), false);
// 尾部来了新东西才跟过去,这是贴底唯一该做的事。
assert.equal(stick({ tailAppended: true, distance: 240 }), true);
// 人在上面读历史时一律不跟。
assert.equal(stick({ stuck: false, tailAppended: true, distance: 900 }), false);
// 已经贴着底了就别再发一次 scrollTo:那会把浏览器正在跑的平滑滚动掐断。
assert.equal(stick({ tailAppended: true, distance: 0 }), false);
// 群聊/侧聊/助手只留最近 500 条:追加一条的同时最老那条被删掉,总高**纹丝不动**甚至
// 变短。这一帧恰恰最该跟过去,只看总高会把新回复整个漏在屏幕下面(审查 F1)。
assert.equal(stick({ tailAppended: true, distance: 79 }), true);
assert.equal(stick({ tailAppended: true, distance: 56 }), true);
// 尾部来了新东西,但人在上面读历史 —— 仍然不跟。
assert.equal(stick({ stuck: false, tailAppended: true, distance: 79 }), false);

/* 没有新可读内容时,唯一允许动位置的情形是「读者本来就贴着底」——
   而这个状态必须是**记下来的**,不能拿几何去推(见 shouldStickToBottom 的注释)。

   ① 他贴着底:底边因为任何原因往下跑了,都要把他继续带在底部 —— 回复框把视口挤矮、
      图片加载完占位变大,都是这一支。 */
assert.equal(stick({ atBottom: true, distance: 80 }), true);
assert.equal(stick({ atBottom: true, distance: 399 }), true);
/* ② 他离底几十像素,正在读:底边往下跑多少都不许动他。两类都栽在这儿过 ——
      隐藏通知在正文后留空段让高度 +7px(第 6 轮 F1);图片加载后浏览器锚定已经把
      scrollTop 补了 +399px、阅读位置本来没动,旧式子却算出负数当成「原来贴底」,
      又补一次回底(第 7 轮 F1)。 */
assert.equal(stick({ atBottom: false, distance: 86 }), false);
assert.equal(stick({ atBottom: false, distance: 79 }), false);
assert.equal(stick({ atBottom: false, distance: 478 }), false);
// 首屏 / 换任务是显式的一次性放行,不跟「他在哪」纠缠 —— 旧版把这件事混在同一个
// 负数里,两种意思分不开。
assert.equal(stick({ forced: true, stuck: false, atBottom: false, distance: 3200 }), true);
assert.equal(stick({ forced: true, distance: 0 }), false, "首屏已经在底部就别再发一次 scrollTo");
// 往顶上补历史不算尾部来新东西,他又不在底部时不跟。
assert.equal(stick({ tailAppended: false, atBottom: false, distance: 79 }), false);

/* 尾部指纹:它是「末尾多了要看的东西」的唯一来源,由拿着会话数据的人算。
   界面反馈(复制按钮变「已复制」、账目数字刷新、图标换一张)不碰这三样,
   所以读到一半的人不会被拽到底 —— 这正是审查 F2 复现的那一类。 */
const msg = (id, body, status = "ok") => ({ id, body, status });
const chatKey = (list) => contentVersion(list, (m) => m.body.length, (m) => `${m.id}:${m.status}`);
const base = [msg("m1", "一"), msg("m2", "二")];
// 同一批消息、同样的正文 —— 不管界面怎么闪,指纹必须稳。
assert.equal(chatKey(base), chatKey([msg("m1", "一"), msg("m2", "二")]));
// 来了新回复。
assert.notEqual(chatKey(base), chatKey([...base, msg("m3", "三")]));
// 最后一条在逐字长(流式输出)。
assert.notEqual(chatKey(base), chatKey([msg("m1", "一"), msg("m2", "二三")]));
// 最后一条收口(status 从 running 翻终态)。
assert.notEqual(chatKey(base), chatKey([msg("m1", "一"), msg("m2", "二", "running")]));
// 最近 500 条轮换:追加一条 + 淘汰最老一条,条数和总长都没变,指纹仍然必须变(审查 F1)。
const rolled = [msg("m2", "二"), msg("m3", "三")];
assert.equal(base.length, rolled.length);
assert.notEqual(chatKey(base), chatKey(rolled));
// 空列表不炸,且与「只有一条」区分得开。
assert.equal(chatKey([]), chatKey([]));
assert.notEqual(chatKey([]), chatKey([msg("m1", "")]));
/* 新内容不一定在最后一行:正在飞的那一轮常被末尾的旁注挡在后面,新文字追加回**前面**
   那条气泡。最后一条一个字没动、条数也没变 —— 只看最后一行就会漏掉(审查第 3 轮 F1)。 */
const aside = msg("aside", "审查已预约", "note");
const behind = [msg("m1", "一"), msg("m2", "二"), aside];
assert.notEqual(chatKey(behind), chatKey([msg("m1", "一"), msg("m2", "二续"), aside]));
// 连最后一条带旁注一起没动的「界面闪一下」,仍然必须稳。
assert.equal(chatKey(behind), chatKey([msg("m1", "一"), msg("m2", "二"), aside]));
// 最后一条收口(status 变)也要推进 —— 它换的是身份不是长度。
assert.notEqual(chatKey([msg("m1", "一")]), chatKey([msg("m1", "一", "running")]));


/* 「用户能读到多少字」这张表:算什么、不算什么。漏算一处,那一处的新输出就会长出屏幕
   而没人跟;多算一处(时刻、用量这类角标),界面闪一下就会把读到一半的人拽到底。 */
const agent = (over) => ({
  kind: "agent", id: "a1", sessionId: "s1", label: "codex", markdown: "", segments: [], ...over,
});
const seg = (over) => ({ id: "g1", markdown: "", events: [], attachments: [], ...over });

// 正文在长 —— 算。
assert.ok(conversationItemSize(agent({ markdown: "一二" })) > conversationItemSize(agent({ markdown: "一" })));
/* 思考原文在长 —— 也算。真实 producer 把连续思考拼进**已有那条** event 的 detail,
   条数、正文长度、段落个数全都不变(审查第 4 轮 F1)。 */
const thinkingOnce = appendExecutionEvent([], { kind: "thinking", label: "思考过程", detail: "想" });
const thinkingTwice = appendExecutionEvent(thinkingOnce, { kind: "thinking", label: "思考过程", detail: "续" });
assert.equal(thinkingTwice.length, thinkingOnce.length, "前提变了:连续思考不再合并进同一条");
assert.ok(conversationItemSize(agent({ segments: [seg({ events: thinkingTwice })] }))
  > conversationItemSize(agent({ segments: [seg({ events: thinkingOnce })] })));
// 工具详情、附件 —— 都算。
assert.ok(conversationItemSize(agent({ segments: [seg({ events: [{ kind: "tool", label: "bash", detail: "ls -la" }] })] }))
  > conversationItemSize(agent({ segments: [seg({ events: [{ kind: "tool", label: "bash" }] })] })));
assert.ok(conversationItemSize(agent({ segments: [seg({ attachments: ["/a.png"] })] }))
  > conversationItemSize(agent({ segments: [seg()] })));
// 时刻、用量、折叠状态、会话元信息 —— 都不算:它们一变就跟,等于让角标刷新把人拽到底。
const body = { markdown: "正文", segments: [seg({ markdown: "正文" })] };
const quiet = conversationItemSize(agent(body));
for (const noise of [
  { at: "2026-10-14T00:00:00Z" }, { endedAt: "2026-10-14T00:01:00Z" }, { continuation: true },
  { usage: { input: 10, output: 20 } }, { sessionUsage: { input: 99, output: 99 } },
  { sessionContext: { used: 1, limit: 2 } }, { showSessionMeta: true }, { interrupted: true },
]) assert.equal(conversationItemSize(agent({ ...body, ...noise })), quiet, `这个字段不该算进可读规模:${Object.keys(noise)[0]}`);
// 事件行的时刻同理不算,正文算。
const note = (over) => ({ kind: "event", id: "e1", text: "审查已预约", ...over });
assert.equal(conversationItemSize(note({ at: "2026-10-14T00:00:00Z" })), conversationItemSize(note()));
assert.ok(conversationItemSize(note({ text: "审查已预约了" })) > conversationItemSize(note()));
// 用户消息:正文和附件都算。
const said = (over) => ({ kind: "user", id: "u1", text: "问题", attachments: [], ...over });
assert.ok(conversationItemSize(said({ attachments: ["/a.png"] })) > conversationItemSize(said()));

/* 「这个表面会不会把它画出来」这道闸。子智能体那条线会往同一串 events 里塞
   activity / result / agent 通知和带 parentId 的嵌套调用,主对话一个字都不渲染
   (ExecutionTrace 三个入口都先 filter 一道)。算进规模就成了「屏幕没变化却自己跳到底」
   —— 审查第 5 轮 F1。 */
const toolEvent = (over) => ({ kind: "tool", label: "Agent", detail: "子任务进展", ...over });
const visibleOnly = conversationItemSize(agent({ segments: [seg({ events: [toolEvent()] })] }));
for (const hidden of [
  { type: "activity", id: "child", event: { kind: "text", text: "子任务正文" } },
  { type: "result", id: "child", result: "子任务结果", failed: false },
  { type: "agent", id: "child", title: "子智能体", status: "running" },
  // 嵌套调用:有 parentId 的那条也不渲染。
  { type: "call", id: "child", parentId: "parent", name: "Agent", input: {} },
]) {
  const withHidden = conversationItemSize(agent({
    segments: [seg({ events: [toolEvent(), toolEvent({ nativeWork: hidden })] })],
  }));
  assert.equal(withHidden, visibleOnly, `不渲染的通知不该推进版本:${hidden.type}${hidden.parentId ? "(嵌套)" : ""}`);
}
// 顶层调用那一行是真画出来的 —— 它要算。
assert.ok(conversationItemSize(agent({
  segments: [seg({ events: [toolEvent(), toolEvent({ nativeWork: { type: "call", id: "child", name: "Agent", input: {} } })] })],
})) > visibleOnly);
/* 同一道闸按**单条**问也得是这个答案:闸只拦聚合入口的话,下一个人新开一个单条调用点
   就绕过去了,所以这里直接问单条函数。 */
for (const hidden of [
  { type: "activity", id: "child", event: { kind: "text", text: "子任务正文" } },
  { type: "result", id: "child", result: "子任务结果", failed: false },
  { type: "agent", id: "child", title: "子智能体", status: "running" },
  { type: "call", id: "child", parentId: "parent", name: "Agent", input: {} },
]) assert.equal(executionEventSize(toolEvent({ nativeWork: hidden })), 0,
  `单条问也得是 0:${hidden.type}${hidden.parentId ? "(嵌套)" : ""}`);
assert.ok(executionEventSize(toolEvent()) > 0, "画得出来的那条,单条问不该是 0");
/* 这道闸只挡不进 DOM 的那些:用户把「执行过程」折起来时,思考原文仍在 DOM 里、
   展开就能读,折叠期间来的新思考照样要推进(否则第 4 轮那条就回来了)。 */
const folded = appendExecutionEvent([{ kind: "thinking", label: "思考过程", detail: "想" }],
  { kind: "thinking", label: "思考过程", detail: "续" });
assert.ok(conversationItemSize(agent({ segments: [seg({ events: folded })] }))
  > conversationItemSize(agent({ segments: [seg({ events: [{ kind: "thinking", label: "思考过程", detail: "想" }] })] })));
/* 分段布局:**空段就是高度**。
   画不出东西的通知如果单独成一段,正文后面就多一个空 `<section>` —— 空的也占 7px
   (`.task-agent-segment + .task-agent-segment`),scrollHeight 跟着涨。前一版判据看见
   底边下移就当「有新东西」,把停在离底 79px 的人拽到底(审查第 6 轮 F1)。
   所以根因在这一层:不让纯通知单独成段。事件本身仍要留着 —— 子智能体抽屉的数据
   (buildNativeWork)就是从 segments[].events 里提的。 */
const traceEntry = (event) => ({ at: "2026-10-14T09:00:00Z", event });
const hiddenNotice = {
  kind: "tool", name: "Agent", detail: "子任务进展",
  nativeWork: { type: "activity", id: "child", event: { kind: "text", text: "子任务正文" } },
};
const afterBody = (event) => contentSegments(
  [traceEntry({ kind: "text", text: "说完的正文" }), traceEntry(event)],
  "说完的正文",
  "turn",
);
// 正文之后来一条画不出来的通知:仍然只有一段,事件挂在这一段上没丢。
const noticeOnly = afterBody(hiddenNotice);
assert.equal(noticeOnly.length, 1, "画不出东西的通知不该另起一段");
assert.equal(noticeOnly[0].markdown, "说完的正文");
assert.equal(noticeOnly[0].events.length, 1, "事件本身不能丢:抽屉的数据就从这里提");
// 正文之后来一条真工具调用:照旧切段,这一层没把真内容一起挡掉。
assert.equal(afterBody({ kind: "tool", name: "Bash", detail: "ls -la" }).length, 2, "真工具调用仍要另起一段");
// 思考也是画得出来的。
assert.equal(afterBody({ kind: "thinking", text: "再想一下" }).length, 2);
// 谓词本身:三类可见内容各算一类,只剩隐藏通知就是「画不出东西」。
const seg2 = (over) => ({ id: "s", markdown: "", events: [], attachments: [], ...over });
assert.equal(segmentHasVisibleContent(seg2({ events: [{ kind: "tool", label: "Agent", detail: "进展", nativeWork: hiddenNotice.nativeWork }] })), false);
assert.equal(segmentHasVisibleContent(seg2({ markdown: "字" })), true);
assert.equal(segmentHasVisibleContent(seg2({ attachments: ["/a.png"] })), true);
assert.equal(segmentHasVisibleContent(seg2({ events: [{ kind: "thinking", label: "思考过程", detail: "想" }] })), true);
assert.equal(segmentHasVisibleContent(seg2()), false, "空段就是空段");

/* 布局过滤**不许吃掉数据**。整段 trace 里一个字都没有、只有画不出来的后台通知时,
   「不另起一段」和「并回上一段」两条都无处落地(压根没有上一段),事件一度就卡在局部
   变量里被直接丢掉 —— 子智能体那条线的 raw 记录没了(审查第 7 轮 B5)。
   分段函数只负责保全记录;画不画交给展示谓词。空 text 在通知前后都要成立。 */
for (const [label, trace] of [
  ["通知在后", [traceEntry({ kind: "text", text: "" }), traceEntry(hiddenNotice)]],
  ["通知在前", [traceEntry(hiddenNotice), traceEntry({ kind: "text", text: "" })]],
]) {
  const kept = contentSegments(trace, "", "turn");
  const events = kept.flatMap((segment) => segment.events);
  assert.equal(events.length, 1, `${label}:空正文把子智能体的 raw 记录丢了`);
  assert.equal(events[0].nativeWork?.type, "activity", `${label}:留下的不是那条通知`);
  // 它仍然画不出东西 —— 渲染侧不会给它出 section,所以不占高度。
  assert.ok(kept.every((segment) => !segmentHasVisibleContent(segment)), `${label}:这一段不该被当成有内容`);
}

console.log("贴底判据回归验证通过(判据纯函数 + 可读规模契约)");
