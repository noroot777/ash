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
//   ③ 看门狗静默档 —— 「回合开始后 N 分钟一条进展都没有」要报警并熔断
//      (判据本体拆去了 test-silence-tier.ts:那几段一个真进程都不起,而这一份顶到了单文件上限)
// **这份夹具只有 POSIX 启动方式**(`#!/bin/sh` 的假 codex,见 undriven-turn-fixture.ts):
// win32 上整条跳过。注释说「调用方跳过」而代码里压根没有这道守卫,就是第 2 轮自由审查 N2
// 点到的那种「声明的覆盖面和实际的不一致」—— 要 Windows 覆盖只能上 192.168.1.187 真跑
// (根 AGENTS.md),在这台机器上跳过它、并且**明说跳过了**,比假装通过诚实。
if (process.platform === "win32") {
  console.log("test:undriven-turn 跳过：夹具是 #!/bin/sh 的假 codex，Windows 覆盖要上真机（根 AGENTS.md）");
  process.exit(0);
}

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
// `turn/start` 的**应答期限**(codex-app-server.ts 的 CODEX_TURN_START_ACK_MS;真实默认一分钟)。
// §⑰ 两段都按它定位:a 段要在期限**之前**就凭完成事件收口(所以断言给 2.5 秒),b 段要的正是
// 期限本身到期。压成 5 秒 = 两边各留一半余量,谁跑到期限之外都读得出来。
process.env.ASH_CODEX_TURN_START_ACK_MS = "5000";
// 接管后**重读协议日志**的节奏(codex-app-server-contract.ts 的 CODEX_ADOPT_REREAD_MS;真实
// 默认 2 秒)。§⑩b 要的是「两头都读不出来时那条可见提示按节奏出现」,20ms 一拍 ⇒ 第 5 拍开口
// 大约 100ms,不必为了一条提示等满十秒。
process.env.ASH_CODEX_ADOPT_REREAD_MS = "20";
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
// `turn/start` 的**应答期限**(codex-app-server.ts 的 CODEX_TURN_START_ACK_MS;真实默认一分钟)。
// §⑰ 两段都按它定位:a 段要在期限**之前**就凭完成事件收口(所以断言给 2.5 秒),b 段要的正是
// 期限本身到期。压成 5 秒 = 两边各留一半余量,谁跑到期限之外都读得出来。
process.env.ASH_CODEX_TURN_START_ACK_MS = "5000";
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
  // 「不按失败结算」= 没有 done,**而且**没有任何会影响结算的错误。按节奏报出来的那条提示是
  // `notice`(`affectsTurn:false`,见 §⑩b):它必须在,但它不参与结算 —— 中途真恢复了、这一轮
  // 正常答完仍然算成功。把两者混成一句 `!includes("error")` 就会把「让用户看见」误判成「杀它」。
  let fatal = 0;
  const consume = (async () => {
    for await (const event of handle.events) {
      kinds.push(event.kind);
      if (event.kind === "error" && (event.level !== "notice" || event.affectsTurn !== false)) fatal += 1;
    }
  })();
  await Promise.race([consume, sleep(1_500)]);
  check(!kinds.includes("done") && fatal === 0,
    `核实不了就不杀它(收到:${kinds.join(",") || "无"};影响结算的错误 ${fatal} 条)`
    + " —— 一次磁盘故障不该被诊断成「输入一个字都没到」");
  // **这一档不许冒充成功**(第 2 轮自由审查 F4):上一版让 `ready` 直接 resolve,于是回执报
  // `accepted`、投递侧据此落终态 `sent` —— 而那串字到没到压根不知道。放行自己的等待不等于
  // 对方的确认,只能是「说不上来」。
  const adoptAcceptance = await awaitTurnInput(handle);
  check(adoptAcceptance === "unknown",
    `读不出来 → 回执是 unknown(实际 ${adoptAcceptance});"accepted" = 把自己的放行当成对方的确认`);
  handle.kill();
  await Promise.race([consume, sleep(3_000)]);
}
{
  // ⑩b **「核实不了」不许变成「谁都不管」**(第 2 轮自由审查 F3)。
  //
  // 上一条断言的保守做法是对的(不杀一个核实不了的回合),但它跟另一个保守分支叠在一起就出事:
  // 进展证明读不出来 ⇒ 静默档也不开(turn-stall.ts)。两个一叠,这一轮既不报错、也不产出、
  // 也没人兜 —— 而「零输出零报错」恰恰是看门狗唯一认不出的形状。所以适配器现在隔一会儿就报
  // 一条 notice:它让用户看得见,而**错误档据此计时**(notice 同样计入 trackTurnStall ——
  // 那一半在 test-silence-tier.ts §① 的换档那段钉着),到阈值先警告、再终止并按失败结算。
  const child = idleAppServer();
  const handle = openCodexAppServer({
    bin: "codex", args: [], cwd: root, prompt: "",
    sessionId: "th-voiced",
    // 重读也一直读不出来:这正是「两头都没结论」那一档。
    reattach: {
      threadId: "th-voiced", turnId: "", evidence: "unreadable",
      reread: () => ({ turnId: "", evidence: "unreadable" as const }),
    },
    startProcess: () => child,
  });
  const notices: string[] = [];
  const kinds: string[] = [];
  const consume = (async () => {
    for await (const event of handle.events) {
      kinds.push(event.kind);
      if (event.kind === "error" && event.level === "notice") notices.push(event.message);
    }
  })();
  // 重读节奏压到 20ms(ASH_CODEX_ADOPT_REREAD_MS,见文件头),第 5 拍开口 ⇒ 100ms 上下。
  for (let i = 0; i < 60 && notices.length === 0; i += 1) await sleep(50);
  check(notices.length >= 1,
    `核实不了的回合会按节奏报出可见提示(收到 ${notices.length} 条);上一版只打一行 console,`
    + "用户刷新页面什么都看不见,看门狗也没有形状可认");
  check(/核实不了/.test(notices[0] ?? "") && /失败结算/.test(notices[0] ?? ""),
    "提示如实说清:此刻还核实不了、会继续核验、到阈值由看门狗终止并按失败结算");
  check(!kinds.includes("done"),
    `这一轮没有被当场结算掉(收到:${[...new Set(kinds)].join(",")}) —— 可见不等于误杀`);
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
  // **F1 的根因那一条**:越线 + 会话行 + 回合行是 ash 自己的记账,它只证明「可能已经产生
  // 外部效果」。上一版拿这三样判「已送达」并把交代消费掉,而那串字到没到 agent 手里压根
  // 不在这三样里 —— 说不上来就得是说不上来。
  const crossedOnly = await checkpointDeliveryVerdict(receipt);
  check(crossedOnly === "uncertain",
    `只有越线记号(+会话行) → uncertain,不许判「已送达」(实际 ${crossedOnly})`);
  // 判「已送达」的唯一凭据是协议层那一声确认。
  const { noteDeliveryAccepted } = await import("../src/delivery-crossing.js");
  noteDeliveryAccepted(taskId, [receipt.id]);
  check(await checkpointDeliveryVerdict(receipt) === "delivered",
    "协议确认记号在 → 这才是「已送达」(前提:否则下面那条断言是假绿)");

  noteDeliveryRefusal(taskId, [receipt.id]);
  const verdict = await checkpointDeliveryVerdict(receipt);
  check(verdict === "not-started",
    `拒收记号在 → 判「压根没送出去」,交代归还(实际 ${verdict})`);

  // 定论之后两张记号一起清:下一次别拿旧记号去判新的投递。
  const { deliveryRefused, deliveryAccepted } = await import("../src/delivery-crossing.js");
  forgetDeliveryCrossing(taskId, [receipt.id]);
  check(!deliveryRefused(taskId, receipt.id) && !deliveryAccepted(taskId, receipt.id),
    "清理时三张记号(越线/拒收/协议确认)一起删(同一个生命周期,别留给下一次投递)");
}

