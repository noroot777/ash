// 删除会话消息的回归测试（conversation-redact.ts + history-reseed.ts + orchestrator 的 reseed）。
//
// 要钉住的是「删掉之后，之后的 agent 读不到它」这一整条链，不只是界面上看不见：
//   ① 解析：默认不含被删段，按原位排版的界面传 keepDeleted 拿到占位
//   ② 纯函数：指名对不上整批拒绝；抹掉正文与哨兵载荷、留住回合身份；trace 只摘被删回复那段时间
//   ③ 入口：在跑 / 团队任务 / 回合锁被占都拒；成功后 .md 与 trace 里一个字不剩、会话行挂上重建标记
//   ④ 下一轮：不再 --resume 旧 CLI 会话，换新会话、把删除后的记录当历史喂进去，标记了结；
//      再下一轮照常 --resume 新会话
//   ⑥ 答复按记录身份删（原文相同也不删错）；删到一半（问答历史或文件哪一步断了）重试都能
//      续上；失效标记跨接力不丢（不带原生会话文件、对端照样重建）
// 跑:npm -w server run test:conversation-redact
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { parseSessionOutput, parseSessionSpans, segmentFingerprint, traceSpanFingerprint } from "@ash/shared/session-output";
import { pairAnswerMessages, type QuestionRecord } from "@ash/shared/questions";
import { IS_WINDOWS } from "../src/platform.js";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-conversation-redact-"));
process.env.ASH_DB = join(stage, "ash.db");
requireTmpDb("test-conversation-redact");
process.env.ASH_RUNS_DIR = join(stage, "runs");
process.env.ASH_UPLOADS_DIR = join(stage, "uploads");
// PATH 上的 claude 是下面种的假货，放行 spawn 的测试隔离闸。
process.env.ASH_ALLOW_REAL_AGENT = "1";
const ok = (m: string) => console.log("   ✓ " + m);

// ── 假 claude：把 argv 和 stdin 收到的每一行记下来，回一个成功的 result ─────────────
const probes = join(stage, "probes");
mkdirSync(probes, { recursive: true });
const bin = join(stage, "bin");
mkdirSync(bin, { recursive: true });
const probeJs = join(bin, "probe.cjs");
writeFileSync(probeJs, `const fs=require("fs"),path=require("path");
const argv=process.argv.slice(2);
const pick=(flag)=>{const i=argv.indexOf(flag);return i<0?null:argv[i+1];};
const sid=pick("--resume")||pick("--session-id");
const file=path.join(process.env.ASH_TEST_PROBES,process.pid+"-"+process.hrtime.bigint()+".json");
const out={argv,stdin:[]};
let buf="";let answered=false;
process.stdin.on("data",(d)=>{buf+=d;let i;while((i=buf.indexOf("\\n"))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);
  out.stdin.push(line);fs.writeFileSync(file,JSON.stringify(out));
  if(answered)continue;answered=true;
  process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:sid})+"\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_delta",delta:{type:"text_delta",text:"收到。"}}})+"\\n");
  process.stdout.write(JSON.stringify({type:"result",subtype:"success",session_id:sid})+"\\n");}});
process.stdin.on("end",()=>process.exit(0));
setTimeout(()=>process.exit(0),10000).unref();
`);
const fakeBin = join(bin, IS_WINDOWS ? "claude.cmd" : "claude");
writeFileSync(fakeBin, IS_WINDOWS ? `@node "${probeJs}" %*\r\n` : `#!/bin/sh\nexec node "${probeJs}" "$@"\n`);
chmodSync(fakeBin, 0o755);
process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
process.env.ASH_TEST_PROBES = probes;
type Probe = { argv: string[]; stdin: string[] };
const readProbes = (): Probe[] => readdirSync(probes).filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(probes, f), "utf8")) as Probe);
const clearProbes = () => { for (const f of readdirSync(probes)) unlinkSync(join(probes, f)); };

