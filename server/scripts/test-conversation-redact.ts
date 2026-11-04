// 删除会话消息的回归测试（conversation-redact.ts + history-reseed.ts + orchestrator 的 reseed）。
//
// 要钉住的是「删掉之后，之后的 agent 读不到它」这一整条链，不只是界面上看不见：
//   ① 解析：默认不含被删段，按原位排版的界面传 keepDeleted 拿到占位
//   ② 纯函数：指名对不上整批拒绝；抹掉正文与哨兵载荷、留住回合身份；trace 只摘被删回复那段时间
//   ③ 入口：在跑 / 团队任务 / 回合锁被占都拒；成功后 .md 与 trace 里一个字不剩、会话行挂上重建标记
//   ④ 下一轮：不再 --resume 旧 CLI 会话，换新会话、把删除后的记录当历史喂进去，标记了结；
//      再下一轮照常 --resume 新会话
// 跑:npm -w server run test:conversation-redact
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { parseSessionOutput, parseSessionSpans, segmentFingerprint } from "@ash/shared/session-output";
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
const { Hono } = await import("hono");
const { mountTaskSessionRoutes } = await import("../src/task-session-routes.js");
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
  const res = await post({ segments: [target(2), target(3), target(4)] });
  off?.();
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
  ok("删除成功：盘上抹净、广播、挂标记，下一轮判为重建");
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
