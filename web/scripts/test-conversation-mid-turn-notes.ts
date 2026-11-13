// 回合中间落下的记录（哨兵已起 / 结束、审查预约、预览起停、后台子代理还在跑、上游重试…）
// 不许让任何一步脱离它所在的回合。
//
// 病症（负责人 2026-11-13 截图，任务 HbUq9Pj7tcWv 第 1 轮审查）：「预览已打开」「预览已回收」
// 两条记录中间夹着一条 git status，刷新后它被单独铺成一颗只有过程、没有正文的气泡，排在真回合
// 后面，还被当成「正在跑」挂着计时。根因是切点规则：回合中间的记录只要「后面任何地方还有正文」
// 就切，可切出来的那一截只有**紧跟着的**正文会来领。实时那一路旁注不拆气泡，于是开着页面看是
// 一颗、刷新后多出一颗。
//
// 这里把同一段会话分别走「落盘重建」和「实时到达」（以及中途才打开页面的各个切口）三路，断言
// 回合怎么分、每一步在哪颗气泡里一模一样；外加删除出处：并进来的那几步要跟着气泡一起删掉，
// 判据用服务端真正的删除函数（server/src/conversation-redact.ts），不在这里另抄一份。
//
// 跑：npm -w web run test:conversation-mid-turn-notes
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { traceKeptOnDelete } from "@ash/shared/session-output";
import { buildConversationItems, type ConversationItem, type TimelineEntry } from "../src/task-detail/conversationModel.ts";