const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, sessions, tasks } = await import("../src/db/schema.js");
const { eq } = await import("drizzle-orm");
const { bus } = await import("../src/bus.js");
const { claimNonTurn, isRunning } = await import("../src/runs.js");
const { sessionTracePath, sessionTranscriptPath, TURN_SENTINEL } = await import("../src/transcript.js");
const redact = await import("../src/conversation-redact.js");
const { pickTurnSession } = await import("../src/turn-session-pick.js");
const { continueTask } = await import("../src/orchestrator.js");
const { isHumanOnlyPath } = await import("../src/auth/personal-gate.js");
const { appendTaskTimeline } = await import("../src/task-timeline.js");
const { withRunFileLock } = await import("../src/run-file-lock.js");
const { sessionsForTask } = await import("../src/task-session-routes.js");
const { Hono } = await import("hono");
const { mountTaskSessionRoutes } = await import("../src/task-session-routes.js");
const { recordUserConversationTurn } = await import("../src/conversation-turn.js");
const { pendingMessageRow } = await import("../src/pending-messages.js");
const { deliveryOptions } = await import("../src/pending-verdict.js");
const { collectSessionFiles, handoffSessionContext } = await import("../src/handoff-collect.js");
await ensureSchema();

const line = (turn: Record<string, unknown>) => `${TURN_SENTINEL}${JSON.stringify(turn)}`;
const T = (minute: number) => `2026-11-04T01:${String(minute).padStart(2, "0")}:00.000Z`;
const WAKE = { reason: "SECRET 哨兵原因", source: "SECRET 哨兵来源", events: [] };
const TRANSCRIPT = [
  line({ t: "user", agent: "claude", text: "先做 A 方案", at: T(1) }),
  "好的，A 方案已经改完。",
  line({ t: "agentEnd", at: T(2) }),
  line({ t: "user", agent: "claude", text: "SECRET 发错的指令", at: T(3) }),
  "SECRET 跑偏的回复",
  "第二行也是 SECRET",
  line({ t: "agentEnd", at: T(5) }),
  line({ t: "user", agent: "claude", by: "system", text: "SECRET 哨兵输出", monitorWake: WAKE, at: T(6) }),
  "哨兵之后的正常回复。",
  line({ t: "agentEnd", at: T(7) }),
  "",
].join("\n");
const traceEntry = (at: string, event: Record<string, unknown>) => JSON.stringify({ at, turnStartedAt: T(0), event });
const TRACE = [
  traceEntry(T(1), { kind: "text", text: "A 方案的工具调用" }),
  traceEntry(T(4), { kind: "run", sessionId: "keep-run" }),
  traceEntry(T(4), { kind: "toolUse", name: "Bash", input: "SECRET 跑偏的命令" }),
  traceEntry(T(6), { kind: "text", text: "SECRET 收口时才落盘的正文" }),
  traceEntry(T(7), { kind: "text", text: "哨兵之后的工具调用" }),
  "",
].join("\n");

// ── ① 解析 ──────────────────────────────────────────────────────────────────
{
  const marked = [line({ t: "user", text: "", at: T(1), deleted: true }), line({ t: "agent", deleted: true }), line({ t: "agentEnd", at: T(2) }), "留下的话"].join("\n");
  assert.deepEqual(parseSessionOutput(marked).map((seg) => seg.text), ["留下的话"], "默认解析不含被删段");
  const kept = parseSessionOutput(marked, { keepDeleted: true });
  assert.deepEqual(kept.map((seg) => [seg.kind, !!seg.deleted]), [["user", true], ["agent", true], ["agent", false]], "keepDeleted 保住原位");
  assert.equal(kept[1]?.kind === "agent" && kept[1].endedAt, T(2), "被删回复照样认领自己的 agentEnd，后面的段不串位");
  ok("解析：默认滤掉被删段，keepDeleted 保住原位与回合收口");
}

