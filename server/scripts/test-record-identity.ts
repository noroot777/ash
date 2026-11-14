// 会话记录的身份（记录号 + 回合）在服务端这一头：发号、恢复、单一写者、读侧来源记号、按身份删。
//
// 页面那一头（三路拼出来一样、删除指名）在 web/scripts/test-conversation-identity.ts，那边同样用这里的
// 写法生成记录。这里只钉服务端自己的几条：
//   ① 号在一条会话里单调递增，.md 与 trace 共用一个号段；进程重启（计数器清零）后从两份文件的尾巴接着发；
//      trace 的每一步记着它落在正文的哪个位置（哪段正文写到第几个字）
//   ② 回合在跑时，回合外的追加者（时间线旁注）从同一条流写：正文在它那一处切开、各带自己的号，trace 里攒着的
//      正文先落、在同一处切开；没有在跑的流时，单飞会话照样带号，团队调度台不带（它那一路还是老读法）
//   ③ trace 盘上那一行带着 `origin` 不认（那是读的时候补出来的才有的）
//   ④ 按身份删一截执行过程：指纹对不上（页面那份旧了）就拒绝，不多删一条
//   ⑤ 恢复号段只认记录元数据：正文里的 `"seq":…` 示例、不安全的整数不算；读不出来、号顶到上限，这一回合整个
//      不带号，但正式流照样登记成写者、回合中间的旁注从它写；绑定以后领号不会失败，一回合不会写到一半忽然不带号
//   ⑥ trace 只在这条会话有正式流时带号（团队调度台、duet 那种没走身份协议的写者整条都不带）；带身份的回合里
//      执行诊断块不留下没号的正文
//   ⑦ 谁是写者在锁里定：正式流登记时排在锁后面的旁注从正式流写；短命流不顶掉正式流的登记
// 跑:npm -w server run test:record-identity
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const { appendSessionTrace, parseSessionTrace, sessionTracePath, sessionTranscriptPath, writeRunError, writeTurn, writeTurnEnd } = await import("../src/transcript.js");
const { bindTranscript, claimTranscript, liveTranscript, onRecord, writeProse } = await import("../src/transcript-identity.js");
const { forgetRecordSeq, forgetTaskRecordSeq, nextRecordSeq } = await import("../src/session-seq.js");
const { withRunFileLock } = await import("../src/run-file-lock.js");
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
  assert.deepEqual(tool?.textAt, { seq: first!.seq, offset: 3 }, "这一步落在第一段正文写到第 3 个字的时候（trace 那一行带着）");
  assert.deepEqual(traceOf(S).find((entry) => entry.event.kind === "tool")?.textAt, { seq: first!.seq, offset: 3 });
  const seqs = [user!.seq, first!.seq, tool!.seq];
  assert.deepEqual([...seqs].sort((a, b) => a - b), seqs, "号按写下的先后递增，.md 与 trace 共用一个号段");
  const { spans, agentEnds } = parseSessionTranscript(readFileSync(sessionTranscriptPath(TASK, S), "utf8"));
  const prose = spans.find(({ seg }) => seg.kind === "agent")!.seg as { raw?: string; seq?: number; turnStartedAt?: string };
  assert.equal(prose.raw, "第一段，接着说", "盘上那段正文原样，跟实时增量拼起来一字不差");
  assert.equal(prose.turnStartedAt, TURN);
  assert.ok(typeof agentEnds[0]?.seq === "number" && agentEnds[0]!.turnStartedAt === TURN, "回合收口也带身份");
  const max = Math.max(...traceOf(S).map((entry) => entry.seq ?? 0), agentEnds[0]!.seq!);
  forgetRecordSeq(TASK, S);
  assert.equal(nextRecordSeq(TASK, S), max + 1, "重启后从两份文件的尾巴接着发，不撞号");
  // 最大的号在 .md 的 agentEnd 上；它的尾巴里没有号（大段没号的正文压在末尾）时整份读，号段照样接得上。
  // （领了没写下去的号不追回：号只要求不撞、不要求连续。）
  assert.equal(agentEnds[0]!.seq, max, "前提：最大的号在 .md 里");
  appendFileSync(sessionTranscriptPath(TASK, S), `${"老记录正文\n".repeat(60_000)}`);
  forgetRecordSeq(TASK, S);
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

