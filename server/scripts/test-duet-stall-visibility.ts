// 讨论里的停滞诊断**跨不跨得过刷新**,以及执行过程那 200 格满了之后它会不会被挤掉。
// 跑:npm -w server run test:duet-stall-visibility
//
// 起因(第 1 轮审查 F4,已实测):两档动手在讨论这条链上原先只写三处 —— 内存里那串 trace、
// 会话 trace、SSE。可讨论页首次进入和刷新都只读 `transcript.jsonl`(`readDuetTurns`),而一轮
// 发言的完整记录要等 `runTurn` 收尾才追加。于是:
//   ① 警告出现到发言结束之间刷新页面,警告就不见了,只剩「正在组织本轮观点」—— 而这段窗口按
//      定义很长(上游一直连不上才会报警),恰恰是警告档承诺的「持久可见、刷新仍在」要兑现的
//      那个场合(项目那条判据:用户刷新页面后仍能看出)。
//   ② 同一个闭环的另一半:那串 trace 有 200 格上限,到顶就**直接丢后来的**。熔断前那段时间
//      只有重试提示在刷,诊断正好排在最后 —— 一场长发言的最终记录里可能一个字都没有它。
//
// 所以服务端在警告/熔断那一刻就落盘(`duet/timeline.ts` 的 `recordTurnDiagnostic`),而 trace
// 改成「关键事件挤掉一条普通的,不挤掉自己」(`duet/turn-trace.ts`)。回放那一侧由
// `npm -w web run test:duet-timeline` 钉。
//
// 产物落临时目录(**绝不碰生产的 data/runs**),所以 env 必须在 import 那些摸盘的模块之前设好。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stage = mkdtempSync(join(tmpdir(), "ash-duet-stall-"));
process.env.ASH_DB = join(stage, "t.db");
process.env.HARNESS_DB = process.env.ASH_DB;
process.env.ASH_RUNS_DIR = join(stage, "runs");
process.env.ASH_UPLOADS_DIR = join(stage, "uploads");
// ③ 那一段驱动真 `runTurn`,所以阈值要小到秒内能走完两档。
process.env.ASH_STALL_WARN_ERRORS = "3";
process.env.ASH_STALL_WARN_MS = "0";
process.env.ASH_STALL_TRIP_MS = "120";
process.env.ASH_STALL_TRIP_GRACE_MS = "0";
process.env.ASH_STALL_POLL_MS = "20";

const { requireTmpDb } = await import("./tmp-db.js");
requireTmpDb("test-duet-stall-visibility");
const { recordTurnDiagnostic, recordTurnStart } = await import("../src/duet/timeline.js");
const { readDuetTurns } = await import("../src/duet/transcript-reads.js");
const { createTurnTrace, TRACE_CAP } = await import("../src/duet/turn-trace.js");

const TASK = "task-duet-stall";
const WARN = "上游已连续 5 次重试、4 分钟没有任何回话";
const TRIP = "已自动终止本回合并按失败结算:只收到错误事件";

// ── ① 发言还开着的时候,诊断已经在那份**讨论页真正读取的**记录里 ──────────────────
recordTurnStart({
  type: "duet.progress", taskId: TASK, round: 1, speaker: "A", phase: "start",
  startedAt: "2026-10-31T01:00:00.000Z",
});
recordTurnDiagnostic({
  type: "agent.event", taskId: TASK, sessionId: "sess-a", role: "voiceA",
  event: { kind: "error", message: WARN, level: "notice", affectsTurn: false },
});
recordTurnDiagnostic({
  type: "agent.event", taskId: TASK, sessionId: "sess-a", role: "voiceA",
  event: { kind: "error", message: TRIP },
});
// 这一轮发言**还没收尾**,整轮记录一个字都还没写 —— 正是那段会丢警告的窗口。
const mid = await readDuetTurns(TASK);
const diagnostics = mid.filter((turn) => (turn as { type?: string }).type === "agent.event");
assert.equal(diagnostics.length, 2,
  "发言进行中的停滞诊断没落进 transcript.jsonl —— 讨论页刷新只读这一份,警告档的「刷新仍在」没兑现");
