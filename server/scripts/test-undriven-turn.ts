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
  assert.equal(await awaitTurnInput({ inputAccepted: Promise.resolve("accepted") }), "accepted");
  ok("协议层面收下了 → accepted");
  assert.equal(await awaitTurnInput({ inputAccepted: Promise.resolve("refused") }), "refused");
  ok("确证一个字都没进去 → refused");
  assert.equal(await awaitTurnInput({ inputAccepted: Promise.resolve("unknown") }), "unknown");
  ok("说不上来 → unknown(断链落在「输入已写出、应答没回来」之后,F4)");
  // 回执自己抛了 = 适配器炸了,**不是**「没送达」:这一层不许替它下 refused 的结论(F4)。
  assert.equal(await awaitTurnInput({ inputAccepted: Promise.reject(new Error("适配器自己炸了")) }), "unknown");
  ok("回执抛了 → unknown,不冒充 refused");
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

console.log("⑥ 接管·这一轮在别的进程里已经有过进展 → 静默档压根不该开(第 1 轮自由审查 F1)");
{
  const { ensureTurnProgressDir, noteTurnProgress, turnProgress, __resetTurnProgressMarks } =
    await import("../src/turn-progress-mark.js");
  __resetTurnProgressMarks();
  // 这一档刻意只在「确证没有过进展」时开:接管回来的新句柄看不到 agentOffset 之前那一段,
  // 光凭内存里那张 WeakMap 判,等于把「跑着 sleep 3600 的健康回合」和「输入压根没送到」
  // 当成同一件事 —— 审查实测到的就是这个误杀(重启前 offset=454、trace 里有 exec sleep 3600,
  // 接管后新进程写「一条输出都没有过」并终止了它)。
  const turn = new Date(Date.now() - 90 * 60_000).toISOString(); // 欠了 90 分钟,远超 45 分钟熔断线
  ensureTurnProgressDir("t-progress");
  check(turnProgress("t-progress", "s-progress-mark", turn) === "none",
    "目录建好、记号没写 → 确证这一轮没有过进展");

  // ⑥a 记号在(上一个进程见过进展)→ 不开档,一拍都不许动
  configure({ silentWarnMs: 100, silentTripMs: 400, pollMs: 200 });
  noteTurnProgress("t-progress", "s-progress-mark", turn);
  check(turnProgress("t-progress", "s-progress-mark", turn) === "seen", "记号落盘了,读回来是 seen");
  const seenSpy = spy("t-progress");
  watchTurnSilence("s-progress-mark", {}, turn, seenSpy.actions, "seen");
  await sleep(700);
  check(seenSpy.log.warns.length === 0 && seenSpy.log.trips.length === 0,
    "本轮已有进展 → 静默档不开,正在跑长工具的健康回合不会被误杀");

  // ⑥b 读不出来 → 同样不开(宁可漏判,不可拿一个核实不了的前提去杀)
  const blindSpy = spy("t-missing");
  watchTurnSilence("s-blind", {}, turn, blindSpy.actions, "unreadable");
  await sleep(700);
  check(blindSpy.log.warns.length === 0 && blindSpy.log.trips.length === 0,
    "有无进展核实不了 → 静默档不开");

  // ⑥c 确证没有过 → 照旧开(别把这一档修没了)
  const noneSpy = spy("t-none");
  watchTurnSilence("s-none", {}, turn, noneSpy.actions, "none");
  await sleep(700);
  check(noneSpy.log.warns.length === 1 && noneSpy.log.trips.length === 1,
    "确证零进展 → 警告加熔断照旧(这一档没被修没)");
  clearTurnStall("s-none", {});

  // ⑥d 消费链真的把「第一条进展事件」落到盘上了吗 —— 判据侧的那一半
  __resetTurnProgressMarks();
  const liveTurn = new Date().toISOString();
  const owner = {};
  const noted: string[] = [];
  const probe = spy("t-note");
  trackTurnStall("s-note", owner, liveTurn, { kind: "tool", name: "bash", input: "sleep 3600" } as never,
    { ...probe.actions, noteProgress: () => noted.push("first") });
  trackTurnStall("s-note", owner, liveTurn, { kind: "text", text: "干活了" } as never,
    { ...probe.actions, noteProgress: () => noted.push("again") });
  check(noted.join(",") === "first", `只在本轮第一条进展事件上落一次盘(实际:${noted.join(",") || "一次都没有"})`);
}