console.log("⑮ 身份读不出来时,这个 thread 上的完成事件就是这一轮(第 2 轮自由审查 F4)");
{
  // 上一版把「读不出来」做成「`ready` 直接 resolve + 身份留空」,于是真正属于这一轮的
  // `turn/completed` 在身份检查上被丢掉:常驻进程还活着、进展记号又是 `seen`(重启前确实
  // 产出过,静默档按判据不该开)—— **连「它答完了」都不结算**,需求明令禁止的无界等待换个
  // 入口回来了。接管那一刻这个 thread 上只跑着我们接回来的那一个回合,所以认它是安全的。
  const child = spawn(process.execPath, ["-e",
    "process.stdout.write(JSON.stringify({method:'turn/completed',params:{threadId:'th-adopt-id',"
    + "turn:{id:'t-identity-unknown',status:'completed',error:null}}})+'\\n');"
    + "setInterval(()=>{},1000);"], { stdio: ["pipe", "pipe", "pipe"] });
  strays.add(child);
  const handle = openCodexAppServer({
    bin: "codex", args: [], cwd: root, prompt: "",
    sessionId: "th-adopt-id",
    // 日志读不出来 → 手上没有 turnId,而完成事件带的那个 id 我们从没见过。
    reattach: { threadId: "th-adopt-id", turnId: "", evidence: "unreadable" },
    startProcess: () => child,
  });
  let exitStatus: number | null = null;
  const kinds: string[] = [];
  const consume = (async () => {
    for await (const event of handle.events) {
      kinds.push(event.kind);
      if (event.kind === "done") exitStatus = event.exitStatus;
    }
  })();
  await Promise.race([consume, sleep(6_000)]);
  check(kinds.includes("done"), `认下这条完成事件并结算了这一轮(收到:${kinds.join(",") || "无"})`);
  check(exitStatus === 0, `回合本身是成功收口的,结算也得照它(exitStatus=${exitStatus})`);
  handle.kill();
  await Promise.race([consume, sleep(2_000)]);
}