const messages = diagnostics.map((turn) => (turn as { event?: { message?: string } }).event?.message);
assert.deepEqual(messages, [WARN, TRIP], "落盘那两条诊断的内容对不上");
// 形状必须跟实时 SSE 那条**一模一样**:回放才不需要第二套解释(前端交给同一个 applyDuetEvent)。
const first = diagnostics[0] as { sessionId?: string; role?: string; event?: { level?: string } };
assert.equal(first.sessionId, "sess-a", "落盘那条诊断少了会话身份,回放配不到发言上");
assert.equal(first.role, "voiceA", "落盘那条诊断少了声部,回放配不到发言上");
assert.equal(first.event?.level, "notice", "警告档落盘时丢了 notice —— 回放会把一场正常讨论标成失败");
// 顺带钉住「落盘 ≠ 只落盘」:它同时还得实时播出去,否则正在看着的人要等刷新才知道。
const raw = readFileSync(join(stage, "runs", TASK, "transcript.jsonl"), "utf8").split("\n").filter(Boolean);
assert.equal(raw.length, 3, "transcript.jsonl 里的行数不对(一条起跑 + 两条诊断)");

// ── ② 200 格满了之后,关键事件挤掉一条普通的,不挤掉自己 ───────────────────────────
// 熔断前那段时间只有重试提示在刷,诊断正好排在最后。旧版「到顶就丢后来的」会让最终记录里
// 一个字都没有它 —— 而那份记录是发言收尾后唯一留下的执行过程。
{
  const trace = createTurnTrace();
  for (let i = 0; i < TRACE_CAP + 50; i += 1) trace.push({ kind: "notice", label: "提示", detail: `重试 ${i}` });
  assert.equal(trace.events.length, TRACE_CAP, "上限没守住");
  trace.push({ kind: "notice", label: "提示", detail: WARN }, true);
  trace.push({ kind: "error", label: "执行诊断", detail: TRIP }, true);
  assert.equal(trace.events.length, TRACE_CAP, "塞关键事件时上限破了 —— 那 200 格是为了别把一轮记录撑爆");
  assert.deepEqual(trace.events.slice(-2), [
    { kind: "notice", label: "提示", detail: WARN },
    { kind: "error", label: "执行诊断", detail: TRIP },
  ], "刷满 200 格之后,熔断那两条诊断被挤掉了 —— 发言收尾后唯一留下的执行过程里一个字都没有它");
  // 反向:关键事件自己也不许被后来的关键事件挤掉(熔断那条进来时,警告那条还在)。
  for (let i = 0; i < 10; i += 1) trace.push({ kind: "error", label: "执行诊断", detail: `又一条 ${i}` }, true);
  assert.ok(trace.events.some((e) => e.detail === WARN), "关键事件被另一条关键事件挤掉了");
  assert.equal(trace.events.length, TRACE_CAP, "关键事件塞多了之后上限破了");
  // 整份都是关键事件、一条普通的都腾不出来时:上限**不许**被突破 —— 「关键」这个标记如果能
  // 把上限顶开,那 200 格的大小就由调用方有多自觉决定了。那一刻挤掉最早的那条关键事件。
  const full = createTurnTrace(2);
  full.push({ kind: "error", label: "执行诊断", detail: "第一条" }, true);
  full.push({ kind: "error", label: "执行诊断", detail: "第二条" }, true);
  full.push({ kind: "error", label: "执行诊断", detail: "第三条" }, true);
  assert.deepEqual(full.events.map((e) => e.detail), ["第二条", "第三条"],
    "腾不出普通事件时,关键事件把上限顶开了 —— 上限的大小不该由调用方有多自觉决定");
}