console.log("⑦ 换档不许丢掉已经发出去的红环(第 1 轮自由审查 F6)");
{
  // 静默档报警 → 投影出红环 → 来一条错误事件换成错误档 → 在错误档阈值之前恢复输出。
  // 旧代码:新记录 warned=false,close 直接返回,旧 since 对应的红环永久亮着(刷新还在)。
  configure({ warnErrors: 5, warnMs: 300_000, tripMs: 300_000, silentWarnMs: 100, silentTripMs: 600_000, pollMs: 200 });
  const { log, actions } = spy("t-swap");
  const owner = {};
  const turn = new Date(Date.now() - 60_000).toISOString();
  watchTurnSilence("s-swap", owner, turn, actions, "none");
  await sleep(500);
  check(log.warns.length === 1 && log.projects.length === 1, "静默档报了警并把红环投影出去");
  const projectedSince = log.projects[0]!.since;
  check(projectedSince === turn, "红环的身份是回合真实起点(静默档的 since)");

  trackTurnStall("s-swap", owner, turn, notice(), actions);
  check(log.trips.length === 0, "一条重试提示还不到错误档阈值,没熔断");
  trackTurnStall("s-swap", owner, turn, { kind: "text", text: "模型又说话了" } as never, actions);
  check(log.resolves.length === 1, "恢复输出后红环被撤掉了(旧代码:一次都不撤)");
  check(log.resolveSince[0] === projectedSince,
    `撤的是**置上它的那一刻**,CAS 才匹配得上(撤的=${log.resolveSince[0]}, 置的=${projectedSince})`);
  clearTurnStall("s-swap", owner);
}

console.log("⑧ 熔断之后迟到的错误事件不许把终止义务清零(第 1 轮自由审查 N2)");
{
  configure({ warnErrors: 1, warnMs: 0, tripMs: 0, silentWarnMs: 100, silentTripMs: 300, pollMs: 200 });
  const { log, actions } = spy("t-late");
  const owner = {};
  const turn = new Date(Date.now() - 60_000).toISOString();
  watchTurnSilence("s-late", owner, turn, actions, "none");
  for (let i = 0; i < 20 && log.trips.length === 0; i += 1) await sleep(100);
  check(log.trips.length === 1, "静默档熔断了这一轮");
  // 迟到的错误事件:旧代码在这里 openStall,把 trippedAtMs/escalated 一起清零 —— 同一轮
  // 会被重新警告、重新判决一遍。终止义务只有两个出口,换档不是其中之一。
  trackTurnStall("s-late", owner, turn, notice(), actions);
  await sleep(600);
  check(log.trips.length === 1, `熔断只宣布一次(实际 ${log.trips.length} 次)`);
  clearTurnStall("s-late", owner);
}

console.log("⑨ 恢复读取器:普通 turn/start 应答也是凭据,读不出来另算(第 1 轮自由审查 F5)");
{
  const { readCodexAppServerState } = await import("../src/executors/codex-app-server-state.js");
  const logPath = join(root, "proto-reply-only.jsonl");
  // **只有应答、没有 turn/started 通知**:真实现场是通知还没落盘(或那一行损坏)时重启。
  // 旧读取器只认通知,于是 turnId=null,新接管闸当场杀掉一个已经被 agent 收下的回合。
  writeFileSync(logPath, [
    JSON.stringify({ id: 1, result: {} }),
    JSON.stringify({ id: 2, result: { thread: { id: "th-reply" } } }),
    JSON.stringify({ id: 3, result: { turn: { id: "turn-acked" } } }),
  ].join("\n"));
  const replied = readCodexAppServerState(logPath, "th-reply");
  check(replied.turnId === "turn-acked" && replied.evidence === "started",
    `普通启动应答被当成凭据(turnId=${replied.turnId}, evidence=${replied.evidence})`);

  const neverPath = join(root, "proto-never.jsonl");
  // 事故现场那一份:线程恢复了,回合从未启动。
  writeFileSync(neverPath, [
    JSON.stringify({ id: 1, result: {} }),
    JSON.stringify({ id: 2, result: { thread: { id: "th-never" } } }),
    JSON.stringify({ method: "thread/unarchived", params: { threadId: "th-never" } }),
  ].join("\n"));
  const never = readCodexAppServerState(neverPath, "th-never");
  check(never.turnId === null && never.evidence === "never-started",
    `读得动、确证没有凭据 → never-started(evidence=${never.evidence})`);

  const missing = readCodexAppServerState(join(root, "proto-does-not-exist.jsonl"), "th-gone");
  check(missing.evidence === "unreadable",
    `日志读不出来 → unreadable,不许跟「从未启动」混成一档(evidence=${missing.evidence})`);
}

console.log("⑩ 接管·日志读不出来 → 不按失败结算(交给静默档兜,F5「失败面」那一条)");
{
  const child = idleAppServer();
  const handle = openCodexAppServer({
    bin: "codex", args: [], cwd: root, prompt: "",
    sessionId: "th-unverifiable",
    reattach: { threadId: "th-unverifiable", turnId: "", evidence: "unreadable" },
    startProcess: () => child,
  });
  const kinds: string[] = [];
  const consume = (async () => { for await (const event of handle.events) kinds.push(event.kind); })();
  await Promise.race([consume, sleep(1_500)]);
  check(!kinds.includes("done") && !kinds.includes("error"),
    `核实不了就不杀它(收到:${kinds.join(",") || "无"}) —— 一次磁盘故障不该被诊断成「输入一个字都没到」`);
  handle.kill();
  await Promise.race([consume, sleep(3_000)]);
}

