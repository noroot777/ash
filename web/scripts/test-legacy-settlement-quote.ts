// 老会话（2026-08-31 之前）写进正文的结算说明，不再画成智能体自己说的话。
//
// 那时候结算说明是一段引用块，直接写在回合收口那一行前面。照正文解析，它就成了那一回合气泡的最后一段：
// 执行者的气泡末尾多一句「> 回合正常结束,但本回合内没有收到 complete_task…」；审查者那条会话里一回合只有
// 这一句时，会话里还会单独冒出一颗不在任何审查段里的审查者气泡（全库扫出两个任务）。这份回归盯：
//   ① shared 的解析：那一段落成结算旁注（`level:"notice"`），收口时刻照旧盖在前面那段正文上；
//   ② 只认当年服务端写死的起头，并且这一段后面紧跟着就是收口那一行：智能体自己引的一段同样的话（后面还有
//      正文）照旧是正文；
//   ②' 现行格式写的正文（带记录号）、改写法那一版之后的收口：智能体末尾引用一句旧提示，照旧是它的回答；
//   ②'' 提问那两种说明按完整格式认：题目里有空行、分好几段，整段照样是结算旁注；
//   ③ 页面上：执行者气泡里没有这一句，它成了那一回合的尾注；老的「没交卷」说法照旧是要你知道的那一档；
//   ④ 审查者会话里「任务状态保持「X」不变」那一句（一回合只有它）：不出气泡，也哪儿都不画。
// 跑：npm -w web run test:legacy-settlement-quote
import assert from "node:assert/strict";
import type { Session } from "@ash/shared";
import { parseSessionTranscript } from "@ash/shared/session-output";
import { buildConversationItems } from "../src/task-detail/conversationModel.ts";
import { foldMonitorWakes } from "../src/task-detail/monitorWakeTurns.ts";
import { conversationFeedRows } from "../src/task-detail/conversationReviewLanes.ts";
import { conversationDebateRows } from "../src/task-detail/conversationDebateRows.ts";
import { conversationSystemRows } from "../src/task-detail/conversationSystemRows.ts";
import { crashedTurns } from "../src/task-detail/turnFailure.ts";

const line = (turn: Record<string, unknown>) => `\x1e${JSON.stringify(turn)}\n`;
const NO_DONE = "回合正常结束,但本回合内没有收到 complete_task 完成确认,任务记为未完成(failed)。可在下方继续对话让它补完。";
// 更早的那一版（2026-07）「但」后面带一个空格。
const NO_DONE_JULY = "回合正常结束,但 agent 未调用 complete_task 确认任务完成 —— 按严格完成协议记为 failed。若任务其实已完成,可手动把状态改成已完成;重试则会从中断处续跑。";
const STOPPED = "续聊回合被手动停止,任务状态保持「已完成」不变。";

const EXEC_OUTPUT = [
  line({ t: "user", agent: "claude", text: "把按钮改成蓝色。", at: "2026-08-20T01:00:00.000Z" }),
  "改好了，按钮现在是蓝色。\n",
  "\n",
  `> ${NO_DONE}\n`,
  "\n",
  line({ t: "agentEnd", at: "2026-08-20T01:05:00.000Z" }),
  line({ t: "user", agent: "claude", text: "再看看这段话。", at: "2026-08-20T01:10:00.000Z" }),
  // 智能体自己引了一句同样起头的话，后面还接着说：这是正文。
  `> ${NO_DONE}\n`,
  "\n",
  "上面这句是旧版服务端的说法，现在已经换了。\n",
  line({ t: "agentEnd", at: "2026-08-20T01:12:00.000Z" }),
].join("");

const REVIEWER_OUTPUT = [
  line({ t: "user", agent: "codex", text: "继续审查。", at: "2026-08-20T02:00:00.000Z" }),
  `> ${STOPPED}\n`,
  "\n",
  line({ t: "agentEnd", at: "2026-08-20T02:01:00.000Z" }),
].join("");

// ① + ②：解析。
{
  const { spans } = parseSessionTranscript(EXEC_OUTPUT);
  const segs = spans.map((span) => span.seg);
  const notes = segs.filter((seg) => seg.kind === "system" && seg.level === "notice");
  assert.equal(notes.length, 1, `只认收口前那一段：${JSON.stringify(segs)}`);
  assert.equal(notes[0]!.kind === "system" && notes[0]!.text, NO_DONE, "引用符号去掉，原文落成结算旁注");
  assert.equal(notes[0]!.kind === "system" && notes[0]!.at, "2026-08-20T01:05:00.000Z", "结算旁注的时刻取收口那一行");
  const agents = segs.filter((seg) => seg.kind === "agent");
  assert.equal(agents.length, 2);
  assert.equal(agents[0]!.kind === "agent" && agents[0]!.text, "改好了，按钮现在是蓝色。", "气泡里没有结算说明");
  assert.equal(agents[0]!.kind === "agent" && agents[0]!.endedAt, "2026-08-20T01:05:00.000Z", "收口时刻照旧盖在那段正文上");
  assert.ok(agents[1]!.kind === "agent" && agents[1]!.text.startsWith(`> ${NO_DONE}`), "智能体自己引的那一段照旧是正文");
  assert.equal(agents[1]!.kind === "agent" && agents[1]!.endedAt, "2026-08-20T01:12:00.000Z");
}

