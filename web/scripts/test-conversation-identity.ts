// 带身份的会话记录：落盘重建、实时到达、中途才打开页面（落盘快照 + 之后的实时）三路拼出来的气泡一模一样。
//
// 记录用服务端真正的写法生成（server/src/transcript.ts、transcript-identity.ts：发号、标记行、sentinel），
// 实时事件照单飞那一路带上同一个号（single-run-voice.ts 的 publishEvent），再交给页面的归并
// （conversationAssembler）。要钉住的：
//   ① 三路同形：回合怎么分、每一步在哪颗气泡、起止时刻、谁是被插话打断的半截；回合中间的旁注、会话轮换
//      注记（先播后落盘）、快照与实时重叠的那几条（含一条只有一半落了盘的正文增量）都不劈气泡、不重复
//   ② 结束时刻：有回合行的就是回合行那一刻（`Session.turnEnds`）；老记录同样（任务 HbUq9Pj7tcWv 审查会话
//      MYBNlfWPDQzq 的形状：第 1 回合该在 03:54:57.606 收口，曾被推成 04:04:47.082）
//   ③ 删除：有正文的按段、只有执行过程的按「回合 + 前后两句输入的号」，用服务端真正的删除函数判；
//      trace 以真有的 unknown 子智能体事件收尾也删得掉；读的时候补出来的（origin）不进指纹
//   ④ 页面发的那一句凭 clientKey 认回去，不比原文
//
// 跑：npm -w web run test:conversation-identity
import assert from "node:assert/strict";
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseSessionSpans, traceSpanFingerprint } from "@ash/shared/session-output";
import type { SessionTraceEntry } from "../src/lib/api.ts";
import { buildConversationItems, type ConversationItem, type TimelineEntry } from "../src/task-detail/conversationModel.ts";
import { mergeUserTimeline } from "../src/lib/useConversation.ts";