// ── ⑤ 恢复号段只认记录元数据 ─────────────────────────────────────────────────
{
  const S = "s-recover";
  const path = sessionTranscriptPath(TASK, S);
  mkdirSync(dirname(path), { recursive: true });
  const sentinel = (meta: object) => `\x1e${JSON.stringify(meta)}\n`;
  writeFileSync(path, [
    sentinel({ t: "user", agent: "codex", text: "给个示例", seq: 1, turnStartedAt: TURN, at: at(0) }),
    sentinel({ t: "agent", seq: 2, turnStartedAt: TURN, at: at(1) }),
    "```json\n{\"seq\":9007199254740992}\n{\"seq\": 500}\n```\n",
    sentinel({ t: "system", agent: "codex", text: "坏号", seq: 9007199254740993, at: at(2) }),
  ].join(""));
  const first = nextRecordSeq(TASK, S);
  const second = nextRecordSeq(TASK, S);
  assert.deepEqual([first, second], [3, 4], "正文里的 seq 示例、不安全的整数都不算：接着元数据上的最大号发");
  assert.ok(Number.isSafeInteger(first) && first !== second);

  const top = "s-top";
  writeFileSync(sessionTranscriptPath(TASK, top), sentinel({ t: "system", agent: "codex", text: "顶到上限", seq: Number.MAX_SAFE_INTEGER, at: at(0) }));
  assert.equal(nextRecordSeq(TASK, top), null, "号已经顶到安全整数上限：不发号，不在原地打转");

  const broken = "s-unreadable";
  mkdirSync(sessionTranscriptPath(TASK, broken), { recursive: true }); // .md 那个路径是个目录：读不出来
  assert.equal(nextRecordSeq(TASK, broken), null, "读不出来：不发号，不从 0 接着发");
  const out = createWriteStream(join(stage, "degraded.md"));
  assert.equal(await claimTranscript(out, { taskId: TASK, sessionId: broken, turnStartedAt: TURN }), false, "号段接不回来：这一回合不发号");
  assert.equal(writeTurn(out, { t: "system", agent: "codex", text: "x" }, at(3)), null, "这一回合的记录不带身份");
  assert.equal(liveTranscript(broken), out, "但正式流照样登记成这条会话的写者");
  // 回合中间来了旁注：从正式流写、照它的样子不带号。读故障这时恢复了也一样 —— 旁注不另开流去发号。
  const during = await appendTranscriptLine(TASK, { id: broken, role: "single" }, (stream) => writeTurn(stream, { t: "system", agent: "codex", text: "旁注", aside: true }, at(4)));
  assert.equal(during, null, "旁注从正式流写，不带号");
  rmSync(sessionTranscriptPath(TASK, broken), { recursive: true, force: true });
  const recovered = await appendTranscriptLine(TASK, { id: broken, role: "single" }, (stream) => writeTurn(stream, { t: "system", agent: "codex", text: "又一条旁注", aside: true }, at(5)));
  assert.equal(recovered, null, "读故障恢复了，这一回合里的旁注也不从半路改成带号");
  assert.equal(appendSessionTrace(TASK, broken, TURN, { kind: "tool", name: "bash", detail: "ls" }, at(6)), null, "trace 也不带号");
  await new Promise<void>((resolve) => out.end(resolve));
  assert.equal(liveTranscript(broken), null, "回合收工以后不再是写者");
  assert.deepEqual(parseSessionSpans(readFileSync(join(stage, "degraded.md"), "utf8")).map(({ seg }) => [seg.text, seg.seq ?? null]),
    [["x", null], ["旁注", null], ["又一条旁注", null]], "这一回合的记录全都写进正式流、全都不带号");
  forgetRecordSeq(TASK, broken);

  // 绑定以后领号不会失败：盘上的文件这时读不出来了、内存里的号段被清了（模拟），这一回合照样每条都带号。
  const steady = "s-steady";
  const steadyPath = sessionTranscriptPath(TASK, steady);
  const stream = createWriteStream(steadyPath, { flags: "a" });
  assert.equal(await claimTranscript(stream, { taskId: TASK, sessionId: steady, turnStartedAt: TURN }), true);
  const opening = writeProse(stream, "开头");
  await new Promise<void>((resolve) => stream.write("", () => resolve()));
  chmodSync(steadyPath, 0o200);
  forgetRecordSeq(TASK, steady);
  const note = writeTurn(stream, { t: "system", agent: "codex", text: "中途" }, at(4));
  const closing = writeProse(stream, "结尾");
  const step = appendSessionTrace(TASK, steady, TURN, { kind: "tool", name: "bash", detail: "ls" }, at(5));
  chmodSync(steadyPath, 0o600);
  await new Promise<void>((resolve) => stream.end(resolve));
  assert.deepEqual([opening?.seq, note?.seq, closing?.seq, step?.seq], [1, 2, 3, 4], "一回合写到一半不会忽然不带号");
  assert.deepEqual(step?.textAt, { seq: 3, offset: 2 }, "正文位置记的是最近写到的那段");
  forgetRecordSeq(TASK, steady);

  forgetTaskRecordSeq(TASK);
  writeFileSync(path, sentinel({ t: "user", agent: "codex", text: "删了重来", seq: 1, at: at(0) }));
  assert.equal(nextRecordSeq(TASK, S), 2, "删任务时整组丢掉：再碰这条会话从盘上重新接");
  ok("恢复号段只认 sentinel 与 trace 元数据上的安全整数；接不回来这一回合整个不带号、正式流照样是写者（旁注从它写）；绑定以后不会中途断号；删任务时整组丢掉");
}