// ②'：现行格式（带记录号）末尾引用一句旧提示；不带记录号、但收口晚于改写法那一版的，同样不猜。
{
  const modern = [
    line({ t: "user", agent: "codex", text: "请只引用这句历史提示。", at: "2026-11-19T01:00:00.000Z", seq: 1, turnStartedAt: "2026-11-19T01:00:00.000Z" }),
    line({ t: "agent", at: "2026-11-19T01:00:05.000Z", seq: 2, turnStartedAt: "2026-11-19T01:00:00.000Z" }),
    `> ${STOPPED}\n`,
    "\n",
    line({ t: "agentEnd", at: "2026-11-19T01:00:06.000Z", seq: 3, turnStartedAt: "2026-11-19T01:00:00.000Z" }),
  ].join("");
  const late = [
    line({ t: "user", agent: "codex", text: "请只引用这句历史提示。", at: "2026-09-10T01:00:00.000Z" }),
    `> ${STOPPED}\n`,
    line({ t: "agentEnd", at: "2026-09-10T01:00:06.000Z" }),
  ].join("");
  for (const [name, out] of [["现行格式", modern], ["改写法之后", late]] as const) {
    const segs = parseSessionTranscript(out).spans.map((span) => span.seg);
    assert.ok(!segs.some((seg) => seg.kind === "system"), `${name}：不该改成结算旁注：${JSON.stringify(segs)}`);
    const agent = segs.find((seg) => seg.kind === "agent");
    assert.equal(agent?.kind === "agent" && agent.text, `> ${STOPPED}`, `${name}：那一句照旧是智能体的回答`);
  }
}

// ②''：老提问说明，题目里有空行。
{
  const NOTE = "本回合以提问暂停,等待答复:「第一项怎么处理？\n\n第二项怎么处理？」";
  const out = [
    line({ t: "user", agent: "claude", text: "两件事你看着办。", at: "2026-08-20T03:00:00.000Z" }),
    "两件事都需要你拍板。\n",
    `\n> ${NOTE}\n`,
    line({ t: "agentEnd", at: "2026-08-20T03:01:00.000Z" }),
  ].join("");
  const segs = parseSessionTranscript(out).spans.map((span) => span.seg);
  const note = segs.find((seg) => seg.kind === "system");
  assert.equal(note?.kind === "system" && note.text, NOTE, `整段提问说明落成结算旁注：${JSON.stringify(segs)}`);
  const agent = segs.find((seg) => seg.kind === "agent");
  assert.equal(agent?.kind === "agent" && agent.text, "两件事都需要你拍板。", "气泡里只剩智能体自己的话");
}

// 2026-07 那一版的说法（「但」后面带空格）同样认得，并且照旧是要你知道的那一档。
{
  const out = [
    line({ t: "user", agent: "claude", text: "整理一下这篇稿子。", at: "2026-07-21T08:50:00.000Z" }),
    "稿子整理好了。\n",
    `\n\n> ${NO_DONE_JULY}\n\n`,
    line({ t: "agentEnd", at: "2026-07-21T08:57:46.565Z" }),
  ].join("");
  const note = parseSessionTranscript(out).spans.map((span) => span.seg).find((seg) => seg.kind === "system");
  assert.equal(note?.kind === "system" && note.text, NO_DONE_JULY, "七月那一版的说法落成结算旁注");
  const session = { id: "S-july", taskId: "T-july", agentType: "claude", role: "single", startedAt: "2026-07-21T08:50:00.000Z" } as unknown as Session;
  const items = buildConversationItems([{ session, output: out, trace: [] }], [session], []);
  const shown = conversationSystemRows(conversationDebateRows(conversationFeedRows(items), {}));
  const parts = [...shown.footnotes.values()].flatMap((footnote) => footnote.parts);
  assert.ok(parts.some((part) => part.view.tier === "alert"), `七月那一版的「没交卷」照旧是要你知道的那一档：${JSON.stringify(parts.map((part) => part.view))}`);
}

// ③ + ④：页面上。
{
  const exec = { id: "S-exec", taskId: "T-legacy", agentType: "claude", role: "single", startedAt: "2026-08-20T01:00:00.000Z", endedAt: "2026-08-20T01:12:00.000Z" } as unknown as Session;
  const reviewer = { id: "S-rev", taskId: "T-legacy", agentType: "codex", role: "reviewer", startedAt: "2026-08-20T02:00:00.000Z", endedAt: "2026-08-20T02:01:00.000Z" } as unknown as Session;
  const items = foldMonitorWakes(buildConversationItems(
    [{ session: exec, output: EXEC_OUTPUT, trace: [] }, { session: reviewer, output: REVIEWER_OUTPUT, trace: [] }], [exec, reviewer], [],
  ));
  const shown = conversationSystemRows(conversationDebateRows(conversationFeedRows(items), {}), { failures: crashedTurns(items, null) });
  const agents = shown.rows.flatMap((row) => row.kind === "item" && row.item.kind === "agent" ? [row.item] : []);
  assert.deepEqual(agents.map((agent) => agent.sessionRole), ["single", "single"], `审查者会话不该冒出气泡：${JSON.stringify(agents.map((agent) => agent.markdown))}`);
  const first = agents[0]!;
  assert.ok(!first.markdown.includes("complete_task"), "执行者气泡里没有结算说明");
  const footnote = shown.footnotes.get(first.id)?.parts ?? [];
  const said = footnote.find((part) => part.view.text.includes("complete_task") || part.view.text.includes("未完成"));
  assert.ok(said, `结算说明成了那一回合的尾注：${JSON.stringify(footnote.map((part) => part.view))}`);
  assert.equal(said.view.tier, "alert", "老的「没交卷」说法照旧是要你知道的那一档");
  assert.ok(!JSON.stringify(shown).includes("任务状态保持"), "审查者会话那句「任务状态保持不变」哪儿都不画");
}

console.log("✓ legacy settlement quote");
