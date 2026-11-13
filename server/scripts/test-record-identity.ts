// 会话记录的身份（记录号 + 回合）在服务端这一头：发号、恢复、单一写者、读侧来源记号、按身份删。
//
// 页面那一头（三路拼出来一样、删除指名）在 web/scripts/test-conversation-identity.ts，那边同样用这里的
// 写法生成记录。这里只钉服务端自己的几条：
//   ① 号在一条会话里单调递增，.md 与 trace 共用一个号段；进程重启（计数器清零）后从两份文件的尾巴接着发
//   ② 回合在跑时，回合外的追加者（时间线旁注）从同一条流写：正文在它那一处切开、各带自己的号，trace 里攒着的
//      正文先落、在同一处切开；没有在跑的流时，单飞会话照样带号，团队调度台不带（它那一路还是老读法）
//   ③ trace 盘上那一行带着 `origin` 不认（那是读的时候补出来的才有的）
//   ④ 按身份删一截执行过程：指纹对不上（页面那份旧了）就拒绝，不多删一条
// 跑:npm -w server run test:record-identity
import assert from "node:assert/strict";
import { appendFileSync, createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseSessionSpans, parseSessionTranscript, traceStepsFingerprint } from "@ash/shared/session-output";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-record-identity-"));
process.env.ASH_DB = join(stage, "ash.db");
requireTmpDb("test-record-identity");
process.env.ASH_RUNS_DIR = join(stage, "runs");
process.env.ASH_UPLOADS_DIR = join(stage, "uploads");
const ok = (message: string) => console.log("   ✓ " + message);

const { appendSessionTrace, parseSessionTrace, sessionTracePath, sessionTranscriptPath, writeTurn, writeTurnEnd } = await import("../src/transcript.js");
const { bindTranscript, onRecord, writeProse } = await import("../src/transcript-identity.js");
const { forgetRecordSeq, nextRecordSeq } = await import("../src/session-seq.js");
const { appendTranscriptLine } = await import("../src/task-timeline.js");
const { RedactRefusal, traceStepsWindow } = await import("../src/conversation-redact.js");

const TASK = "t-record-identity";
const TURN = "2026-11-14T02:00:00.000Z";
const at = (second: number) => `2026-11-14T02:00:${String(second).padStart(2, "0")}.000Z`;
const traceOf = (sessionId: string) => parseSessionTrace(readFileSync(sessionTracePath(TASK, sessionId), "utf8"));