// ── ⑥ trace 只在有正式流时带号 ───────────────────────────────────────────────
{
  const S = "s-lead-trace";
  assert.equal(appendSessionTrace(TASK, S, TURN, { kind: "tool", name: "dispatch", detail: "x" }, at(1)), null, "没有正式流：不发号");
  assert.equal(traceOf(S)[0]?.seq, undefined, "盘上那一行也不带号（团队调度台、duet 整条会话都不带）");
  ok("trace 只在这条会话有正式流时带号");
}

{
  // 执行诊断块不是会话里的话（解析时整块略过）：紧跟在一条注记后面也不会落成一段没号的正文。
  const S = "s-diag";
  const run = liveTurn(S);
  writeTurn(run.out, { t: "system", agent: "codex", text: "开始" }, at(0));
  writeRunError(run.out, "exit 1");
  run.say("诊断之后");
  await run.end();
  const prose = parseSessionSpans(readFileSync(sessionTranscriptPath(TASK, S), "utf8")).filter(({ seg }) => seg.kind === "agent");
  assert.deepEqual(prose.map(({ seg }) => [seg.text, typeof seg.seq === "number", seg.turnStartedAt]), [["诊断之后", true, TURN]], "诊断之后的正文另起一段、带号；诊断本身不成段");
  ok("带身份的回合里执行诊断块不留下没号的正文");
}

// ── ⑦ 谁是写者在锁里定 ───────────────────────────────────────────────────────
{
  const S = "s-claim";
  const path = sessionTranscriptPath(TASK, S);
  mkdirSync(dirname(path), { recursive: true });
  let open!: () => void;
  const held = withRunFileLock([path], () => new Promise<void>((resolve) => { open = resolve; }));
  const out = createWriteStream(path, { flags: "a" });
  // 回合起跑在锁后面排着（还没登记），这时来了一条旁注：它查的时候还没有正式流，也只能排在锁后面。
  const claimed = claimTranscript(out, { taskId: TASK, sessionId: S, turnStartedAt: TURN });
  const note = appendTranscriptLine(TASK, { id: S, role: "single" }, (stream) => writeTurn(stream, { t: "system", agent: "codex", text: "旁注", aside: true }, at(2)));
  while (!open) await new Promise((resolve) => setImmediate(resolve));
  open();
  await held;
  await claimed;
  const identity = await note;
  assert.equal(identity?.turnStartedAt, TURN, "拿到锁再查一次：正式流已经登记，旁注从它写、归它那一回合");
  assert.equal(liveTranscript(S), out, "正式流还是这条会话的写者");

  // 正式流收工以后来的旁注另开短命流写，写完不留登记；之后再起跑的正式流照常登记。
  await new Promise<void>((resolve) => out.end(resolve));
  const idle = await appendTranscriptLine(TASK, { id: S, role: "single" }, (stream) => writeTurn(stream, { t: "system", agent: "codex", text: "验收完成", aside: true }, at(5)));
  assert.equal(idle?.turnStartedAt, null);
  assert.equal(liveTranscript(S), null, "短命流不登记成写者");
  const next = createWriteStream(path, { flags: "a" });
  await claimTranscript(next, { taskId: TASK, sessionId: S, turnStartedAt: at(30) });
  const during = await appendTranscriptLine(TASK, { id: S, role: "single" }, (stream) => writeTurn(stream, { t: "system", agent: "codex", text: "又一条旁注", aside: true }, at(31)));
  assert.equal(during?.turnStartedAt, at(30), "新一回合的旁注照样从正式流写");
  await new Promise<void>((resolve) => next.end(resolve));
  const seqs = parseSessionSpans(readFileSync(path, "utf8")).map(({ seg }) => seg.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a! - b!), "号按落盘先后递增");
  assert.equal(new Set(seqs).size, seqs.length, "不撞号");
  ok("正式流在锁里登记；排在它后面的旁注拿到锁再查、从正式流写；短命流不顶掉登记");
}

releaseTmpDb();
rmSync(stage, { recursive: true, force: true });
console.log("test-record-identity: ok");
process.exit(0);