// 服务端删除那几个纯函数所在的模块会连带打开数据库：指到临时目录，别碰真实的库。
const stage = mkdtempSync(join(tmpdir(), "ash-mid-turn-notes-"));
process.env.ASH_DB = join(stage, "ash.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
process.env.ASH_UPLOADS_DIR = join(stage, "uploads");
const { RedactRefusal, redactTranscript, redactTrace, traceSpanWindow } = await import("../../server/src/conversation-redact.ts");

type Agent = Extract<ConversationItem, { kind: "agent" }>;
type Step =
  | { say: string; at: string }
  // event：盘上那条事件的原样（子智能体、附件…）；缺省是一条名叫 tool 的普通工具调用。
  | { tool: string; at: string; event?: Record<string, unknown> }
  | { note: string; at: string; aside?: boolean }
  | { user: string; at: string; bySystem?: boolean }
  | { turn: string; verifyRound?: number }
  | { turnEnd: string };

const SESSION_AT = "2026-11-13T03:44:00.000Z";
const RUN = { model: "gpt-5.6", reasoningEffort: "high" };
const sentinel = (payload: object) => `\n\x1e${JSON.stringify(payload)}\n`;
const agents = (items: ConversationItem[]) => items.filter((item): item is Agent => item.kind === "agent");
const stepsOf = (item: Agent) => item.segments.flatMap((segment) => segment.events).map((event) => event.label);
const compact = (text: string) => text.replace(/\s+/g, "");
const shape = (items: ConversationItem[]) => agents(items).map((item) => ({ prose: compact(item.markdown), steps: stepsOf(item) }));

/** 这段会话此刻的会话行：`running` 时最后一轮还没收口。 */
function sessionOf(steps: readonly Step[], running: boolean) {
  const turns = steps.flatMap((step) => "turn" in step ? [step.turn] : []);
  return {
    id: "s1", taskId: "t1", agentType: "codex", executor: "codex@cpa", role: "single",
    startedAt: SESSION_AT, turnStartedAt: turns.at(-1) ?? SESSION_AT,
    endedAt: running ? null : "2026-11-13T05:00:00.000Z",
  } as never;
}

/** 落盘那一路：.md（正文 + sentinel）和 trace。 */
function persisted(steps: readonly Step[]) {
  let md = "";
  let turnAt = SESSION_AT;
  const trace: { at: string; turnStartedAt: string; event: Record<string, unknown> }[] = [];
  for (const step of steps) {
    if ("turn" in step) {
      turnAt = step.turn;
      trace.push({ at: step.turn, turnStartedAt: turnAt, event: { kind: "run", ...RUN, ...(step.verifyRound ? { verifyRound: step.verifyRound } : {}) } });
    } else if ("say" in step) {
      md += `${step.say}\n`;
      trace.push({ at: step.at, turnStartedAt: turnAt, event: { kind: "text", text: `${step.say}\n` } });
    } else if ("tool" in step) {
      trace.push({ at: step.at, turnStartedAt: turnAt, event: step.event ?? { kind: "tool", name: step.tool } });
    } else if ("note" in step) {
      md += sentinel({ t: "system", agent: "codex", text: step.note, at: step.at, ...(step.aside === false ? {} : { aside: true }) });
    } else if ("user" in step) {
      md += sentinel({ t: "user", agent: "codex", text: step.user, at: step.at, ...(step.bySystem ? { by: "system" } : {}) });
    } else {
      md += sentinel({ t: "agentEnd", at: step.turnEnd });
    }
  }
  return { output: md, trace };
}

/** 实时那一路：同样的事件按顺序一条条到达（从第 `from` 步起；之前那几步只用来认这一刻是谁在说）。 */
function live(steps: readonly Step[], from = 0): TimelineEntry[] {
  const timeline: TimelineEntry[] = [];
  let verifyRound: number | undefined;
  const server = (event: Record<string, unknown>): TimelineEntry => ({
    kind: "server", id: `live-${timeline.length}`,
    event: { type: "agent.event", taskId: "t1", sessionId: "s1", agentType: "codex", ...(verifyRound ? { verifyRound } : {}), event } as never,
  });
  for (const [index, step] of steps.entries()) {
    if ("turn" in step) verifyRound = step.verifyRound;
    else if (index < from) continue;
    else if ("say" in step) timeline.push(server({ kind: "text", text: `${step.say}\n` }));
    else if ("tool" in step) timeline.push(server(step.event ?? { kind: "tool", name: step.tool }));
    else if ("note" in step) timeline.push(server({ kind: "system", text: step.note, at: step.at, aside: step.aside !== false }));
    else if ("user" in step) timeline.push({ kind: "user", id: `live-${timeline.length}`, text: step.user, attachments: [], at: step.at, bySystem: step.bySystem, sessionId: "s1" });
    else timeline.push(server({ kind: "turnEnd" }));
  }
  return timeline;
}

const rebuild = (steps: readonly Step[], running = false) => {
  const session = sessionOf(steps, running);
  return buildConversationItems([{ session, ...persisted(steps) } as never], [session], []);
};

/**
 * 任何时刻都一样：走到第 `now` 步时，不论页面是从第 `opened` 步起开着的（之前那截落盘、之后
 * 那截实时一条条到达，`opened = 0` 就是从头看着），还是这一刻刷新，画出来的回合怎么分、每一步
 * 在哪颗气泡里都相同。会话行取那一刻的（最后一轮还没收口就是在跑）。
 *
 * 回合收口（任务落定）时页面会整份重读（useConversation 的 load），之前实时到达的那些就
 * 并进了落盘那一份 —— 所以「开着的页面」最早只能从上一次收口之后算起。
 */
function sameEverywhere(label: string, steps: readonly Step[]): ConversationItem[] {
  for (let now = 1; now <= steps.length; now += 1) {
    const sofar = steps.slice(0, now);
    const session = sessionOf(sofar, now < steps.length);
    const refreshed = shape(rebuild(sofar, now < steps.length));
    const settled = sofar.findLastIndex((step) => "turnEnd" in step) + 1;
    for (let opened = settled; opened < now; opened += 1) {
      const head = opened ? [{ session, ...persisted(sofar.slice(0, opened)) } as never] : [];
      assert.deepEqual(shape(buildConversationItems(head, [session], live(sofar, opened))), refreshed,
        `${label}：走到第 ${now} 步时，从第 ${opened} 步起开着的页面跟刷新后分得不一样`);
    }
  }
  return rebuild(steps);
}

const traceOnly = (items: ConversationItem[]) => agents(items).filter((item) => !item.markdown.trim());

// ── 1) 两条记录挨着，中间只有几步、没有正文（截图那一幕） ───────────────────────
const between: Step[] = [
  { turn: SESSION_AT },
  { say: "先看改动。", at: "2026-11-13T03:44:30.000Z" },
  { tool: "git diff HEAD^ HEAD", at: "2026-11-13T03:45:04.000Z" },
  { note: "自由工作流预览已打开：npm run dev", at: "2026-11-13T03:45:05.323Z" },
  { tool: "git status --short; ls web/node_modules/.bin/vite", at: "2026-11-13T03:45:29.653Z" },
  { note: "预览已回收（用户关闭了自由工作流预览）", at: "2026-11-13T03:45:37.508Z" },
  { tool: "npm -w web run build", at: "2026-11-13T03:45:53.000Z" },
  { say: "第 1 轮结论：未通过。", at: "2026-11-13T03:54:56.000Z" },
];
{
  const items = sameEverywhere("两条记录夹着几步", between);
  assert.equal(agents(items).length, 1, "一个回合就是一颗气泡");
  assert.deepEqual(stepsOf(agents(items)[0]!), ["git diff HEAD^ HEAD", "git status --short; ls web/node_modules/.bin/vite", "npm -w web run build"],
    "夹在两条记录中间的那一步要按时间排在这一回合的执行过程里");
  assert.equal(traceOnly(items).length, 0, "不该有只有过程的气泡");
  // 任务还在跑：「正在跑」落在真回合上，不落在多出来的那一截上。
  const running = rebuild(between.slice(0, -1), true);
  assert.equal(agents(running).length, 1);
  assert.equal(agents(running).at(-1)!.endedAt, null, "回合还在跑");
  assert.equal(stepsOf(agents(running).at(-1)!).at(-1), "npm -w web run build", "最后一步在真回合里");
}

// ── 2) 哨兵已起之后这一回合没再说话，后面的正文是叫醒之后的下一回合 ──────────────
const monitorWait: Step[] = [
  { turn: SESSION_AT },
  { say: "挂个哨兵等测试。", at: "2026-11-13T03:50:00.000Z" },
  { note: "哨兵已起：本轮改过的 model.test.ts", at: "2026-11-13T03:50:10.000Z" },
  { tool: "ash/pause_task", at: "2026-11-13T03:50:12.000Z" },
  { turnEnd: "2026-11-13T03:50:15.000Z" },
  { note: "哨兵结束：本轮改过的 model.test.ts", at: "2026-11-13T03:51:00.000Z" },
  { user: "【哨兵事件】本轮改过的 model.test.ts 跑完了", at: "2026-11-13T03:51:01.000Z", bySystem: true },
  { turn: "2026-11-13T03:51:01.000Z" },
  { say: "测试全绿。", at: "2026-11-13T03:51:30.000Z" },
];
{
  const items = sameEverywhere("哨兵已起之后回合就收工", monitorWait);
  assert.equal(agents(items).length, 2, "等哨兵的一回合 + 叫醒之后的一回合");
  assert.deepEqual(stepsOf(agents(items)[0]!), ["ash/pause_task"], "pause_task 那一步在等哨兵的那个回合里");
  assert.equal(traceOnly(items).length, 0);
}

// ── 3) 记录之后连着跑工具、一个字没说，直到被你的话截断 ───────────────────────
const toolsUntilSteer: Step[] = [
  { turn: SESSION_AT },
  { say: "开始实现。", at: "2026-11-13T03:45:00.000Z" },
  { note: "后台还有 2 个子代理在跑", at: "2026-11-13T03:46:00.000Z" },
  { tool: "rg conversationModel", at: "2026-11-13T03:46:10.000Z" },
  { tool: "npm -w web run build", at: "2026-11-13T03:47:00.000Z" },
  { user: "先别改 server", at: "2026-11-13T03:48:00.000Z" },
  { say: "好，只动前端。", at: "2026-11-13T03:48:30.000Z" },
];
{
  const items = sameEverywhere("记录之后一路跑工具直到插话", toolsUntilSteer);
  assert.equal(agents(items).length, 2, "插话前一颗、插话后一颗");
  assert.deepEqual(stepsOf(agents(items)[0]!), ["rg conversationModel", "npm -w web run build"], "记录之后那一截属于插话前那一回合");
  assert.equal(traceOnly(items).length, 0);
}

// ── 4) 不变：真人中途插话之后它没再说话，插话后面那几步仍是单独一颗 ─────────────
{
  const items = sameEverywhere("插话之后没再说话", [
    { turn: SESSION_AT },
    { say: "开始实现。", at: "2026-11-13T03:45:00.000Z" },
    { user: "顺便看下日志", at: "2026-11-13T03:46:00.000Z" },
    { tool: "tail server.log", at: "2026-11-13T03:46:10.000Z" },
  ]);
  assert.equal(agents(items).length, 2);
  assert.deepEqual(stepsOf(agents(items)[1]!), ["tail server.log"]);
  assert.equal(agents(items)[1]!.markdown, "", "插话之后的那几步照旧是一颗只有过程的气泡");
}

// ── 5) 不变：「第 N 轮审查开始」照旧把执行者和审查者分开 ──────────────────────
{
  const items = sameEverywhere("审查开始是真边界", [
    { turn: SESSION_AT },
    { say: "实现完了。", at: "2026-11-13T03:45:00.000Z" },
    { turnEnd: "2026-11-13T03:45:10.000Z" },
    { note: "自由工作流第 1 轮审查开始：顶级审查。", at: "2026-11-13T03:50:00.000Z" },
    { turn: "2026-11-13T03:50:00.400Z", verifyRound: 1 },
    { tool: "npm test", at: "2026-11-13T03:51:00.000Z" },
    { say: "第 1 轮结论：通过。", at: "2026-11-13T03:52:00.000Z" },
  ]);
  assert.equal(agents(items).length, 2, "执行者一颗、审查者一颗");
  assert.equal(agents(items)[1]!.reviewer?.round, 1);
  assert.deepEqual(stepsOf(agents(items)[1]!), ["npm test"]);
}

// ── 6) 不变：回合开头就落了记录、之后才开口（2026-09-16 那一幕） ─────────────────
{
  const items = sameEverywhere("记录落在开口之前", [
    { turn: SESSION_AT },
    { tool: "Read a.png", at: "2026-11-13T03:45:00.000Z" },
    { note: "已预约审查：顶级审查。", at: "2026-11-13T03:46:00.000Z" },
    { tool: "node repro.mjs", at: "2026-11-13T03:47:00.000Z" },
    { say: "复现了，现在改。", at: "2026-11-13T03:48:00.000Z" },
  ]);
  assert.equal(agents(items).length, 1);
  assert.deepEqual(stepsOf(agents(items)[0]!), ["Read a.png", "node repro.mjs"]);
  assert.ok(items.findIndex((item) => item.kind === "event") > items.findIndex((item) => item.kind === "agent"), "记录排成这一回合的尾注");
}

// ── 7) 删除出处：并进来的那几步跟着气泡一起删，删别的气泡照旧 ─────────────────
/**
 * 照页面那样把一颗气泡的出处交给服务端的删除函数，返回删完之后盘上的 .md 和 trace。
 *
 * `readSide`：服务端读 trace 时接在末尾补出来、盘上没有的那几条（server 的 mergeImageJournal /
 * enrichNativeWorkModels）。页面拿到的是「盘上原样 + 这几条」，服务端删除时重算指纹只看盘上那份。
 */
function deleteBubble(
  steps: readonly Step[],
  pick: (bubbles: Agent[]) => Agent,
  readSide: (disk: ReturnType<typeof persisted>["trace"]) => ReturnType<typeof persisted>["trace"] = () => [],
) {
  const { output, trace } = persisted(steps);
  const traceRaw = trace.map((entry) => JSON.stringify(entry)).join("\n");
  const session = sessionOf(steps, false);
  const served = buildConversationItems([{ session, output, trace: [...trace, ...readSide(trace)] } as never], [session], []);
  const sources = pick(agents(served)).sources ?? [];
  assert.ok(sources.length, "这颗气泡该有删除入口");
  const redacted = redactTranscript(output, sources.flatMap((source) => "index" in source ? [source] : []));
  let windows;
  try {
    windows = [
      ...redacted.windows,
      ...sources.flatMap((source) => "trace" in source ? [traceSpanWindow(traceRaw, source.trace)] : []),
    ];
  } catch (error) {
    // 服务端认定页面上那份跟盘上对不上，整次拒绝：什么都没动。
    if (error instanceof RedactRefusal) return { refused: true as const, left: trace, items: [] as ConversationItem[] };
    throw error;
  }
  const left = redactTrace(traceRaw, windows).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { refused: false as const, left, items: buildConversationItems([{ session, output: redacted.text, trace: left } as never], [session], []) };
}
{
  const { left, items } = deleteBubble(between, (bubbles) => bubbles[0]!);
  assert.deepEqual(left.filter((entry) => !traceKeptOnDelete(entry.event.kind)), [],
    "删掉这个回合，两条记录中间那一步也得从 trace 里删掉");
  assert.equal(agents(items).length, 0, "删完刷新不该冒出只有过程的气泡");
}
{
  const { left, items } = deleteBubble(monitorWait, (bubbles) => bubbles[1]!);
  assert.deepEqual(agents(items).map(stepsOf), [["ash/pause_task"]], "删叫醒之后那一回合，等哨兵那一回合原样留着");
  assert.ok(left.some((entry) => entry.event.name === "ash/pause_task"));
}
{
  const { items } = deleteBubble(monitorWait, (bubbles) => bubbles[0]!);
  assert.deepEqual(agents(items).map((item) => compact(item.markdown)), ["测试全绿。"], "删等哨兵那一回合，连 pause_task 那一步一起没了");
}

// ── 8) 删除出处：子智能体那种回合，盘上的每一步都得删掉 ─────────────────────
// 服务端读的时候会给子智能体补一条模型档案，时刻照抄那条真事件、接在 trace 末尾（盘上没有）。
// 指纹不能数它，可跟它同一毫秒的那条真事件（子智能体交回的正文）一样得删；盘上本来就存着的
// status 为 unknown 的子智能体事件、只剩一张图的那一截，也都是真内容，一条都不能留。
const AGENT_AT = "2026-11-13T03:46:10.000Z";
const subagents: Step[] = [
  { turn: SESSION_AT },
  { say: "派两个子代理去读。", at: "2026-11-13T03:45:00.000Z" },
  { note: "后台还有 2 个子代理在跑", at: "2026-11-13T03:46:00.000Z" },
  { tool: "Agent", at: AGENT_AT, event: { kind: "tool", name: "Agent", detail: "已写入 36 条，文件在 /tmp/raw.json",
    nativeWork: { type: "agent", id: "toolu_1", status: "completed", result: "已写入 36 条，文件在 /tmp/raw.json" } } },
  { tool: "Agent", at: "2026-11-13T03:46:20.000Z", event: { kind: "tool", name: "Agent", nativeWork: { type: "agent", id: "toolu_2", status: "unknown" } } },
  { note: "后台的子代理都结束了", at: "2026-11-13T03:47:00.000Z" },
  { tool: "shot.png", at: "2026-11-13T03:47:10.000Z", event: { kind: "attachment", path: "/tmp/shot.png" } },
  { note: "预览已回收", at: "2026-11-13T03:47:20.000Z" },
  { say: "两份都读完了。", at: "2026-11-13T03:48:00.000Z" },
];
{
  const { left, items } = deleteBubble(subagents, (bubbles) => bubbles[0]!, (disk) => [{
    at: AGENT_AT, turnStartedAt: SESSION_AT,
    event: { kind: "tool", name: "Agent", detail: "unknown", nativeWork: { type: "agent", id: "toolu_1", status: "unknown", model: "claude-opus-5-5", at: AGENT_AT } },
  }].filter(() => disk.length > 0));
  assert.deepEqual(left.filter((entry) => !traceKeptOnDelete(entry.event.kind)), [],
    "跟读侧补出来的条目同一毫秒的真事件、盘上 status 为 unknown 的子智能体、只剩一张图的那一截，都得跟着回合删掉");
  assert.equal(agents(items).length, 0);
}

// ── 9) 删除出处：回合末尾盘上真有的子智能体事件 / 图，要么删干净、要么整次拒绝 ──────────
// 这三种形状也可能是服务端读的时候补在末尾的（见 conversationTraceSources 的 readSideTail），
// 页面靠推断认它们；盘上 trace 恰好以它们收尾（停止、异常退出、没收到用量）时就会认错。认错的
// 那一条也必须照样落在删除时间段里：结局只许是删干净或服务端整次拒绝，不许「删好了」却留着原文；
// 只有执行过程的那颗气泡也一样要有删除入口。
const realTails: [string, Record<string, unknown>][] = [
  ["status 为 unknown 的子智能体", { kind: "tool", name: "Agent", detail: "子智能体交回的正文 /tmp/private.txt",
    nativeWork: { type: "agent", id: "real-agent", status: "unknown", result: "子智能体交回的正文 /tmp/private.txt" } }],
  ["顶层附件", { kind: "attachment", path: "/tmp/private.png" }],
  ["子智能体那一层的附件", { kind: "tool", name: "Agent", nativeWork: { type: "activity", id: "real-agent", event: { kind: "attachment", path: "/tmp/private-child.png" } } }],
];
for (const [label, event] of realTails) {
  const tail: Step = { tool: label, at: "2026-11-13T03:46:20.000Z", event };
  for (const [shapeLabel, steps] of [
    ["正文回合", [
      { turn: SESSION_AT },
      { say: "先读文件。", at: "2026-11-13T03:45:00.000Z" },
      { note: "后台还有子代理在跑", at: "2026-11-13T03:46:00.000Z" },
      { tool: "pwd", at: "2026-11-13T03:46:10.000Z" },
      tail,
      { turnEnd: "2026-11-13T03:49:00.000Z" },
    ]],
    ["只有执行过程的回合", [{ turn: SESSION_AT }, { tool: "pwd", at: "2026-11-13T03:46:10.000Z" }, tail]],
  ] as [string, Step[]][]) {
    const result = deleteBubble(steps, (bubbles) => bubbles[0]!);
    if (result.refused) continue;
    assert.deepEqual(result.left.filter((entry) => !traceKeptOnDelete(entry.event.kind)), [],
      `${shapeLabel}末尾是盘上真有的${label}：删除被接受了，就不许留下原文`);
    assert.equal(agents(result.items).length, 0);
  }
}
// 附件不进指纹，认错了也删得掉 —— 这一种不该被拒。
assert.equal(deleteBubble([{ turn: SESSION_AT }, { say: "先读文件。", at: "2026-11-13T03:45:00.000Z" },
  { note: "后台还有子代理在跑", at: "2026-11-13T03:46:00.000Z" }, { tool: "pwd", at: "2026-11-13T03:46:10.000Z" },
  { tool: "shot", at: "2026-11-13T03:46:20.000Z", event: realTails[1]![1] }], (bubbles) => bubbles[0]!).refused, false);

rmSync(stage, { recursive: true, force: true });
console.log("conversation mid-turn notes tests passed");
process.exit(0);