// ── ③ 真 `runTurn`:那两条诊断确实在发言收尾**之前**就落了盘 ──────────────────────
// 上面两段钉的是「落盘这件事本身对不对」。可 F4 的缺陷不在 `recordTurnDiagnostic`(它是这一轮
// 新写的),而在**讨论这条链压根没调它** —— 警告只写内存 trace + 会话 trace + SSE。所以这一段
// 走真消费循环:合成一个「只有重试提示、一条正文都没有」的上游,让看门狗两档都走完,然后看
// `transcript.jsonl` 的**行序** —— 它是追加写的,诊断行排在整轮记录前面就说明那一刻已经落盘。
{
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks } = await import("../src/db/schema.js");
  const { runTurn } = await import("../src/duet/turn.js");
  await ensureSchema();
  const at = "2026-10-31T01:00:00.000Z";
  const LIVE = "duet-stall-live";
  await db.insert(projects).values({ id: "p", name: "fixture", repoPath: stage, createdAt: at });
  await db.insert(tasks).values({
    id: LIVE, projectId: "p", title: LIVE, body: "fixture", mode: "duet",
    status: "running", autoTitle: false, useWorktree: false, createdAt: at, updatedAt: at,
  });
  let killed = false;
  const executor = {
    type: "codex" as const, label: "fixture",
    run: () => ({
      sessionId: "", commandLine: "fixture",
      kill: () => { killed = true; },
      events: {
        async *[Symbol.asyncIterator]() {
          // 上游一直连不上:只有重试提示,一条正文都没有 —— 两档判据要的正是这个现场。
          while (!killed) {
            yield { kind: "error", message: "Reconnecting... waiting for network", level: "notice", affectsTurn: false };
            await new Promise((done) => { setTimeout(done, 20); });
          }
          yield { kind: "done", exitStatus: 0 };
        },
      },
    }),
    resumeCommand: () => "fixture",
    resumeFields: () => ({ resumeCommand: "fixture", resumeEnv: null, resumeArgs: null }),
  };
  await runTurn({
    taskId: LIVE, role: "voiceA", speaker: "A", round: 1,
    executor: executor as never, runOwner: null, prompt: "fixture", cwd: stage,
  });
  const entries = readFileSync(join(stage, "runs", LIVE, "transcript.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const diagnosed = entries.filter((e) => e.type === "agent.event");
  const completed = entries.findIndex((e) => e.type === undefined);
  assert.ok(diagnosed.length >= 2,
    "讨论这条链熔断了,却一条诊断都没落进 transcript.jsonl —— 刷新页面只剩「正在组织本轮观点」");
  assert.ok(completed >= 0, "这一轮的整轮记录没落盘,夹具没跑完");
  for (const [index, entry] of entries.entries()) {
    if (entry.type !== "agent.event") continue;
    assert.ok(index < completed,
      "诊断行排在整轮记录后面 —— 那说明它是收尾时补写的,发言进行中刷新照样看不见");
  }
  const said = diagnosed.map((e) => (e.event as { message?: string }).message ?? "");
  assert.ok(said.some((m) => /没有任何回话|重试/.test(m)), `警告那条没落盘(落了:${JSON.stringify(said)})`);
  assert.ok(said.some((m) => /已自动终止本回合/.test(m)), `熔断那条没落盘(落了:${JSON.stringify(said)})`);
  // 整轮记录里那两条也得在(trace 的关键事件标记),否则收尾之后又看不见了。
  const record = entries[completed] as { error?: string; events?: { detail?: string }[] };
  assert.match(String(record.error ?? ""), /已自动终止本回合/, "整轮记录没把熔断记成这一轮的失败原因");
  assert.ok((record.events ?? []).some((e) => /已自动终止本回合/.test(String(e.detail ?? ""))),
    "整轮记录的执行过程里没有熔断诊断 —— 发言收尾后它是唯一留下的那份");
}

console.log("test:duet-stall-visibility ok：发言进行中的诊断即时落进讨论页读的那一份,trace 满了也挤不掉它");
