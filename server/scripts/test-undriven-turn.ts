// 「回合起来了,输入却从未送到」—— 这一类现场的三道闸。
// 跑:npm -w server run test:undriven-turn
//
// 起因(2026-11-02,任务 WfLfTjaGzcA8 会话 GfmgWfE9zosC,现场只读取证):
//   · 23:31:20.333Z 旧服务端唤醒这一轮,把哨兵消息 qHTNS7UJ41M3 标成 `sent`,spawn codex
//     app-server;23:31:21.209Z codex 回完 `resumeThread` 之后 agent-out 再没有一行;
//   · 23:31:24Z 用户重启 :4317 —— 旧服务端正好死在「恢复线程」与「送出回合输入」之间,
//     **这一轮的输入从未写进 codex 的 stdin**;
//   · 23:31:25.976Z 新服务端按 pid 把那个进程接管回来(日志:「接管仍在运行的 agent …
//     从字节 0 继续」),从此等一个永远不会来的输出;
//   · 接下来 1.5 小时零输出、零报错,看门狗一拍都没动,界面只显示「当前回合仍在进行」。
//
// 三道闸各钉一组,一组红了就能指出是哪一道:
//   ① 接管不许只凭「进程活着」—— 协议日志里没有回合开始凭据就当场结算,不许无限等(§1/§2)
//   ② 投递标记与真实送达分离 —— agent 没点头就不许落终态 `sent`(§3/§4,真实 CLI 路径)
//   ③ 看门狗静默档 —— 「回合开始后 N 分钟一条进展都没有」要报警并熔断(§5)
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const root = mkdtempSync(join(tmpdir(), "ash-undriven-turn-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
// 设了 ASH_RUNS_DIR 会触发 guardAgentSpawn 的测试隔离闸;本文件跑的是自己装在 PATH 上的
// 假 codex,显式放行(executors/spawn.ts)。
process.env.ASH_ALLOW_REAL_AGENT = "1";
process.env.ASH_LAX_DONE = "1"; // 这里验的是投递与接管,不是严格 done 协议
// 「拿不到回执」那一档等多久 —— 压到几秒,免得 §4 要等满默认的一分钟。**不能压到几百毫秒**:
// detached 的「连接关闭」是按 rc 文件轮询发现的(约 400ms 一拍),压过去 §4a 就会读成
// `unknown` 而不是 `refused` —— 红的是夹具而不是判据。有界等待本身在 §3 里单独钉。
process.env.ASH_TURN_INPUT_ACK_MS = "5000";
const originalPath = process.env.PATH;

const { installFakeCodexAppServer, codexMode } = await import("./undriven-turn-fixture.js");
const fakeBin = installFakeCodexAppServer(root);
process.env.PATH = `${fakeBin}${delimiter}${originalPath ?? ""}`;

const { db, ensureSchema } = await import("../src/db/index.js");
const schema = await import("../src/db/schema.js");
const { openCodexAppServer } = await import("../src/executors/codex-app-server.js");
const { CodexExecutor } = await import("../src/executors/codex.js");
const { awaitTurnInput } = await import("../src/turn-input-acceptance.js");
const { deliverPendingMessages, pendingMessageRow } = await import("../src/pending-messages.js");
const { pidRunStillAlive } = await import("../src/executors/spawn.js");
const { isRunning } = await import("../src/runs.js");
const { configure, spy, sleep, notice } = await import("./stall-fixtures.js");
const { trackTurnStall, watchTurnSilence, clearTurnStall } = await import("../src/turn-stall.js");
const { eq } = await import("drizzle-orm");

const { projects, scheduledMessages, sessions, tasks } = schema;
await ensureSchema();

let failures = 0;
const ok = (line: string) => console.log(`   ✓ ${line}`);
const fail = (line: string) => { failures += 1; console.error(`   ✗ ${line}`); };
const check = (cond: boolean, line: string) => (cond ? ok(line) : fail(line));
const strays = new Set<ChildProcess>();

// ── 接管用的假 app-server:照常应答 initialize / thread/resume,然后**再不主动说话** ────
// 这正是旧服务端死在「恢复线程 → 送出回合输入」空当时留下的现场。
const idleAppServer = (): ChildProcess => {
  const child = spawn(process.execPath, [join(fakeBin, "idle-app-server.mjs")], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  strays.add(child);
  return child;
};

console.log("① 接管·协议日志里没有回合开始凭据 → 当场结算,不许无限等");
{
  const child = idleAppServer();
  const handle = openCodexAppServer({
    bin: "codex", args: [], cwd: root, prompt: "",
    sessionId: "th-undriven",
    // `readCodexAppServerState` 在那份日志上读出来的就是这个形状:线程认得出来、回合没有。
    reattach: { threadId: "th-undriven", turnId: "" },
    startProcess: () => child,
  });
  const kinds: string[] = [];
  let exitStatus: number | null = null;
  let diagnosis = "";
  const consume = (async () => {
    for await (const event of handle.events) {
      kinds.push(event.kind);
      if (event.kind === "error") diagnosis += `${event.message}\n`;
      if (event.kind === "done") exitStatus = event.exitStatus;
    }
  })();
  await Promise.race([consume, sleep(8_000)]);
  check(kinds.includes("done"), "这一轮结算了(旧代码在这里零事件、无限等)");
  check(exitStatus !== 0 && exitStatus !== null, `按失败结算(exitStatus=${exitStatus})`);
  check(/回合已开始/.test(diagnosis) && /输入/.test(diagnosis),
    "红字诊断说清了「线程已恢复、回合从未启动、输入一个字都没到 agent」");
  check(/重新投递|重试/.test(diagnosis), "诊断里给了出路(等重投 / 直接重试)");
  // 闲置进程不许留着:接管那一刻它就是我们的责任(`closeProcess` 1 秒后硬收)。
  const pid = child.pid!;
  const alive = () => pidRunStillAlive(pid, null) !== "gone";
  for (let i = 0; i < 80 && alive(); i += 1) await sleep(100);
  check(!alive(), "那个闲置的 app-server 进程被收掉了,没留成孤儿");
}

console.log("② 接管·有回合开始凭据 → 一个字都不动(不许误杀正在飞的回合)");
{
  const child = idleAppServer();
  const handle = openCodexAppServer({
    bin: "codex", args: [], cwd: root, prompt: "",
    sessionId: "th-driven",
    reattach: { threadId: "th-driven", turnId: "turn-in-flight" },
    startProcess: () => child,
  });
  const kinds: string[] = [];
  const consume = (async () => { for await (const event of handle.events) kinds.push(event.kind); })();
  await Promise.race([consume, sleep(1_500)]);
  // `session` 是接管时报一遍会话身份,它不算产出(也正是静默档为什么还认「零进展」)。
  check(!kinds.includes("done") && !kinds.includes("error"),
    `回合还在飞,接管之后照旧等它自己收尾(收到:${kinds.join(",") || "无"})`);
  handle.kill();
  await Promise.race([consume, sleep(3_000)]);
}

console.log("③ 输入回执三态(turn-input-acceptance.ts)");
{
  assert.equal(await awaitTurnInput({}), "accepted");
  ok("没有这条缝的执行器当场 accepted(claude 与目录里那十家,零额外延迟)");
  assert.equal(await awaitTurnInput({ inputAccepted: Promise.resolve("turn-1") }), "accepted");
  ok("协议层面收下了 → accepted");
  assert.equal(await awaitTurnInput({ inputAccepted: Promise.reject(new Error("连接已关闭")) }), "refused");
  ok("一个字都没进去 → refused");
  process.env.ASH_TURN_INPUT_ACK_MS = "400"; // 阈值每次现读,所以这一段能单独换口径
  const started = Date.now();
  assert.equal(await awaitTurnInput({ inputAccepted: new Promise(() => {}) }), "unknown");
  assert.ok(Date.now() - started >= 300, `有界等待该真的等到期限(配的是 400ms,实测 ${Date.now() - started}ms)`);
  process.env.ASH_TURN_INPUT_ACK_MS = "5000";
  ok("一直不落定 → unknown(有界等待,不许挂死调用方)");
}

console.log("④ agent 没点头就不许落终态 sent(真实 CLI 路径:PATH 上的假 codex)");
await db.insert(projects).values({
  id: "p-undriven", name: "undriven", repoPath: root, createdAt: new Date().toISOString(),
} as never);

const readRow = async (id: string) =>
  (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, id))).at(0)!;

/**
 * 真走一遍投递链路,返回那一轮跑完之后库里那一行。
 *
 * 等待写成两段是必须的:`deliverPendingMessages` 把真正的投递交给 `whenTurnIdle` 之后当场
 * 返回(fire-and-forget,见 pending-messages.ts 单任务那一支),所以「它返回了」证明不了
 * 「CLI 起过」。先等会话行出现(= 真的 spawn 过),再等这一轮退干净,然后才读账。
 */
async function deliverOnce(taskId: string, mode: "refuse" | "accept"): Promise<typeof scheduledMessages.$inferSelect> {
  codexMode(fakeBin, mode);
  mkdirSync(join(root, "runs", taskId), { recursive: true });
  await db.insert(tasks).values({
    id: taskId, projectId: "p-undriven", title: taskId, body: "验证投递记账",
    mode: "single", status: "paused", agentType: "codex", createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), useWorktree: false,
  } as never);
  const row = pendingMessageRow({ taskId, text: "继续:把剩下那一半做完", mode: "queued" });
  await db.insert(scheduledMessages).values(row as never);
  await deliverPendingMessages(taskId);
  const spawned = async () =>
    (await db.select().from(sessions).where(eq(sessions.taskId, taskId))).length > 0;
  for (let i = 0; i < 400 && !(await spawned()); i += 1) await sleep(50);
  assert.ok(await spawned(), `前提:${taskId} 真的起过一次 CLI(否则下面的断言是假绿)`);
  for (let i = 0; i < 400 && isRunning(taskId); i += 1) await sleep(50);
  // accept 那一支 `markSent` 排在消费循环之前,所以这一刻一定已经写了;refuse 那一支永远
  // 不会写(重投也还是同一个假 CLI),所以直接读就是终局。
  const after = await readRow(row.id);
  // 挡回那条路会自排重投(pending-redelivery.ts);断言完就把行收掉,免得它在后面几段里
  // 又起一轮真 CLI。
  await db.delete(scheduledMessages).where(eq(scheduledMessages.id, row.id));
  return after;
}