console.log("⑪ 拿不到回执时不许落终态 sent,也不许退回重投(真实 CLI 路径,F3)");
{
  // 垫片把握手答完、收下 `turn/start` 之后**一声不吭也不断线** —— 这就是审查实测到的那个
  // 现场:ash 等不到「agent 收下了」。旧代码把 unknown 提升成 `sent`(终态),而补发扫描只看
  // `pending`,那句话从此永久消失;看门狗后来能终止坏回合,却不会把 sent 变回 pending。
  const taskId = "t-stall-ack";
  codexMode(fakeBin, "stall");
  mkdirSync(join(root, "runs", taskId), { recursive: true });
  await db.insert(tasks).values({
    id: taskId, projectId: "p-undriven", title: taskId, body: "验证在途记账",
    mode: "single", status: "paused", agentType: "codex", createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), useWorktree: false,
  } as never);
  const row = pendingMessageRow({ taskId, text: "继续:这一条的回执永远等不到", mode: "queued" });
  await db.insert(scheduledMessages).values(row as never);
  await deliverPendingMessages(taskId);
  const session = async () =>
    (await db.select().from(sessions).where(eq(sessions.taskId, taskId))).at(0);
  for (let i = 0; i < 400 && !(await session()); i += 1) await sleep(50);
  assert.ok(await session(), `前提:${taskId} 真的起过一次 CLI`);
  // 有界等待是 5 秒(本文件开头配的),等它到期再加余量。
  for (let i = 0; i < 160; i += 1) {
    const current = await readRow(row.id);
    if (current.status !== "pending" || current.sentAt) break;
    await sleep(100);
    if (i > 70) break;
  }
  const after = await readRow(row.id);
  check(after.status === "pending", `说不上来 → 行留在 pending(实际 status=${after.status})`);
  check(!after.sentAt, "没有写 sentAt —— 证据超时不许被提升成「送达」这个成功事实");
  check(!!after.deliveringSince,
    `租约留着 = 在途:既不写 sent 也不归还重投(deliveringSince=${after.deliveringSince ?? "空"})`);

  // 清场:这个 CLI 不会自己退出,留着会让后面的段落和整条测试都挂在它身上。
  const pid = (await session())?.agentPid;
  if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* 已经没了 */ } }
  for (let i = 0; i < 100 && isRunning(taskId); i += 1) await sleep(50);
  await db.delete(scheduledMessages).where(eq(scheduledMessages.id, row.id));
}

console.log("⑫ 协议层拒收 → 续跑交代必须归还,不许凭本地回合行补写送达(F2)");
{
  // 审查实测到的那条路:垫片在 initialize 就退出,回合输入一个字都没出去,日志先打印
  // 「输入没能送进 agent」,紧接着却打印「原文已送达（租约之后有回合开起来过），补记这一笔
  // 确认」—— 越线记号在、会话行也在,事后对账于是判成 delivered,一段本该继续执行的交代
  // 就这么没了(任务上 resumePrompt=null,凭证 status=sent)。
  const taskId = "t-checkpoint-refuse";
  const resumePrompt = "继续:这段交代必须活过一次拒收";
  codexMode(fakeBin, "refuse");
  mkdirSync(join(root, "runs", taskId), { recursive: true });
  await db.insert(tasks).values({
    id: taskId, projectId: "p-undriven", title: taskId, body: "验证拒收后交代归还",
    mode: "single", status: "paused", agentType: "codex", createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), useWorktree: false, resumePrompt,
  } as never);
  const { resumeOrRunTask } = await import("../src/task-resume.js");
  await resumeOrRunTask(taskId, { reason: "run" }).catch((error: unknown) => {
    // 起跑本身失败不是本段要钉的事(假 CLI 当场退出),交代怎么处置才是。
    console.log(`   （起跑如预期失败:${error instanceof Error ? error.message : String(error)}）`);
  });
  for (let i = 0; i < 200 && isRunning(taskId); i += 1) await sleep(50);
  await sleep(300); // 让 finally 那条对账走完
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!;
  check(task.resumePrompt === resumePrompt,
    `交代原样留在任务上(实际:${task.resumePrompt === null ? "被消费掉了" : JSON.stringify(task.resumePrompt)}）`);
  const receipts = await db.select().from(scheduledMessages).where(eq(scheduledMessages.taskId, taskId));
  const acked = receipts.filter((row) => row.status === "sent");
  check(acked.length === 0,
    `没有任何一张续跑凭证被补记成已送达(实际 ${acked.length} 张:${acked.map((r) => r.id).join(",") || "无"}）`);
}