const stage = mkdtempSync(join(tmpdir(), "ash-conversation-identity-"));
process.env.ASH_DB = join(stage, "ash.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
process.env.ASH_UPLOADS_DIR = join(stage, "uploads");
const { appendSessionTrace, sessionTracePath, sessionTranscriptPath, writeTurn, writeTurnEnd } = await import("../../server/src/transcript.ts");
const { bindTranscript, onRecord, reserveRecord, writeProse } = await import("../../server/src/transcript-identity.ts");
const { redactTrace, redactTranscript, traceSpanWindow, traceStepsWindow } = await import("../../server/src/conversation-redact.ts");
const ok = (message: string) => console.log("   ✓ " + message);

type Agent = Extract<ConversationItem, { kind: "agent" }>;
const T = (minute: number, second = 0) => `2026-11-14T01:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;
const TASK = "t-identity";

/** 一个单飞回合：照 single-run-voice 的样子写 .md / trace、播实时事件。 */
function turn(sessionId: string, turnStartedAt: string, timeline: TimelineEntry[]) {
  const mdPath = sessionTranscriptPath(TASK, sessionId);
  mkdirSync(dirname(mdPath), { recursive: true });
  const out = createWriteStream(mdPath, { flags: "a" });
  bindTranscript(out, { taskId: TASK, sessionId, turnStartedAt });
  let pending = "";
  let clock = turnStartedAt;
  const flush = () => {
    if (!pending) return;
    appendSessionTrace(TASK, sessionId, turnStartedAt, { kind: "text", text: pending }, clock);
    pending = "";
  };
  onRecord(out, flush);
  const later: { text: string; at: string; identity: ReturnType<typeof reserveRecord> }[] = [];
  const publish = (event: object, record?: { seq: number; textOffset?: number } | null) => timeline.push({
    kind: "server", id: `e${timeline.length}`,
    event: { type: "agent.event", taskId: TASK, sessionId, role: "single", agentType: "codex", model: "gpt-5.6", reasoningEffort: "high", turnStartedAt, ...(record ?? {}), event } as never,
  });
  const api = {
    out,
    at(at: string) { clock = at; return api; },
    run() { appendSessionTrace(TASK, sessionId, turnStartedAt, { kind: "run", model: "gpt-5.6", reasoningEffort: "high" }, turnStartedAt); return api; },
    input(text: string, at: string, extra: { bySystem?: true; clientKey?: string } = {}) {
      const identity = writeTurn(out, { t: "user", agent: "codex", text, ...(extra.bySystem ? { by: "system" as const } : {}), ...(extra.clientKey ? { clientKey: extra.clientKey } : {}) }, at);
      timeline.push({ kind: "user", id: `u${timeline.length}`, text, attachments: [], at, sessionId, sessionRole: "single", source: "server", seq: identity!.seq, turnStartedAt: identity!.turnStartedAt, ...extra });
      return api;
    },
    say(text: string) {
      const prose = writeProse(out, text)!;
      pending += text;
      publish({ kind: "text", text }, { seq: prose.seq, textOffset: prose.offset });
      return api;
    },
    step(event: SessionTraceEntry["event"], at = clock) {
      flush();
      publish(event, { seq: appendSessionTrace(TASK, sessionId, turnStartedAt, event as never, at) });
      return api;
    },
    tool(name: string, at = clock) { return api.step({ kind: "tool", name, detail: name }, at); },
    note(text: string, at: string, aside = true) {
      const identity = writeTurn(out, { t: "system", agent: "codex", text, ...(aside ? { aside: true as const } : {}) }, at);
      publish({ kind: "system", text, at, ...(aside ? { aside: true } : {}) }, identity);
      return api;
    },
    // 会话轮换注记：实时立刻播，落盘攒到回合收口之后（single-run-voice 的 noteSessionNotice）。
    notice(text: string, at: string) {
      const identity = reserveRecord(out);
      later.push({ text, at, identity });
      publish({ kind: "system", text, at }, identity);
      return api;
    },
    async end(endedAt: string) {
      flush();
      writeTurnEnd(out, endedAt);
      for (const notice of later.splice(0)) writeTurn(out, { t: "system", agent: "codex", text: notice.text }, notice.at, notice.identity);
      publish({ kind: "done", exitStatus: 0, turnOutcome: "completed", endedAt });
      await new Promise<void>((resolve) => out.end(resolve));
    },
    /** 盘上此刻那一份（中途才打开页面时读到的）。 */
    async drain() { await new Promise<void>((resolve) => out.write("", () => resolve())); return api; },
  };
  return api;
}

const read = (sessionId: string) => ({
  output: readFileSync(sessionTranscriptPath(TASK, sessionId), "utf8"),
  trace: readFileSync(sessionTracePath(TASK, sessionId), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as SessionTraceEntry),
});
const sessionRow = (id: string, turnEnds: Record<string, string | null>, extra: object = {}) => ({
  id, taskId: TASK, agentType: "codex", executor: "codex@cpa", role: "single", startedAt: T(0), turnStartedAt: Object.keys(turnEnds).at(-1) ?? T(0),
  endedAt: null, turnEnds, turnOutcomes: {}, ...extra,
}) as never;
const agents = (items: ConversationItem[]) => items.filter((item): item is Agent => item.kind === "agent");
const compact = (text: string) => text.replace(/\s+/g, "");
const shape = (items: ConversationItem[]) => items.map((item) => item.kind === "agent"
  ? { kind: "agent", id: item.id, turn: item.turnStartedAt, at: item.at, endedAt: item.endedAt, interrupted: !!item.interrupted, prose: compact(item.markdown), steps: item.segments.flatMap((segment) => segment.events.map((event) => event.label)) }
  : { kind: item.kind, id: item.id, text: item.text });

// ── ① 三路同形 ──────────────────────────────────────────────────────────────
const S1 = "s-identity";
const timeline: TimelineEntry[] = [];
const turn1 = turn(S1, T(1), timeline);
turn1.input("把首页改成两栏", T(1), { clientKey: "k-first" }).run().at(T(1, 5)).say("我先看一下现在的布局。").tool("read", T(1, 10)).say("\n\n两栏需要改三处").at(T(1, 20));
turn1.note("预约审查已登记", T(1, 30)).say("，先改导航。").tool("edit", T(1, 40)).notice("上一条会话已轮换", T(1, 45));
await turn1.drain();
const snapshot = { ...read(S1), cut: timeline.length };
turn1.say("导航改好了。").tool("edit", T(2, 0)).input("顺便把页脚也改了", T(2, 10)).say("好，页脚也一起改。").tool("edit", T(2, 30))
  .step({ kind: "usage", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: null, turns: 1 } } as never);
await turn1.end(T(3, 0));
// 第 2 回合：哨兵叫醒（系统代写的输入），只动了手、没说话 —— 一颗只有执行过程的气泡。
const turn2 = turn(S1, T(5), timeline);
turn2.input("哨兵结果：测试通过", T(5), { bySystem: true }).run().tool("bash", T(5, 10)).tool("bash", T(5, 20));
turn2.step({ kind: "tool", name: "agent", detail: "subagent", nativeWork: { type: "agent", id: "sub-1", status: "unknown" } } as never, T(5, 30));
await turn2.end(T(6, 0));

const disk = read(S1);
const ends = { [T(1)]: T(3, 0), [T(5)]: T(6, 0) };
const rebuilt = buildConversationItems([{ session: sessionRow(S1, ends), ...disk }], [sessionRow(S1, ends)], []);
const live = buildConversationItems([], [sessionRow(S1, ends)], timeline);
// 中途打开：读盘那一刻之前到的几条实时事件跟快照重叠（服务端播了、页面也读到了）。
const overlap = timeline.slice(snapshot.cut - 3);
// 再造一条「只有一半落了盘」的正文增量：它从盘上那段正文末尾往前两个字起。
const firstLive = overlap.findIndex((entry, index) => index >= 3 && entry.kind === "server" && entry.event.event.kind === "text");
const split = overlap[firstLive] as Extract<TimelineEntry, { kind: "server" }>;
const tail = snapshot.output.split("\n").filter((line) => line && !line.startsWith("\x1e")).at(-1)!.slice(-2);
overlap[firstLive] = { ...split, event: { ...split.event, textOffset: split.event.textOffset! - 2, event: { kind: "text", text: tail + (split.event.event as { text: string }).text } } };
const midway = buildConversationItems([{ session: sessionRow(S1, ends), output: snapshot.output, trace: snapshot.trace }], [sessionRow(S1, ends)], overlap);

assert.deepEqual(shape(live), shape(rebuilt), "实时到达与落盘重建同形");
assert.deepEqual(shape(midway), shape(rebuilt), "中途打开（快照 + 重叠的实时）与落盘重建同形");
const [part1, part2, steps] = agents(rebuilt);
assert.equal(agents(rebuilt).length, 3, "三颗气泡：第 1 回合被插话切成两截 + 第 2 回合只有执行过程");
assert.equal(compact(part1!.markdown), compact("我先看一下现在的布局。\n\n两栏需要改三处，先改导航。导航改好了。"), "旁注夹在正文中间不劈气泡，正文原样接回去");
assert.deepEqual(part1!.segments.flatMap((segment) => segment.events.map((event) => event.label)), ["read", "edit", "edit"], "旁注前后的步子都在这颗里");
assert.equal(rebuilt.filter((item) => item.kind === "event").length, 2, "旁注和轮换注记各一条，不重复");
assert.equal(rebuilt.filter((item) => item.kind === "user").length, 3, "三句输入，不重复");
assert.ok(rebuilt.findIndex((item) => item.kind === "event" && item.text === "上一条会话已轮换") < rebuilt.indexOf(part2!), "先播后落盘的注记排在它真正发生的位置");
assert.equal(part1!.interrupted, true, "回合里插进来的一句话：前半截是被打断的");
assert.equal(part1!.endedAt, T(2, 10), "前半截收在那句话的时刻");
assert.equal(part1!.at, T(1), "前半截从回合起点起");
assert.equal(part2!.at, T(2, 10), "后半截从那句话起");
assert.equal(part2!.endedAt, T(3, 0), "后半截收在回合行的结束时刻");
assert.equal(part2!.interrupted, false);
assert.deepEqual(part2!.usage?.output, 5, "用量归它那一回合最后那颗");
assert.equal(steps!.markdown, "", "只有执行过程的回合不凭空长正文");
assert.equal(steps!.endedAt, T(6, 0));
ok("落盘重建、实时到达、中途打开（含重叠与半截正文）三路同形；旁注与先播后落盘的注记不劈气泡；插话切出的前半截收在插话那一刻");

{
  // 回合行还没跟上（实时刚收到 done，会话行要等下一次拉取）：结束时刻用 done 带的那一刻，跟盘上 agentEnd 是同一个。
  const fresh = { [T(1)]: T(3, 0) };
  const liveOnly = agents(buildConversationItems([], [sessionRow(S1, fresh)], timeline));
  assert.equal(liveOnly[2]!.endedAt, T(6, 0), "没有回合行时用实时收口带的时刻");
  const rebuiltOnly = agents(buildConversationItems([{ session: sessionRow(S1, fresh), ...disk }], [sessionRow(S1, fresh)], []));
  assert.equal(rebuiltOnly[2]!.endedAt, T(6, 0), "落盘那一路用 agentEnd，同一个值");
  // 有回合行就照回合行，哪怕 agentEnd 记的是另一刻。
  const later = { [T(1)]: T(3, 30), [T(5)]: T(6, 0) };
  assert.equal(agents(buildConversationItems([{ session: sessionRow(S1, later), ...disk }], [sessionRow(S1, later)], []))[1]!.endedAt, T(3, 30));
  ok("结束时刻：有回合行照回合行，没有时两路都用同一个收口时刻");
}

// ── ③ 删除 ────────────────────────────────────────────────────────────────
{
  const withJournal: SessionTraceEntry[] = [...disk.trace, { at: T(5, 25), turnStartedAt: T(5), origin: "journal", event: { kind: "attachment", path: "/uploads/shot.png" } }];
  const items = agents(buildConversationItems([{ session: sessionRow(S1, ends), output: disk.output, trace: withJournal }], [sessionRow(S1, ends)], []));
  assert.ok(items[2]!.segments.some((segment) => segment.attachments.includes("/uploads/shot.png")), "读侧补回的图挂回它那一回合的气泡");
  const stepsSource = items[2]!.sources!;
  assert.equal(stepsSource.length, 1);
  assert.ok("steps" in stepsSource[0]!, "只有执行过程的气泡按回合 + 输入区间指名");
  const traceRaw = readFileSync(sessionTracePath(TASK, S1), "utf8");
  const window = traceStepsWindow(traceRaw, (stepsSource[0] as { steps: Parameters<typeof traceStepsWindow>[1] }).steps);
  const afterSteps = redactTrace(traceRaw, [window]);
  assert.doesNotMatch(afterSteps, /"bash"|"agent"/, "那一回合的步子（含末尾真有的 unknown 子智能体事件）全删掉");
  assert.match(afterSteps, /"read"/, "别的回合不动");
  const afterItems = buildConversationItems([{ session: sessionRow(S1, ends), output: disk.output, trace: afterSteps.split("\n").filter(Boolean).map((line) => JSON.parse(line)).concat(withJournal.slice(-1)) }], [sessionRow(S1, ends)], []);
  assert.equal(agents(afterItems).length, 2, "删完不冒出只有读侧补回那张图的孤儿气泡");

  // 有正文的前半截：按段删，服务端摘掉同一回合、两句输入之间的那几步。
  const prose = items[0]!.sources!.filter((source): source is { sessionId: string; index: number; fingerprint: string } => "index" in source);
  assert.ok(prose.length >= 2, "被旁注劈开的几段都报上");
  const md = redactTranscript(disk.output, prose);
  const traceAfter = redactTrace(traceRaw, md.windows);
  const after = agents(buildConversationItems([{ session: sessionRow(S1, ends), output: md.text, trace: traceAfter.split("\n").filter(Boolean).map((line) => JSON.parse(line)) }], [sessionRow(S1, ends)], []));
  assert.equal(after.length, 2, "前半截连同它的步子一起没了，不留只有过程的气泡");
  assert.equal(compact(after[0]!.markdown), compact("好，页脚也一起改。"), "后半截原样");
  assert.deepEqual(after[0]!.segments.flatMap((segment) => segment.events.map((event) => event.label)), ["edit"]);
  assert.doesNotMatch(traceAfter, /"read"/, "前半截的步子从 trace 里摘掉");
  ok("删除：只有执行过程的按回合 + 输入区间删（末尾真有的 unknown 子智能体也删得掉），有正文的连同同一区间的步子删；读侧补回的不进指纹、不冒孤儿");
}

{
  // 老记录（没有号）+ 认来源记号的服务端：trace 以真有的 unknown 子智能体事件收尾，指纹照样对得上。
  const S2 = "s-legacy-tail";
  const entries: SessionTraceEntry[] = [
    { at: T(10, 1), turnStartedAt: T(10), event: { kind: "tool", name: "bash", detail: "ls" } },
    { at: T(10, 2), turnStartedAt: T(10), event: { kind: "tool", name: "agent", detail: "sub", nativeWork: { type: "agent", id: "sub-1", status: "unknown" } } as never },
  ];
  const pageTrace = [...entries, { at: T(10, 3), turnStartedAt: T(10), origin: "models" as const, event: { kind: "tool", name: "agent", detail: "profile", nativeWork: { type: "agent", id: "sub-1", status: "unknown" } } as never }];
  const output = `\n\x1e${JSON.stringify({ t: "user", agent: "codex", text: "跑一下", at: T(10) })}\n`;
  const session = sessionRow(S2, { [T(10)]: T(11) });
  const bubble = agents(buildConversationItems([{ session, output, trace: pageTrace }], [session], []))[0]!;
  const source = bubble.sources![0] as { trace: { from: string; to: string; fingerprint: string } };
  assert.equal(source.trace.fingerprint, traceSpanFingerprint(entries), "只有读侧补的那条不进指纹");
  assert.doesNotThrow(() => traceSpanWindow(entries.map((entry) => JSON.stringify(entry)).join("\n"), source.trace), "服务端按盘上那份核对得上");
  ok("老记录：读侧补的条目按来源记号排除，真有的 unknown 子智能体收尾不再被当成补出来的");
}

// ── ② 老记录的结束时刻照回合行（MYBNlfWPDQzq 的形状） ─────────────────────────
{
  const S3 = "s-legacy-review";
  const line = (payload: object) => `\x1e${JSON.stringify(payload)}`;
  const output = [
    line({ t: "system", agent: "codex", text: "〔系统〕继续（从中断处）", at: T(20) }), "我先核对需求。",
    line({ t: "system", agent: "codex", text: "第 1 轮审查未通过", aside: true, at: T(29) }),
    line({ t: "agentEnd", at: T(30) }),
    line({ t: "system", agent: "codex", text: "第 2 轮审查开始", aside: true, at: T(33) }),
    line({ t: "system", agent: "codex", text: "〔系统〕继续（从中断处）", at: T(34) }), "复查完毕。",
    line({ t: "system", agent: "codex", text: "第 2 轮审查通过", aside: true, at: T(39) }),
    line({ t: "agentEnd", at: T(40) }), "",
  ].join("\n");
  const trace: SessionTraceEntry[] = [
    { at: T(20, 1), turnStartedAt: T(20), event: { kind: "run", model: "gpt-5.6", reasoningEffort: "high" } },
    { at: T(21), turnStartedAt: T(20), event: { kind: "tool", name: "read", detail: "a" } },
    { at: T(34, 1), turnStartedAt: T(34), event: { kind: "run", model: "gpt-5.6", reasoningEffort: "high" } },
    { at: T(35), turnStartedAt: T(34), event: { kind: "tool", name: "read", detail: "b" } },
  ];
  const session = sessionRow(S3, { [T(20)]: T(30), [T(34)]: T(40) }, { role: "reviewer" });
  const [first, second] = agents(buildConversationItems([{ session, output, trace }], [session], []));
  assert.equal(first!.endedAt, T(30), "第 1 回合收在它自己的回合行");
  assert.equal(second!.endedAt, T(40));
  ok("老记录有回合行的那一回合：结束时刻照回合行，不再被推到下一回合的收口");
}

// ── ④ clientKey ─────────────────────────────────────────────────────────────
{
  const optimistic: TimelineEntry = { kind: "user", id: "o1", text: "改成两栏", attachments: [], at: T(50), source: "optimistic", clientKey: "k1" };
  const server: TimelineEntry = { kind: "user", id: "s1", text: "改成两栏", attachments: [], at: T(52), source: "server", sessionId: S1, seq: 99, turnStartedAt: T(52), clientKey: "k1" };
  assert.deepEqual(mergeUserTimeline([optimistic], server as never), [server], "同一个凭据：服务端那份替掉先画的那份，隔了两分钟也认");
  const other = { ...server, clientKey: "k2", at: T(50, 5) };
  assert.equal(mergeUserTimeline([optimistic], other as never).length, 2, "凭据不同：原文一样、时刻挨着也是两句");
  // 落盘那份已经带着这个凭据：先画的那份（服务端事件漏了）不再画第二遍。
  const items = buildConversationItems([{ session: sessionRow(S1, ends), ...disk }], [sessionRow(S1, ends)], [{ ...optimistic, text: "把首页改成两栏", clientKey: "k-first" }]);
  assert.equal(items.filter((item) => item.kind === "user").length, 3, "落盘那份凭据对上了，先画的那份不重复");
  ok("页面发的那一句凭 clientKey 认回去，不比原文和时刻");
}

assert.equal(parseSessionSpans(disk.output).every(({ seg }) => typeof seg.seq === "number"), true, "带身份的会话每一段都有号");
rmSync(stage, { recursive: true, force: true });
console.log("test-conversation-identity: ok");
process.exit(0);