// ── ② 纯函数 ────────────────────────────────────────────────────────────────
const spans = parseSessionSpans(TRANSCRIPT);
const target = (index: number) => ({ index, fingerprint: segmentFingerprint(spans[index]!.seg) });
assert.deepEqual(spans.map(({ seg }) => seg.kind), ["user", "agent", "user", "agent", "user", "agent"]);
{
  assert.throws(() => redact.redactTranscript(TRANSCRIPT, [{ index: 2, fingerprint: "user:x:1:0" }]), redact.RedactRefusal, "指纹对不上拒绝");
  assert.throws(() => redact.redactTranscript(TRANSCRIPT, [target(2), { index: 99, fingerprint: "x" }]), redact.RedactRefusal, "一条越界整批拒绝");
  const once = redact.redactTranscript(TRANSCRIPT, [target(2)]).text;
  assert.throws(() => redact.redactTranscript(once, [target(2)]), redact.RedactRefusal, "删过的不能再删");

  const { text, windows } = redact.redactTranscript(TRANSCRIPT, [target(2), target(3), target(4)]);
  assert.doesNotMatch(text, /SECRET/, "正文与哨兵载荷一个字不剩");
  assert.equal(parseSessionSpans(text).length, spans.length, "段数不变：序号与回合边界不挪");
  const wake = parseSessionOutput(text, { keepDeleted: true })[4];
  assert.ok(wake?.kind === "user" && wake.deleted && wake.bySystem && wake.at === T(6) && !wake.monitorWake, "留住回合身份，去掉哨兵载荷");
  assert.deepEqual(parseSessionOutput(text).map((seg) => seg.text), ["先做 A 方案", "好的，A 方案已经改完。", "哨兵之后的正常回复。"]);
  // 被删回复的窗口：从前面那句插话（T3）开到下一段插话（T6）—— 正文 trace 常在收口后才落盘。
  assert.deepEqual(windows, [{ after: Date.parse(T(3)), until: Date.parse(T(6)) }]);
  const trace = redact.redactTrace(TRACE, windows);
  assert.doesNotMatch(trace, /SECRET/, "trace 里被删回复那段时间的执行事件一并摘掉");
  assert.match(trace, /keep-run/, "回合身份 run 留着记账");
  assert.match(trace, /A 方案的工具调用/);
  assert.match(trace, /哨兵之后的工具调用/);
  ok("纯函数：整批校验、抹掉正文留身份、trace 按时间窗摘");
}

// ── ③ 入口 ──────────────────────────────────────────────────────────────────
const ts = new Date().toISOString();
const repo = join(stage, "repo");
mkdirSync(repo, { recursive: true });
await db.insert(projects).values({ id: "p-redact", name: "redact", repoPath: repo, createdAt: ts, updatedAt: ts });
const taskRow = (over: Record<string, unknown>) => ({
  id: "", projectId: "p-redact", title: "t", body: "任务说明：做 A 方案", mode: "single", status: "failed",
  labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "claude",
  useWorktree: false, worktreeBase: null as string | null, createdAt: ts, updatedAt: ts, ...over,
});
const OLD_CLI = "11111111-2222-4333-8444-555555555555";
async function seed(taskId: string, over: Record<string, unknown> = {}) {
  await db.insert(tasks).values(taskRow({ id: taskId, ...over }));
  const sessionId = `${taskId}-s`;
  await db.insert(sessions).values({
    id: sessionId, taskId, role: "single", agentType: "claude", executor: "claude",
    cliSessionId: OLD_CLI, startedAt: ts, turnStartedAt: ts, endedAt: ts, exitStatus: 0,
  });
  mkdirSync(dirname(sessionTranscriptPath(taskId, sessionId)), { recursive: true });
  writeFileSync(sessionTranscriptPath(taskId, sessionId), TRANSCRIPT);
  writeFileSync(sessionTracePath(taskId, sessionId), TRACE);
  return sessionId;
}
const sessionRow = async (sessionId: string) => (await db.select().from(sessions).where(eq(sessions.id, sessionId))).at(0)!;
const refusal = async (promise: Promise<unknown>, status: number, what: string) => {
  await assert.rejects(promise, (error: unknown) => error instanceof redact.RedactRefusal && error.status === status, what);
};
{
  const running = await seed("t-running", { status: "running" });
  await refusal(redact.deleteConversationSegments(running, [target(2)]), 409, "在跑的任务不能删");
  const team = await seed("t-team", { mode: "team" });
  await refusal(redact.deleteConversationSegments(team, [target(2)]), 409, "团队任务没接重建上下文，明说不支持");
  const locked = await seed("t-locked");
  const release = claimNonTurn("t-locked", "test");
  assert.ok(release);
  await refusal(redact.deleteConversationSegments(locked, [target(2)]), 409, "回合锁被占（正要起跑）不能删");
  release();
  await refusal(redact.deleteConversationSegments("nope", [target(2)]), 404, "会话不存在");
  for (const sessionId of [running, team, locked]) {
    assert.equal(readFileSync(sessionTranscriptPath(sessionId.slice(0, -2), sessionId), "utf8"), TRANSCRIPT, "拒绝时正文原样不动");
    assert.equal((await sessionRow(sessionId)).contextRebuildAt, null, "拒绝时不挂重建标记");
  }
  assert.equal(isHumanOnlyPath("/api/sessions/abc/conversation/delete"), true, "删除是真人专属：agent 不能替用户删");
  ok("入口：在跑 / 团队 / 回合锁被占 / 不存在一律拒，拒了什么都不动");
}