console.log("⑬ 回合已开跑、应答还在路上就断链 → accepted,不许退回重投(F4)");
{
  // 这一段钉的是**协议层那个判定本身**(§11 钉的是 unknown 的记账)。垫片发完 `turn/started`
  // 就断线,应答永远回不来:ash 侧 `ready` 会被「连接已关闭」拒掉。把那次 reject 一律读成
  // 「一个字都没进去」的那一版会让投递侧把同一段输入再送一遍 —— 而 agent 那边可能已经跑起来了。
  codexMode(fakeBin, "started-then-drop");
  const child = spawn(join(fakeBin, "codex"), [], { stdio: ["pipe", "pipe", "pipe"] });
  strays.add(child);
  const handle = openCodexAppServer({
    bin: "codex", args: [], cwd: root, prompt: "继续:这一轮已经开跑了",
    startProcess: () => child,
  });
  // 事件流得有人消费,否则 finish 那一串排在队里不往下走。
  void (async () => { try { for await (const _ of handle.events) { /* 丢掉 */ } } catch { /* 同上 */ } })();
  const acceptance = await awaitTurnInput(handle);
  check(acceptance === "accepted",
    `看到过本回合的开始凭据 → 断链之后仍是 accepted(实际 ${acceptance});"refused" = 会重复执行`);

  // 对照:连一次握手都没通(垫片当场退出)才是确证的 refused。
  codexMode(fakeBin, "refuse");
  const dead = spawn(join(fakeBin, "codex"), [], { stdio: ["pipe", "pipe", "pipe"] });
  strays.add(dead);
  const deadHandle = openCodexAppServer({
    bin: "codex", args: [], cwd: root, prompt: "继续:这一轮一个字都没出去",
    startProcess: () => dead,
  });
  void (async () => { try { for await (const _ of deadHandle.events) { /* 丢掉 */ } } catch { /* 同上 */ } })();
  const refused = await awaitTurnInput(deadHandle);
  check(refused === "refused",
    `协议从头没通 → refused(实际 ${refused});这一档才允许退回重投`);
}

console.log("⑭ 拒收事实活过重启:记号在就不许被对账判成已送达(F2 的持久化那一半)");
{
  // ⑫ 钉的是进程还活着、finally 正常跑完那条路。这一段钉另一条窄缝:判出拒收之后、归还落库
  // **之前**进程就没了。重启对账手上只有越线记号(线确实越过了)+ 会话行 —— 旧判据会判成
  // delivered 并补记送达,交代就没了。所以拒收这个事实必须自己落盘。
  const { checkpointDeliveryVerdict } = await import("../src/pending-checkpoint-recovery.js");
  const { noteDeliveryRefusal, recordDeliveryCrossing, forgetDeliveryCrossing, CROSSING_PROTOCOL } =
    await import("../src/delivery-crossing.js");
  const taskId = "t-refusal-survives";
  const sessionId = "s-refusal";
  const turnStart = new Date().toISOString();
  mkdirSync(join(root, "runs", taskId), { recursive: true });
  await db.insert(tasks).values({
    id: taskId, projectId: "p-undriven", title: taskId, body: "验证拒收记号活过重启",
    mode: "single", status: "paused", agentType: "codex", createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), useWorktree: false,
  } as never);
  // 造出「越线记号在 + 会话行在」这个现场 —— 也就是旧判据会判 delivered 的那一份。
  await db.insert(sessions).values({
    id: sessionId, taskId, agentType: "codex", role: "single", executor: "codex",
    startedAt: turnStart, turnStartedAt: turnStart, cwd: root, commandLine: "codex app-server",
  } as never);
  const receipt = {
    id: "m-refusal", taskId, deliveringSince: new Date().toISOString(),
    crossingProtocol: CROSSING_PROTOCOL,
  };
  recordDeliveryCrossing(taskId, [receipt.id], { sessionId, turnStart }, true);
  check(await checkpointDeliveryVerdict(receipt) === "delivered",
    "前提:只有越线记号时,对账确实会判「已送达」(否则下面那条断言是假绿)");

  noteDeliveryRefusal(taskId, [receipt.id]);
  const verdict = await checkpointDeliveryVerdict(receipt);
  check(verdict === "not-started",
    `拒收记号在 → 判「压根没送出去」,交代归还(实际 ${verdict})`);

  // 定论之后两张记号一起清:下一次别拿旧记号去判新的投递。
  const { deliveryRefused } = await import("../src/delivery-crossing.js");
  forgetDeliveryCrossing(taskId, [receipt.id]);
  check(!deliveryRefused(taskId, receipt.id),
    "清理时拒收记号跟越线记号一起删(同一个生命周期,别留给下一次投递)");
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