{
  const refused = await deliverOnce("undriven-refused", "refuse");
  check(refused.status === "pending", `输入没能送进 agent,行留在待发送(status=${refused.status})`);
  check(!refused.sentAt, "没有写 sentAt —— 这是「承诺的重投」不丢的那一半");
  const accepted = await deliverOnce("undriven-accepted", "accept");
  check(accepted.status === "sent", `agent 收下了,照旧落 sent(status=${accepted.status})`);
  check(!!accepted.sentAt, "sentAt 写了");
  // 两段都确实起过真 CLI(否则 ④a 会因为「压根没 spawn」而假绿)。
  const rows = await db.select().from(sessions);
  check(rows.length >= 2, `两段各真的开了一条会话(${rows.length} 条)`);
}

console.log("⑤ 看门狗静默档:回合开始后一条进展都没有");
// 回合起点必须是**真的过去**:静默档按 `Date.now() - 回合起点` 算欠的时间,写一个固定字面量
// 就会随日历漂成未来值,`Math.max(0, …)` 把 elapsed 夹成 0 —— 那几段会一声不响地假绿。
const turnAgo = (ms: number) => new Date(Date.now() - ms).toISOString();
{
  // 口径压到毫秒级,时间档靠共享计时器走(最后一条事件之后再也不会有事件,这一档只能靠它)。
  // 阈值与 sleep 都要绕开 `arm()` 的 200ms 轮询下限(turn-stall.ts 的 pollMs):时间档只能
  // 靠那个共享计时器走,压到比一拍还短就只是在测夹具自己。
  configure({ silentWarnMs: 100, silentTripMs: 1_200, pollMs: 200 });
  const { actions, log } = spy();
  const owner = {};
  // 起点取**回合真实起点**,所以「挂得晚」不打折 —— 接管回来的会话正是这一种。
  watchTurnSilence("s-silent", owner, turnAgo(50), actions);
  await sleep(500);
  check(log.warns.length === 1, `静默到警告阈值就报了一次(${log.warns.length} 次)`);
  check(/回合无输出/.test(log.warns[0]?.text ?? ""), "措辞是「回合无输出」,不是「上游停滞」那一套");
  check(log.projects.length > 0, "持久投影也做了(刷新后仍看得出来)");
  check(log.trips.length === 0, "警告档触发时还不该熔断(两档分开)");
  await sleep(1_200);
  check(log.trips.length === 1, `到熔断阈值自动终止本回合(${log.trips.length} 次)`);
  check(/已自动终止本回合/.test(log.trips[0] ?? ""), "熔断诊断如实说「已终止并按失败结算」");
  clearTurnStall("s-silent", owner);
}
{
  // 一条进展就摘掉它:正常回合一档都不许触发。
  configure({ silentWarnMs: 100, silentTripMs: 300, pollMs: 200 });
  const { actions, log } = spy();
  const owner = {};
  const progressTurn = turnAgo(50);
  watchTurnSilence("s-progress", owner, progressTurn, actions);
  trackTurnStall("s-progress", owner, progressTurn, { kind: "tool", name: "exec", detail: "pytest -q" }, actions);
  await sleep(700);
  check(log.warns.length === 0 && log.trips.length === 0,
    "开场就是一条跑半小时的命令 —— 工具调用本身就是进展,一档都没触发");
  // 摘掉之后这一轮不该被重新盯上(消费链不会再挂,事件也开不了静默档)。
  watchTurnSilence("s-progress", owner, progressTurn, actions);
  await sleep(700);
  check(log.warns.length === 0 && log.trips.length === 0, "有过进展的回合不会被静默档重新盯上");
}
{
  // 接管时唯一会出现的那种事件(`session` 报一遍会话身份)**不算进展** —— 事故现场就只有它。
  configure({ silentWarnMs: 100, silentTripMs: 60_000, pollMs: 200 });
  const { actions, log } = spy();
  const owner = {};
  const sessionTurn = turnAgo(50);
  watchTurnSilence("s-session", owner, sessionTurn, actions);
  trackTurnStall("s-session", owner, sessionTurn, { kind: "session", cliSessionId: "th-undriven" }, actions);
  await sleep(500);
  check(log.warns.length === 1, "只报了一遍会话身份,静默档照样该报警");
  clearTurnStall("s-session", owner);
}
{
  // 期间来了错误事件 → 前提被推翻,换成错误档那一份,**不许沿用静默档的起点提早熔断**。
  configure({ silentWarnMs: 60_000, silentTripMs: 60_000, warnErrors: 1, tripMs: 900, pollMs: 200 });
  const { actions, log } = spy();
  const owner = {};
  const late = turnAgo(5_000);
  watchTurnSilence("s-switch", owner, late, actions);
  trackTurnStall("s-switch", owner, late, notice(), actions);
  check(log.warns.length === 1 && /上游停滞/.test(log.warns[0]!.text),
    "换成错误档的措辞(它手上有重试统计可说)");
  await sleep(500);
  check(log.trips.length === 0,
    "起点跟着换回「第一条错误到达时」—— 没有把回合已经跑掉的 5 秒算进熔断钟");
  await sleep(700);
  check(log.trips.length === 1, "到错误档自己的阈值才熔断");
  clearTurnStall("s-switch", owner);
}

for (const child of strays) { try { child.kill("SIGKILL"); } catch { /* 已经没了 */ } }
if (originalPath === undefined) delete process.env.PATH;
else process.env.PATH = originalPath;

if (failures) {
  console.error(`\n✗ ${failures} 项未通过`);
  process.exit(1);
}
console.log("\n✓ 全部通过");
process.exit(0);