// ⑯ 投递租约那一组(在途/迟到/欠账补偿、真实投递入口、消费水位一致性)搬去了
// test-delivery-receipt.ts —— 这一份顶到了单文件上限(根 CLAUDE.md 的 700 行),而那一组跟
// 这边的依赖只重合在夹具上。同一条命令里接着跑(package.json 的 test:undriven-turn)。

console.log("⑰ 协议点过头、应答却不回来:回执与结算都不许挂在那段本地流程上(第 3 轮自由审查 F3)");
{
  // ⑰a **实测过的那个形状**:垫片按序发 turn/started、工具事件、回答、turn/completed,
  // 唯独不回 turn/start 的应答,并且**保持连接**。旧代码:回执停在未落定(投递链一动不动),
  // completeTurn 卡在 await ready —— 「做完了却永远不结束」,而工具事件早把静默档解除了。
  const noAck = (quiet: boolean) => spawn(process.execPath, ["-e", `
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  for (;;) {
    const nl = buf.indexOf("\\n");
    if (nl < 0) return;
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (line.trim()) { try { recv(JSON.parse(line)); } catch {} }
  }
});
function recv(m) {
  if (m.id === undefined) return;
  if (m.method === "thread/start" || m.method === "thread/resume") {
    send({ id: m.id, result: { thread: { id: "th-noack" }, model: "fake-codex" } });
    return;
  }
  if (m.method === "turn/start") {
    if (${quiet ? "true" : "false"}) return; // b 段:连通知都没有,只能靠期限
    send({ method: "turn/started", params: { threadId: "th-noack", turn: { id: "t-noack" } } });
    send({ method: "item/started", params: { threadId: "th-noack", turnId: "t-noack",
      item: { type: "commandExecution", id: "c-1", command: "sleep 3600" } } });
    setTimeout(() => {
      send({ method: "item/completed", params: { threadId: "th-noack", turnId: "t-noack",
        item: { type: "agentMessage", id: "m-1", text: "跑完了。" } } });
      send({ method: "turn/completed", params: { threadId: "th-noack",
        turn: { id: "t-noack", status: "completed", error: null } } });
    }, 30);
    return; // **应答永远不发**,而且不断线
  }
  send({ id: m.id, result: {} });
}
setInterval(() => {}, 1000);
`], { stdio: ["pipe", "pipe", "pipe"] });

  const live = noAck(false);
  strays.add(live);
  const began = Date.now();
  const handle = openCodexAppServer({
    bin: "codex", args: [], cwd: root, prompt: "跑一条长命令", env: { CODEX_HOME: join(root, "codex-home") },
    startProcess: () => live,
  });
  const receipt = await Promise.race([
    handle.inputAccepted,
    sleep(1_000).then(() => "还没落定" as const),
  ]);
  check(receipt === "accepted",
    `开始凭据一到就落 accepted(实际 ${receipt});挂在那段本地流程上 = 投递链一直在途`);
  const kinds: string[] = [];
  let exitStatus: number | null = null;
  const consume = (async () => {
    for await (const event of handle.events) {
      kinds.push(event.kind);
      if (event.kind === "done") exitStatus = event.exitStatus;
    }
  })();
  await Promise.race([consume, sleep(6_000)]);
  const took = Date.now() - began;
  check(kinds.includes("done") && exitStatus === 0,
    `完成事件照旧收口这一轮(kinds=${kinds.join(",") || "无"}, exitStatus=${exitStatus})`);
  check(took < 2_500,
    `而且是**凭完成事件**收的,不是等那个 5 秒期限(实际 ${took}ms);旧代码:无限等`);
  handle.kill();
  await Promise.race([consume, sleep(2_000)]);

  // ⑰b **一条通知都没有**那一档:凭据一个也没有,只剩期限。它必须在期限上按失败收口 ——
  // 旧代码里 turn/start 压根没有时限,这条路就是「谁都不会再说话」的无界等待本体。
  const mute = noAck(true);
  strays.add(mute);
  const muteBegan = Date.now();
  const quiet = openCodexAppServer({
    bin: "codex", args: [], cwd: root, prompt: "这一句谁都没收下", env: { CODEX_HOME: join(root, "codex-home") },
    startProcess: () => mute,
  });
  const quietKinds: string[] = [];
  let quietExit: number | null = null;
  const quietConsume = (async () => {
    for await (const event of quiet.events) {
      quietKinds.push(event.kind);
      if (event.kind === "done") quietExit = event.exitStatus;
    }
  })();
  await Promise.race([quietConsume, sleep(12_000)]);
  check(quietKinds.includes("done") && quietExit === 1,
    `到期就按失败收口(kinds=${quietKinds.join(",") || "无"}, exitStatus=${quietExit});不许一直等`);
  const waited = Date.now() - muteBegan;
  check(waited < 10_000, `而且是有界的(实际等了 ${waited}ms,期限 5 秒)`);
  const quietReceipt = await Promise.race([quiet.inputAccepted, sleep(1_000).then(() => "还没落定" as const)]);
  check(quietReceipt === "unknown",
    `回执是「说不上来」(实际 ${quietReceipt}):那串字已经写进 stdin 了,不许当成确证拒收去重投`);
  quiet.kill();
  await Promise.race([quietConsume, sleep(2_000)]);
}