const taskId = "t-redact";
const sessionId = await seed(taskId);
// 同任务的另一位智能体：它可能读过 claude 的 .md（同伴会读彼此的记录），它的 CLI 上下文也得作废。
const PEER_CLI = "codex-old-thread";
await db.insert(sessions).values({
  id: `${taskId}-peer`, taskId, role: "single", agentType: "codex", executor: "codex",
  cliSessionId: PEER_CLI, startedAt: ts, turnStartedAt: ts, endedAt: ts, exitStatus: 0,
});
{
  const api = new Hono();
  mountTaskSessionRoutes(api);
  const post = async (body: unknown) => {
    const res = await api.fetch(new Request(`http://x/sessions/${sessionId}/conversation/delete`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  assert.equal((await post({ segments: [{ index: "2" }] })).status, 400, "格式不对 400");
  assert.equal((await post({ segments: [{ index: 2, fingerprint: "stale" }] })).status, 409, "正文旧了 409");
  const published: string[] = [];
  const off = bus.subscribe((event) => { if (event.type === "conversation.redacted") published.push(event.sessionId); });
  // 删除与回合之外的追加（时间线旁注）排同一把逐文件锁。先由别人占着锁，确定性地验两头都在等：
  // 旁注不会在改写读完之后才落进旧文件（被换名盖掉），改写也不会在别人写到一半时动手。
  const mdPath = sessionTranscriptPath(taskId, sessionId);
  let unlock!: () => void;
  const held = withRunFileLock([mdPath], () => new Promise<void>((resolve) => { unlock = resolve; }));
  const appending = appendTaskTimeline(taskId, "并发旁注 KEEP", { sessionId });
  const deleting = post({ segments: [target(2), target(3), target(4)] });
  await new Promise((r) => setTimeout(r, 300));
  assert.doesNotMatch(readFileSync(mdPath, "utf8"), /并发旁注 KEEP/, "锁被占着时旁注不落盘");
  assert.match(readFileSync(mdPath, "utf8"), /SECRET/, "锁被占着时改写不动手");
  unlock();
  await held;
  const [res, appended] = await Promise.all([deleting, appending]);
  off?.();
  assert.equal(appended, true);
  assert.match(readFileSync(mdPath, "utf8"), /并发旁注 KEEP/, "排在锁后的旁注没被改写吞掉");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { deleted: 3 });
  assert.deepEqual(published, [sessionId], "广播一声，打开着的页面重拉");
  assert.doesNotMatch(readFileSync(sessionTranscriptPath(taskId, sessionId), "utf8"), /SECRET/, ".md 里一个字不剩");
  assert.doesNotMatch(readFileSync(sessionTracePath(taskId, sessionId), "utf8"), /SECRET/, "trace 里一个字不剩");
  const row = await sessionRow(sessionId);
  assert.ok(row.contextRebuildAt, "会话行挂上重建标记");
  assert.equal(row.cliSessionId, OLD_CLI, "删除本身不动 CLI 会话 id（下一轮起跑时才换）");
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!;
  const pick = await pickTurnSession({ taskId, task, agent: "claude", sessionRole: "single", profileId: null, runOwner: null, slash: null });
  assert.equal(pick.prev?.id, sessionId, "续的还是同一条会话行（同一份 .md 接着写）");
  assert.equal(pick.reseed, true, "但这一轮要重建上下文");
  assert.ok((await sessionRow(`${taskId}-peer`)).contextRebuildAt, "同任务另一位智能体的会话也挂上重建标记");
  const peerPick = await pickTurnSession({ taskId, task, agent: "codex", sessionRole: "single", profileId: null, runOwner: null, slash: null });
  assert.equal(peerPick.reseed, true, "另一位智能体下一轮同样换新会话重建，不再 resume 读过原话的旧线程");
  const listed = await sessionsForTask(taskId);
  assert.ok(listed.every((row) => row.resumeCommand === null), "还没重建的会话不递出接回旧 CLI 会话的命令");
  // 要在旧上下文上跑的 CLI 命令一律不发：/fork 会把旧上下文整份复制进新分支。
  for (const name of ["fork", "review", "compact"] as const) {
    await assert.rejects(
      pickTurnSession({ taskId, task, agent: "codex", sessionRole: "single", profileId: null, runOwner: null, slash: { name, args: "", text: `/${name}` } }),
      /删过消息/, `/${name} 在重建前被拒`,
    );
  }
  const fresh = await pickTurnSession({ taskId, task, agent: "codex", sessionRole: "single", profileId: null, runOwner: null, slash: { name: "new", args: "", text: "/new" } });
  assert.equal(fresh.resuming, false, "/new 本来就不带旧上下文，照常放行");
  ok("删除成功：盘上抹净、并发旁注不丢、广播、全任务挂标记，下一轮判为重建，旧上下文上的命令被拒");
}

// ── ⑤ 答复、只剩执行过程的回合、写盘失败 ───────────────────────────────────────
{
  const extra = "t-extra";
  const extraSession = await seed(extra);
  const REPLY = "【答复】\nSECRET 发错的答复";
  const record = { id: "q1", answeredAt: T(9), question: "SECRET 用哪个方案？", answer: "SECRET 发错的答复", reply: REPLY };
  const keep = { id: "q0", answeredAt: T(0), question: "早先的问题", answer: "留着", reply: "【答复】\n留着" };
  await db.update(tasks).set({ questionHistory: JSON.stringify([keep, record]) }).where(eq(tasks.id, extra));
  const mdPath = sessionTranscriptPath(extra, extraSession);
  const tracePath = sessionTracePath(extra, extraSession);
  // 一轮答复之后回合失败：没有正文，只有执行过程。
  writeFileSync(mdPath, TRANSCRIPT + [line({ t: "user", agent: "claude", text: REPLY, at: T(9) }), ""].join("\n"));
  const failedTurn = [
    { at: T(10), turnStartedAt: T(9), event: { kind: "run", model: null, reasoningEffort: null } },
    { at: T(11), turnStartedAt: T(9), event: { kind: "tool", name: "Bash", input: "SECRET 失败回合的命令" } },
    { at: T(12), turnStartedAt: T(9), event: { kind: "error", message: "SECRET 失败" } },
  ];
  writeFileSync(tracePath, TRACE + failedTurn.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const answerIndex = parseSessionSpans(readFileSync(mdPath, "utf8")).length - 1;
  const answerTarget = { index: answerIndex, fingerprint: segmentFingerprint(parseSessionSpans(readFileSync(mdPath, "utf8"))[answerIndex]!.seg) };
  const traceTarget = { trace: { from: T(11), to: T(12), fingerprint: traceSpanFingerprint(failedTurn) } };

  await refusal(redact.deleteConversationSegments(extraSession, [{ trace: { ...traceTarget.trace, fingerprint: "trace:1:0" } }]), 409, "执行过程的指纹对不上拒绝");
  if (!IS_WINDOWS && process.getuid?.() !== 0) {
    // 写盘失败：如实报失败，正文与 trace 原样不动，问答历史也不动。
    const dir = dirname(mdPath);
    chmodSync(dir, 0o555);
    try {
      await refusal(redact.deleteConversationSegments(extraSession, [answerTarget, traceTarget]), 500, "写不进去就报失败，不报成删好了");
    } finally {
      chmodSync(dir, 0o755);
    }
    assert.match(readFileSync(mdPath, "utf8"), /SECRET 发错的答复/, "失败时正文原样");
    assert.match(readFileSync(tracePath, "utf8"), /SECRET 失败回合的命令/, "失败时 trace 原样");
    assert.equal(readdirSync(dir).filter((name) => name.endsWith(".tmp")).length, 0, "不留临时文件");
  }
  await redact.deleteConversationSegments(extraSession, [answerTarget, traceTarget]);
  assert.doesNotMatch(readFileSync(mdPath, "utf8"), /发错的答复/, "答复从正文里抹掉");
  const trace = readFileSync(tracePath, "utf8");
  assert.doesNotMatch(trace, /失败回合的命令|SECRET 失败/, "只剩执行过程的那一轮从 trace 里摘掉");
  assert.match(trace, /"kind":"run".*"turnStartedAt"|"turnStartedAt".*"kind":"run"/, "回合身份 run 留着");
  const history = JSON.parse((await db.select().from(tasks).where(eq(tasks.id, extra))).at(0)!.questionHistory!) as Array<Record<string, unknown>>;
  assert.deepEqual(history[0], keep, "别的答复不动");
  assert.equal(history[1]?.id, "q1");
  assert.equal(history[1]?.deleted, true, "被删的答复在问答历史里只留墓碑");
  assert.doesNotMatch(JSON.stringify(history), /SECRET/, "问答历史里也一个字不剩（问答卡、get_task 都读它）");
  ok("答复连问答历史一起删、只剩执行过程的回合按时间段删、写盘失败如实报且原样不动");
}

// ── ⑥ 答复的身份、删到一半续上、失效标记跨接力 ─────────────────────────────────
{
  const SAME = "【答复】\n可以";
  const first: QuestionRecord = { id: "q-first", answeredAt: T(20), question: "只在测试环境执行吗？", answer: "可以", reply: SAME };
  const second: QuestionRecord = { id: "q-second", answeredAt: T(21), question: "允许在生产环境执行吗？", answer: "可以", reply: SAME };
  const other: QuestionRecord = { id: "q-other", answeredAt: T(22), question: "别的问题", answer: "不行", reply: "【答复】\n不行" };
  // 发出答复时记录 id 就跟着原话落盘；排队的答复投递时也带着它。
  const chunks: string[] = [];
  const sink = { write: (chunk: string) => { chunks.push(chunk); return true; } } as unknown as NodeJS.WritableStream;
  recordUserConversationTurn({ taskId: "t-x", sessionId: "s-x", role: "single", agentType: "claude", out: sink, text: SAME, at: T(21), answerIds: ["q-second"] });
  const written = parseSessionOutput(chunks.join(""))[0];
  assert.deepEqual(written?.kind === "user" && written.answerIds, ["q-second"], "答复的记录 id 跟着原话落盘");
  assert.deepEqual(deliveryOptions(pendingMessageRow({ taskId: "t-x", text: SAME, answerId: "q-second" })).answerIds, ["q-second"], "排队的答复投递时带上记录 id");
  // 配对（服务端删除与问答卡同一份）：老会话同文按先后对；写着 answerIds 的只认它。
  const legacy = pairAnswerMessages([first, second], [{ key: "a", text: SAME }, { key: "b", text: SAME }]);
  assert.deepEqual([legacy.paired.get("a")?.id, legacy.paired.get("b")?.id], ["q-first", "q-second"]);
  const byId = pairAnswerMessages([first, second], [{ key: "a", text: SAME }, { key: "b", text: SAME, answerIds: ["q-first"] }]);
  assert.deepEqual([byId.paired.get("a")?.id, byId.paired.get("b")?.id], ["q-second", "q-first"], "有 answerIds 的不按原文猜");

  const answerLines = (ids?: [string[], string[]]) => [
    line({ t: "user", agent: "claude", text: SAME, at: T(20), ...(ids ? { answerIds: ids[0] } : {}) }), "只在测试环境跑。", line({ t: "agentEnd", at: T(20) }),
    line({ t: "user", agent: "claude", text: SAME, at: T(21), ...(ids ? { answerIds: ids[1] } : {}) }), "去生产环境跑。", line({ t: "agentEnd", at: T(21) }), "",
  ].join("\n");
  async function seedAnswers(id: string, md: string, history: QuestionRecord[]) {
    const sid = await seed(id);
    writeFileSync(sessionTranscriptPath(id, sid), md);
    writeFileSync(sessionTracePath(id, sid), "");
    await db.update(tasks).set({ questionHistory: JSON.stringify(history) }).where(eq(tasks.id, id));
    const now = parseSessionSpans(md);
    const at = (index: number, answerId?: string) => ({ index, fingerprint: segmentFingerprint(now[index]!.seg), ...(answerId ? { answerId } : {}) });
    return { sid, at, md: () => readFileSync(sessionTranscriptPath(id, sid), "utf8") };
  }
  const answersLeft = (md: string) => parseSessionOutput(md).filter((seg) => seg.kind === "user").length;
  const historyOf = async (id: string) => JSON.parse((await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!.questionHistory!) as QuestionRecord[];
  const state = (records: QuestionRecord[]) => records.map((record) => `${record.id}:${record.deleted ? "deleted" : record.question}`);

  // 新数据：段上写着 answerIds，删第二条只清第二条（审查实测：曾清掉第一条、留下「同意在生产环境执行」）。
  const fresh = await seedAnswers("t-same-ids", answerLines([["q-first"], ["q-second"]]), [first, second]);
  await redact.deleteConversationSegments(fresh.sid, [fresh.at(2)]);
  assert.deepEqual(state(await historyOf("t-same-ids")), ["q-first:只在测试环境执行吗？", "q-second:deleted"]);
  assert.deepEqual((await historyOf("t-same-ids"))[1]?.deletedFrom, { sessionId: fresh.sid, index: 2 }, "墓碑记着出自哪一段");
  assert.deepEqual(parseSessionOutput(fresh.md(), { keepDeleted: true })[2], { kind: "user", text: "", at: T(21), answerIds: ["q-second"], deleted: true }, "墓碑行留着答复身份");

  // 老会话（没有 answerIds）：页面指名、服务端核对；没指名又认不出就拒，不猜。
  const old = await seedAnswers("t-same-legacy", answerLines(), [first, second, other]);
  await refusal(redact.deleteConversationSegments(old.sid, [old.at(2)]), 409, "同文记录不唯一、页面没指名：拒绝而不是猜");
  await refusal(redact.deleteConversationSegments(old.sid, [old.at(2, "q-other")]), 409, "指名的记录原文对不上：拒绝");
  assert.equal(old.md(), answerLines(), "拒绝时正文不动");
  await redact.deleteConversationSegments(old.sid, [old.at(2, "q-second")]);
  assert.deepEqual(state(await historyOf("t-same-legacy")), ["q-first:只在测试环境执行吗？", "q-second:deleted", "q-other:别的问题"]);
  ok("答复按记录身份删：原文相同也只清被删的那一条，老会话按页面指名并核对");

  // 删到一半 ①：问答历史这一步失败（存储故障）—— 正文原样，修好后重试删得掉。
  const dbFault = await seedAnswers("t-fault-db", answerLines([["q-first"], ["q-second"]]), [first, second]);
  await db.update(tasks).set({ questionHistory: "{坏掉的" }).where(eq(tasks.id, "t-fault-db"));
  await refusal(redact.deleteConversationSegments(dbFault.sid, [dbFault.at(2)]), 500, "问答历史写不进去就报失败");
  assert.equal(dbFault.md(), answerLines([["q-first"], ["q-second"]]), "问答历史没清成时正文一个字都不动（删除入口还在）");
  await db.update(tasks).set({ questionHistory: JSON.stringify([first, second]) }).where(eq(tasks.id, "t-fault-db"));
  await redact.deleteConversationSegments(dbFault.sid, [dbFault.at(2)]);
  assert.equal(answersLeft(dbFault.md()), 1);
  assert.deepEqual(state(await historyOf("t-fault-db")), ["q-first:只在测试环境执行吗？", "q-second:deleted"], "重试补齐");

  if (!IS_WINDOWS && process.getuid?.() !== 0) {
    // 删到一半 ②：问答历史清成了、正文没换成 —— 那一段仍认得回这条墓碑，不会被挪给同文的
    // 另一条记录；重试（页面此时指名的就是墓碑）把正文删掉，另一条记录始终不动。
    const fileFault = await seedAnswers("t-fault-file", answerLines(), [first, second]);
    const dir = dirname(sessionTranscriptPath("t-fault-file", fileFault.sid));
    chmodSync(dir, 0o555);
    try {
      await refusal(redact.deleteConversationSegments(fileFault.sid, [fileFault.at(2, "q-second")]), 500, "文件写不进去就报失败");
    } finally {
      chmodSync(dir, 0o755);
    }
    assert.equal(fileFault.md(), answerLines(), "正文原样");
    const half = await historyOf("t-fault-file");
    assert.deepEqual(state(half), ["q-first:只在测试环境执行吗？", "q-second:deleted"]);
    const messages = parseSessionSpans(fileFault.md()).flatMap(({ seg }, index) => seg.kind === "user"
      ? [{ key: String(index), text: seg.text, source: { sessionId: fileFault.sid, index } }] : []);
    const { paired, unpaired } = pairAnswerMessages(half, messages);
    assert.deepEqual([paired.get("0")?.id, paired.get("2")?.id, unpaired.length], ["q-first", "q-second", 0], "没换成的那一段仍归墓碑，不挪给同文的另一条");
    await redact.deleteConversationSegments(fileFault.sid, [fileFault.at(2, paired.get("2")!.id)]);
    assert.equal(answersLeft(fileFault.md()), 1, "重试把正文删掉");
    assert.deepEqual(state(await historyOf("t-fault-file")), ["q-first:只在测试环境执行吗？", "q-second:deleted"], "另一条记录始终不动");
  }
  ok("删到一半：问答历史或文件哪一步断了，重试都能续上，不会删错、也不会卡在「内容已变化」");

  // 失效标记跨接力：删过消息的会话不搬原生会话文件、不认旧 id，标记原样带到对端。
  const handoffSession = await seed("t-handoff");
  await redact.deleteConversationSegments(handoffSession, [target(2)]);
  const staleRow = await sessionRow(handoffSession);
  assert.ok(staleRow.contextRebuildAt && staleRow.cliSessionId === OLD_CLI);
  const collected = await collectSessionFiles([staleRow], repo, false);
  assert.equal(collected.found.size + collected.files.length, 0, "删过消息的会话不随任务搬原生会话文件（里面还记着原话）");
  assert.match(collected.notes.join("\n"), /删过消息/, "导出说明里讲清楚");
  assert.deepEqual(handoffSessionContext(staleRow, true), { cliSessionId: null, contextRebuildAt: staleRow.contextRebuildAt }, "即便文件到了也不认旧 id，标记跟着走");
  assert.deepEqual(handoffSessionContext({ cliSessionId: OLD_CLI, contextRebuildAt: null }, true), { cliSessionId: OLD_CLI }, "没删过的照旧");
  // 对端落库的样子：cliSessionId 空、标记在。下一轮照样续这一行、拿删除后的记录重建，CLI 命令照样拒。
  await db.update(sessions).set({ cliSessionId: null }).where(eq(sessions.id, handoffSession));
  const handoffTask = (await db.select().from(tasks).where(eq(tasks.id, "t-handoff"))).at(0)!;
  const imported = await pickTurnSession({ taskId: "t-handoff", task: handoffTask, agent: "claude", sessionRole: "single", profileId: null, runOwner: null, slash: null });
  assert.deepEqual([imported.prev?.id, imported.resuming, imported.reseed], [handoffSession, true, true], "id 被置空的失效会话照样续这一行并重建");
  await assert.rejects(
    pickTurnSession({ taskId: "t-handoff", task: handoffTask, agent: "claude", sessionRole: "single", profileId: null, runOwner: null, slash: { name: "fork", args: "", text: "/fork" } }),
    /删过消息/, "id 置空也照样拒旧上下文上的命令",
  );
  ok("失效标记跨接力不丢：不搬原生会话文件、导入不认旧 id，对端下一轮照样重建");
}

// ── ④ 下一轮：换新 CLI 会话并喂重建的历史；再下一轮照常 resume ─────────────────
const settled = async () => {
  const row = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!;
  return row.status !== "running" && row.status !== "queued" && !isRunning(taskId);
};
async function until(what: string, okNow: () => boolean | Promise<boolean>, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!(await okNow())) {
    if (Date.now() > deadline) throw new Error(`等不到:${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
async function turn(text: string): Promise<Probe> {
  clearProbes();
  assert.equal(await continueTask(taskId, text), true, "这一轮要被接管");
  await until("假 claude 收到消息", () => readProbes().some((probe) => probe.stdin.length > 0));
  await until("回合结算", settled);
  return readProbes()[0]!;
}
let newCli = "";
try {
  const first = await turn("改用 B 方案");
  assert.ok(!first.argv.includes("--resume"), `删过消息的下一轮不能再 --resume 旧会话：${first.argv.join(" ")}`);
  const sid = first.argv[first.argv.indexOf("--session-id") + 1];
  assert.ok(sid && sid !== OLD_CLI, "换一条新的 CLI 会话");
  const prompt = first.stdin.join("\n");
  assert.match(prompt, /上下文已重建/);
  assert.match(prompt, /任务说明：做 A 方案/, "带上任务说明");
  assert.match(prompt, /好的，A 方案已经改完。/, "带上删除后留下的对话");
  assert.match(prompt, /哨兵之后的正常回复。/);
  assert.match(prompt, /改用 B 方案/, "这一轮的新消息在里面");
  assert.doesNotMatch(prompt, /SECRET/, "被删的内容一个字都不进新会话");
  const row = await sessionRow(sessionId);
  assert.equal(row.contextRebuildAt, null, "重建过一次，标记了结");
  assert.equal(row.cliSessionId, sid, "会话行换上新的 CLI 会话 id");
  newCli = sid!;
  ok("下一轮：不 resume 旧会话，新会话带着删除后的记录起跑");

  const second = await turn("继续");
  assert.equal(second.argv[second.argv.indexOf("--resume") + 1], newCli, "再下一轮照常 resume 新会话");
  assert.doesNotMatch(second.stdin.join("\n"), /上下文已重建/, "只重建一次");
  ok("再下一轮：照常 resume，不再重建");
} finally {
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
console.log("test-conversation-redact ok");
process.exit(0);