function liveTurn(sessionId: string) {
  const path = sessionTranscriptPath(TASK, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  const out = createWriteStream(path, { flags: "a" });
  bindTranscript(out, { taskId: TASK, sessionId, turnStartedAt: TURN });
  let pending = "";
  const flush = () => { if (pending) appendSessionTrace(TASK, sessionId, TURN, { kind: "text", text: pending }, at(1)); pending = ""; };
  onRecord(out, flush);
  return {
    out,
    say(text: string) { const prose = writeProse(out, text); pending += text; return prose; },
    async end() { flush(); writeTurnEnd(out, at(9)); await new Promise<void>((resolve) => out.end(resolve)); },
  };
}

// ── ① 发号、恢复 ─────────────────────────────────────────────────────────────
{
  const S = "s-seq";
  const run = liveTurn(S);
  const user = writeTurn(run.out, { t: "user", agent: "codex", text: "开始" }, at(0));
  const first = run.say("第一段");
  const tool = appendSessionTrace(TASK, S, TURN, { kind: "tool", name: "read", detail: "a" }, at(2));
  const second = run.say("，接着说");
  assert.equal(first!.seq, second!.seq, "中间只隔着一步工具：还是同一段正文");
  assert.deepEqual([first!.offset, second!.offset], [0, 3], "增量带着它在那段正文里从第几个字起");
  await run.end();
  const seqs = [user!.seq, first!.seq, tool];
  assert.deepEqual([...seqs].sort((a, b) => a - b), seqs, "号按写下的先后递增，.md 与 trace 共用一个号段");
  const { spans, agentEnds } = parseSessionTranscript(readFileSync(sessionTranscriptPath(TASK, S), "utf8"));
  const prose = spans.find(({ seg }) => seg.kind === "agent")!.seg as { raw?: string; seq?: number; turnStartedAt?: string };
  assert.equal(prose.raw, "第一段，接着说", "盘上那段正文原样，跟实时增量拼起来一字不差");
  assert.equal(prose.turnStartedAt, TURN);
  assert.ok(typeof agentEnds[0]?.seq === "number" && agentEnds[0]!.turnStartedAt === TURN, "回合收口也带身份");
  const max = Math.max(...traceOf(S).map((entry) => entry.seq ?? 0), agentEnds[0]!.seq!);
  forgetRecordSeq(S);
  assert.equal(nextRecordSeq(TASK, S), max + 1, "重启后从两份文件的尾巴接着发，不撞号");
  // 最大的号在 .md 的 agentEnd 上；它的尾巴里没有号（大段没号的正文压在末尾）时整份读，号段照样接得上。
  // （领了没写下去的号不追回：号只要求不撞、不要求连续。）
  assert.equal(agentEnds[0]!.seq, max, "前提：最大的号在 .md 里");
  appendFileSync(sessionTranscriptPath(TASK, S), `${"老记录正文\n".repeat(60_000)}`);
  forgetRecordSeq(S);
  assert.equal(nextRecordSeq(TASK, S), max + 1, "尾巴里找不到号就读整份");
  ok("号单调递增、两份文件共用；重启后从文件里接着发");
}

// ── ② 单一写者 ───────────────────────────────────────────────────────────────
{
  const S = "s-writer";
  const run = liveTurn(S);
  writeTurn(run.out, { t: "user", agent: "codex", text: "开始" }, at(0));
  const before = run.say("旁注之前");
  const note = await appendTranscriptLine(TASK, { id: S, role: "single" }, (out) => writeTurn(out, { t: "system", agent: "codex", text: "预约审查已登记", aside: true }, at(3)));
  const after = run.say("旁注之后");
  await run.end();
  assert.ok(note && note.seq > before!.seq && after!.seq > note.seq, "旁注从同一条流写，号排在两段正文之间");
  assert.equal(note!.turnStartedAt, TURN, "旁注归正在跑的那一回合");
  assert.deepEqual(parseSessionSpans(readFileSync(sessionTranscriptPath(TASK, S), "utf8")).map(({ seg }) => [seg.kind, seg.text]),
    [["user", "开始"], ["agent", "旁注之前"], ["system", "预约审查已登记"], ["agent", "旁注之后"]], "正文在旁注那一处切开，没被砸进中间");
  assert.deepEqual(traceOf(S).filter((entry) => entry.event.kind === "text").map((entry) => [entry.event.kind === "text" && entry.event.text, (entry.seq ?? 0) < note!.seq]),
    [["旁注之前", true], ["旁注之后", false]], "trace 里攒着的正文先落，跟 .md 在同一处切开");

  const idle = await appendTranscriptLine(TASK, { id: "s-idle", role: "single" }, (out) => writeTurn(out, { t: "system", agent: "codex", text: "验收完成", aside: true }, at(20)));
  assert.ok(idle && idle.turnStartedAt === null, "没有回合在跑：单飞会话照样带号，不归任何回合");
  const lead = await appendTranscriptLine(TASK, { id: "s-lead", role: "lead" }, (out) => writeTurn(out, { t: "system", agent: "codex", text: "验收完成", aside: true }, at(20)));
  assert.equal(lead, null, "团队调度台的正文不带号（那一路还是老读法）");
  ok("回合在跑时旁注从同一条流写、正文与 trace 在同一处切开；不在跑时单飞照样带号、调度台不带");
}

// ── ③ 盘上的来源记号不认 ─────────────────────────────────────────────────────
{
  const line = JSON.stringify({ at: at(1), turnStartedAt: TURN, seq: 3, origin: "journal", event: { kind: "tool", name: "x" } });
  const [entry] = parseSessionTrace(`${line}\n`);
  assert.equal(entry?.seq, 3);
  assert.equal("origin" in entry!, false, "盘上那一行带着 origin 就当没有：只有读的时候补出来的才带");
  ok("trace 盘上带来源记号的照盘上的算");
}

// ── ④ 按身份删一截执行过程 ───────────────────────────────────────────────────
{
  const raw = [
    { at: at(1), turnStartedAt: TURN, seq: 1, event: { kind: "run", model: null, reasoningEffort: null } },
    { at: at(2), turnStartedAt: TURN, seq: 3, event: { kind: "tool", name: "bash", detail: "ls" } },
    { at: at(3), turnStartedAt: TURN, seq: 4, event: { kind: "tool", name: "agent", detail: "sub", nativeWork: { type: "agent", id: "a1", status: "unknown" } } },
    { at: at(4), turnStartedAt: TURN, seq: 6, event: { kind: "tool", name: "edit", detail: "b" } },
  ].map((entry) => JSON.stringify(entry)).join("\n");
  const inside = parseSessionTrace(raw).filter((entry) => entry.seq! > 2 && entry.seq! < 5);
  const span = { turnStartedAt: TURN, after: 2, until: 5, fingerprint: traceStepsFingerprint(inside) };
  const window = traceStepsWindow(raw, span);
  assert.deepEqual(window, { turnStartedAt: TURN, afterSeq: 2, untilSeq: 5 }, "末尾是真有的 unknown 子智能体事件也认");
  assert.throws(() => traceStepsWindow(raw, { ...span, until: null }), (error) => error instanceof RedactRefusal && error.status === 409, "区间里多出页面没见过的一步：拒绝");
  assert.throws(() => traceStepsWindow(raw, { ...span, turnStartedAt: at(30) }), (error) => error instanceof RedactRefusal && error.status === 409, "那个回合里没有可删的：拒绝");
  ok("按身份删一截执行过程：指纹按号核对，对不上整次拒绝");
}

releaseTmpDb();
rmSync(stage, { recursive: true, force: true });
console.log("test-record-identity: ok");
process.exit(0);