console.log("⑰c 接管后的重读:两头都是结论,而且核验不设上限(第 1、2 轮自由审查 F3)");
{
  const { recoverAdoptedIdentity } = await import("../src/executors/codex-app-server-adopt.js");
  type Adopted = Parameters<Parameters<typeof recoverAdoptedIdentity>[1]>[0];
  /** 按 `reads` 顺序喂读取结果(用完了就一直给最后那个),记下每一拍的「仍然说不上来」。 */
  const run = (reads: Adopted[], stopAfter = 40) =>
    new Promise<{ got: Adopted[]; unknowns: number[]; reads: number }>((resolve) => {
      const got: Adopted[] = [];
      const unknowns: number[] = [];
      let i = 0;
      // **自己带一个闹钟**:核验要是又变成「几次之后收手」,这里等的那个结论就永远不来 ——
      // 没有闹钟的话这一段是**挂住**(顶层 await 不落定、rc=13),而挂住比红字难查得多:
      // 下一个人只看到跑不完,不知道是哪一条判据没了。到点就拿手上的交卷,让断言说话。
      const alarm = setTimeout(() => resolve({ got, unknowns, reads: i }), 1_500);
      alarm.unref?.();
      recoverAdoptedIdentity(
        () => reads[Math.min(i++, reads.length - 1)]!,
        (state) => { got.push(state); clearTimeout(alarm); resolve({ got, unknowns, reads: i }); return true; },
        (attempt) => {
          unknowns.push(attempt);
          if (attempt < stopAfter) return true;
          clearTimeout(alarm);
          resolve({ got, unknowns, reads: i }); // 钉完收手,免得这条链在测试退出后还在转
          return false;
        },
        { everyMs: 2, maxMs: 4, steadyAfter: 2 },
      );
    });
  const blind: Adopted = { turnId: "", evidence: "unreadable" };

  const negative = await run([blind, { turnId: "", evidence: "never-started" }]);
  check(negative.got.at(0)?.evidence === "never-started",
    `日志读得动了、确证没凭据 → 这个结论交到调用方手上(实际 ${negative.got.at(0)?.evidence ?? "一次都没交"});`
    + "上一版一律包装成 started,于是否证永远走不到拒收那条路");
  const positive = await run([blind, { turnId: "t-back", evidence: "started" }]);
  check(positive.got.at(0)?.turnId === "t-back", "肯定那一头照旧(身份读回来了就停,这一档没被改坏)");

  // **耗尽之后仍然要有人管**(第 2 轮自由审查 F3,审查实测:协议文件藏 10.6 秒再放回来,
  // 此时直接读已经能得到 never-started,而适配器的读取次数永远停在 5)。
  const late: Adopted[] = [blind, blind, blind, blind, blind, blind, blind, blind,
    { turnId: "", evidence: "never-started" }];
  const recovered = await run(late);
  check(recovered.got.at(0)?.evidence === "never-started" && recovered.reads >= 9,
    `读了 ${recovered.reads} 次、过了上一版那 5 次的上限仍在核验,存储一恢复就当场收口`
    + "(上一版:第 5 次之后不再安排读取,这一轮永久挂着)");

  const forever = await run([blind], 12);
  check(forever.unknowns.length >= 12 && forever.got.length === 0,
    `一直读不出来 → 一直核验(${forever.unknowns.length} 拍),不自行退场;` +
    "每一拍都把「仍然说不上来」交给调用方,它据此让这件事可见(见 §⑩b)");
  check(forever.unknowns[0] === 1 && forever.unknowns[1] === 2,
    "交的是第几拍,调用方据此决定什么时候开口、隔多久再说一遍");
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
