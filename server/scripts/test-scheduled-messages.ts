import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { IS_WINDOWS } from "../src/platform.js";
import { releaseTmpDb } from "./tmp-db.js";
import { TEAM_DEFAULTS } from "@harness/shared";

// ── 子进程分支:制造「进程死在投递中途」的真实现场 ────────────────────────────
// 父进程把自己 fork 出一份、指向同一个库(HARNESS_DB 从环境继承)。这里用**投递路径
// 自己那个函数**抢下租约,然后 SIGKILL 自己 —— 没有 finally、没有 catch、没有任何清理
// 机会,库里就留下一条「pending + 有租约」的行。
// 那正是 2026-08-07 消息死掉的当口:当时它已经被标成 sent,补发扫描只查 pending,于是
// 再也没人管它。现在它还是 pending,重启后必须能自己回来。
const crashMessageId = process.env.HARNESS_TEST_CRASH_MESSAGE;
if (crashMessageId) {
  const { beginDelivery } = await import("../src/pending-messages.js");
  if (!(await beginDelivery(crashMessageId))) process.exit(3); // 没抢到 = 测试前提就不成立
  process.kill(process.pid, "SIGKILL");
}

const selfPath = fileURLToPath(import.meta.url);
const root = mkdtempSync(join(tmpdir(), "harness-scheduled-messages-"));
const fakeBin = join(root, "bin");
const leadLog = join(root, "lead-input.jsonl");
const originalPath = process.env.PATH;
process.env.HARNESS_DB = join(root, "harness.db");
process.env.HARNESS_TEST_LEAD_LOG = leadLog;
// 分隔符用 `path.delimiter`:Windows 是 `;`,写死 `:` 会把整条 PATH 粘成一个不存在的
// 目录名,假 claude 和真 node 一起从 PATH 上消失。
process.env.PATH = `${fakeBin}${delimiter}${originalPath ?? ""}`;

mkdirSync(fakeBin, { recursive: true });
// 假 claude 的本体写成一份 .js,壳只负责把它交给 node —— 壳得按平台换:Windows 内核
// 不认 `#!/bin/sh`,PATH 查找只认 PATHEXT 里的后缀,所以那边是 `.cmd`。
// 原来整段是 sh 脚本(`read` / `printf` / `>>`),在真 Windows 上一句都跑不起来,而且
// 失败得极隐蔽:投递那几段全部超时,最后被 finally 里的 EBUSY 盖成一句删不掉临时目录。
writeFileSync(
  join(fakeBin, "fake-claude.js"),
  `const fs = require("fs");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  const i = buf.indexOf("\\n");
  if (i < 0) return;
  fs.appendFileSync(process.env.HARNESS_TEST_LEAD_LOG, buf.slice(0, i) + "\\n");
  process.stdout.write(JSON.stringify({ type: "system", session_id: "scheduled-message-test" }) + "\\n");
  process.stdout.write(
    JSON.stringify({ type: "result", subtype: "success", session_id: "scheduled-message-test" }) + "\\n",
  );
  process.exit(0);
});
// 一行都没等到就断了 = 上游没把 prompt 写进来,按失败退出(对应原来 sh 的 \`read || exit 1\`)
process.stdin.on("end", () => process.exit(1));
`,
);
writeFileSync(
  join(fakeBin, IS_WINDOWS ? "claude.cmd" : "claude"),
  IS_WINDOWS ? `@node "%~dp0fake-claude.js" %*\r\n` : `#!/bin/sh\nexec node "$(dirname "$0")/fake-claude.js" "$@"\n`,
  { mode: 0o755 },
);

const [{ db, ensureSchema }, schema, schedulesModule, pending, runs, status, transcript, paths, { bus }] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/schedules.js"),
  import("../src/pending-messages.js"),
  import("../src/runs.js"),
  import("../src/status.js"),
  import("../src/transcript.js"),
  import("../src/paths.js"),
  import("../src/bus.js"),
]);
const { projects, scheduledMessages, sessions, tasks } = schema;
await ensureSchema();

// 托盘靠这条事件收口。**没有它,前端只能从任务状态跃迁里猜**:排队消息一发出去任务
// 立刻又回到 running,那个空档常常一次都观察不到,于是已经进了会话的消息还在托盘上
// 挂着「排队中」(2026-08-13)。所以每一次 status 变化都必须吱一声。
const trayEvents: string[] = [];
bus.subscribe((event) => {
  if (event.type === "task.pendingMessages") trayEvents.push(event.taskId);
});
const trayEventCount = (taskId: string) => trayEvents.filter((id) => id === taskId).length;

const now = new Date();
const at = now.toISOString();
const dueAt = new Date(now.getTime() - 60_000).toISOString();
const projectId = "scheduled-project";
const deliveredTaskId = "scheduled-team-delivered";
const unavailableTaskId = "scheduled-team-unavailable";
const queuedTaskId = "scheduled-single-queued";
const lockedTaskId = "scheduled-single-locked";
const crashTaskId = "scheduled-single-crashed";
const unavailableSessionId = "scheduled-team-unavailable-session";
const unavailableTranscript = transcript.sessionTranscriptPath(unavailableTaskId, unavailableSessionId);

// 「调度台不可用」这一档必须与本机装了什么 CLI 无关:claude/codex 都实现了常驻会话,
// 装了真 codex 的机器上它会真的开起来。用一个走 GenericCliExecutor 的类型(它们一律
// 不实现 openResident,这正是「谁能当调度者」的过滤条件),失败点就锁死在协议上。
const taskRow = (id: string, lead: "claude" | "gemini", status: "idle" | "running" | "done") => ({
  id,
  projectId,
  groupId: null,
  parentId: null,
  title: id,
  body: "验证团队定时消息",
  mode: "team",
  status,
  labels: "[]",
  dependsOn: "[]",
  resumeDependsOn: "[]",
  agentType: lead,
  executorId: null,
  autoTitle: false,
  duet: null,
  team: JSON.stringify({ ...TEAM_DEFAULTS, lead }),
  scheduleId: null,
  createdAt: at,
  updatedAt: at,
  useWorktree: false,
  worktreeBase: null,
  originTaskId: null,
});

const messageRow = (id: string, taskId: string, text: string, mode: "timed" | "queued" = "timed") => ({
  id,
  taskId,
  text,
  attachments: "[]",
  agent: null,
  mode,
  // 排队消息的 sendAt 是入队时刻(只用来排先后),定时消息的是到期时刻。
  sendAt: dueAt,
  status: "pending",
  createdAt: at,
  sentAt: null,
  deliveringSince: null,
});

// 15s 而不是 3s:每一步都是「真的起一个进程 + 真的写盘」,而这个脚本常常与前端构建、
// 其它回归测试挤在同一台机器上跑。超时是用来兜死锁的,不是用来卡性能的 —— 定太紧,
// 失败信息会指向一个根本没坏的地方。
const waitFor = async (predicate: () => boolean | Promise<boolean>, message: string) => {
  const deadline = Date.now() + 15_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

// ── 投递判定(纯函数,不碰 DB)───────────────────────────────────────────────
// 排队(queued)与定时(timed)只差「什么时候算到期」这一条:前者不看钟点,但必须
// 等单任务空下来;后者看钟点。「任务在忙」永远是等,不是取消。
const future = new Date(now.getTime() + 60_000).toISOString();
const single = (s: string) => ({ mode: "single", status: s, archived: false });
assert.equal(pending.deliveryVerdict({ mode: "queued", sendAt: future }, single("done"), now).action, "deliver",
  "排队消息不看时间:任务空闲就该发");
assert.equal(pending.deliveryVerdict({ mode: "queued", sendAt: dueAt }, single("running"), now).action, "wait",
  "排队消息绝不能插进正在跑的回合");
assert.equal(pending.deliveryVerdict({ mode: "queued", sendAt: dueAt }, single("queued"), now).action, "wait",
  "queued(已拉起还没 spawn)同样算在跑");
assert.equal(pending.deliveryVerdict({ mode: "queued", sendAt: dueAt }, single("paused"), now).action, "deliver",
  "提问/检查点暂停算空闲,排队消息正好是那句答复");
assert.equal(pending.deliveryVerdict({ mode: "timed", sendAt: future }, single("done"), now).action, "wait",
  "定时消息没到点就得等,哪怕任务闲着");
assert.equal(
  pending.deliveryVerdict({ mode: "queued", sendAt: dueAt }, { mode: "team", status: "running", archived: false }, now)
    .action,
  "deliver",
  "常驻调度台正在说话也接得住",
);
assert.equal(pending.deliveryVerdict({ mode: "queued", sendAt: dueAt }, null, now).action, "cancel", "任务没了 → 取消");
assert.equal(
  pending.deliveryVerdict({ mode: "queued", sendAt: dueAt }, { ...single("done"), archived: true }, now).action,
  "cancel",
  "归档任务不再接消息",
);
assert.equal(pending.deliveryVerdict({ mode: "queued", sendAt: dueAt }, single("done"), now).action, "deliver");
assert.equal(
  pending.deliveryVerdict({ mode: "timed", sendAt: dueAt }, { mode: "duet", status: "done", archived: false }, now)
    .action,
  "cancel",
  "辩论任务不支持回复,等下去也没意义",
);
console.log("✓ 投递判定:排队不看时间但等任务空闲,定时看时间,忙=等而不是取消");

// 收尾里那句 `process.exit(0)` 是**无条件**的:没有这个 catch,try 里任何一条断言炸掉都会被
// 它按 0 退出,`npm run test:*` 一律绿 —— 一份永远不会红的回归比没有回归更坏(实测:把 PATH
// 指到不存在的目录,整轮只打出第一个 ✓,退出码照样 0)。这里接住、原样打出来、记账,
// 由 finally 末尾按它决定退出码。
let failure: unknown = null;
try {
  await db.insert(projects).values({ id: projectId, name: "scheduled", repoPath: root, apiKeys: null, createdAt: at });
  await db.insert(tasks).values([
    taskRow(deliveredTaskId, "claude", "running"),
    taskRow(unavailableTaskId, "gemini", "idle"),
    { ...taskRow(queuedTaskId, "claude", "running"), mode: "single", team: null },
    { ...taskRow(lockedTaskId, "claude", "running"), mode: "single", team: null },
    { ...taskRow(crashTaskId, "claude", "done"), mode: "single", team: null },
  ]);
  await db.insert(sessions).values({
    id: unavailableSessionId,
    taskId: unavailableTaskId,
    role: "lead",
    agentType: "gemini",
    executor: "gemini@test",
    cwd: root,
    startedAt: at,
  });
  mkdirSync(dirname(unavailableTranscript), { recursive: true });
  await db.insert(scheduledMessages).values([
    messageRow("scheduled-delivered", deliveredTaskId, "团队定时消息到期"),
    messageRow("scheduled-unavailable", unavailableTaskId, "这条消息应安全取消"),
    messageRow("scheduled-queued", queuedTaskId, "排队追问:等这一轮跑完再发", "queued"),
    messageRow("scheduled-locked", lockedTaskId, "结算钩子里投递的这句话不许丢", "queued"),
  ]);

  await schedulesModule.tick();

  await waitFor(
    () => existsSync(leadLog) && readFileSync(leadLog, "utf8").includes("团队定时消息到期"),
    "团队定时消息没有进入 lead 常驻会话",
  );
  const delivered = (await db.select().from(scheduledMessages)
    .where(eq(scheduledMessages.id, "scheduled-delivered"))).at(0)!;
  assert.equal(delivered.status, "sent", "成功投递到 lead 后应标记 sent");
  assert.ok(delivered.sentAt, "成功投递应记录 sentAt");
  assert.match(readFileSync(leadLog, "utf8"), /【新消息】团队定时消息到期/);

  const unavailable = (await db.select().from(scheduledMessages)
    .where(eq(scheduledMessages.id, "scheduled-unavailable"))).at(0)!;
  assert.equal(unavailable.status, "canceled", "lead 不支持常驻会话时必须安全取消");
  assert.equal(unavailable.sentAt, null, "取消的消息不得保留 sentAt");
  await waitFor(
    () => existsSync(unavailableTranscript)
      && readFileSync(unavailableTranscript, "utf8").includes("定时消息未发送，已取消"),
    "lead 不可用的取消原因没有写入持久时间线",
  );
  assert.match(readFileSync(unavailableTranscript, "utf8"), /调度台不可用/);
  // 取消 = 这条消息从托盘上消失,原文必须在时间线上留底,否则用户只能凭记忆重打一遍。
  assert.match(readFileSync(unavailableTranscript, "utf8"), /原文：这条消息应安全取消/);

  console.log("✓ 团队定时消息到期后进入 lead 常驻会话并标记 sent");
  console.log("✓ lead 不可用时消息安全取消并把原因写入时间线");

  // 投递成功和取消都得让托盘知道 —— 这两条是它「少一行」的唯一权威信号。
  assert.ok(trayEventCount(deliveredTaskId) > 0, "消息标成 sent 却没通知托盘,前端会一直挂着「排队中」");
  assert.ok(trayEventCount(unavailableTaskId) > 0, "消息取消了却没通知托盘");

  // ── 排队追问:运行中不插队,任务一落终态由 status 钩子立刻发出 ────────────
  const queuedAfterTick = (await db.select().from(scheduledMessages)
    .where(eq(scheduledMessages.id, "scheduled-queued"))).at(0)!;
  assert.equal(queuedAfterTick.status, "pending", "任务还在跑,排队消息必须原地等着");
  assert.equal(
    (await db.select().from(sessions).where(eq(sessions.taskId, queuedTaskId))).length,
    0,
    "排队期间不得为任务起任何一轮运行",
  );

  // 这一步就是真实链路:run loop 结算 → setTaskStatus → flushPendingForTask。
  await status.setTaskStatus(queuedTaskId, "done");
  // 先等**会话真的起来**再看状态位:sent 的定义就是「原话已经进会话了」,所以这两个
  // 断言的先后顺序本身也是在钉这条不变量 —— 反过来先等到 sent 却等不到会话,那才是 bug。
  await waitFor(
    async () => (await db.select().from(sessions).where(eq(sessions.taskId, queuedTaskId))).length > 0,
    "任务落终态后排队消息没有被立刻发出(status 钩子没接上?)",
  );
  await waitFor(
    async () => (await db.select().from(scheduledMessages)
      .where(eq(scheduledMessages.id, "scheduled-queued"))).at(0)!.status === "sent",
    "原话已经进会话了,库里那条却还没标成 sent",
  );
  // 等这一轮结算完再进 finally:临时目录连 DB 一起删,而 run loop 还在往里写。
  await waitFor(
    async () => {
      const t = (await db.select().from(tasks).where(eq(tasks.id, queuedTaskId))).at(0)!;
      return t.status !== "running" && t.status !== "queued";
    },
    "排队消息投递出去的那一轮没有结算",
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  // 这正是 bug 的现场:任务从 running 落终态、投递、又回到 running,前端多半一次
  // 非 running 都没看到。托盘能少一行,靠的只能是这条事件。
  assert.ok(
    trayEventCount(queuedTaskId) > 0,
    "排队消息发出去了却没通知托盘——前端会同时显示「已收到你的消息」和「排队中」",
  );
  console.log("✓ 排队追问:运行中原地等待,任务一空闲立即投递进原会话");

  // ── 结算钩子里投递:单飞锁还锁着,消息也一个字都不能丢 ────────────────────
  // 真实链路是 run loop 的 try 里 setTaskStatus → flushPendingForTask,**那一刻这一轮
  // 的单飞锁还锁着**。上面那一段是在锁外调的,所以它测不到这个格:2026-08-07 就是在
  // 这里丢的消息——claim 已经把它标成 sent,continueTask 却被锁静默挡回,托盘和时间线
  // 同时没有,用户那句话凭空蒸发。这里把锁真的锁上复现它。
  assert.equal(runs.claimTurn(lockedTaskId), true, "测试自身前提:这一轮的锁应该抢得到");
  await status.setTaskStatus(lockedTaskId, "done");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    (await db.select().from(sessions).where(eq(sessions.taskId, lockedTaskId))).length,
    0,
    "锁还锁着就不该起下一轮(会跟当前这一轮撞在一起)",
  );
  // 等待期间那一行必须**还是 pending**:这段等待只活在内存里,服务此刻重启就随之
  // 蒸发。行要是已经标成 sent,开机第一次 tick 的补发扫描就看不见它了——同一个消息
  // 消失,只是触发条件从「锁」换成了「重启」。
  assert.equal(
    (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, "scheduled-locked"))).at(0)!.status,
    "pending",
    "还没真送出去就先标了 sent——这会儿重启,消息就再也没人管了",
  );

  runs.releaseTurn(lockedTaskId); // run loop 的 finally
  await waitFor(
    async () => (await db.select().from(sessions).where(eq(sessions.taskId, lockedTaskId))).length > 0,
    "这一轮退干净之后排队消息仍然没送进会话——消息被单飞锁静默吞掉了",
  );
  const locked = (await db.select().from(scheduledMessages)
    .where(eq(scheduledMessages.id, "scheduled-locked"))).at(0)!;
  assert.equal(locked.status, "sent", "真送进会话之后才算 sent");
  // 「送到了」的判据是**刷新后仍看得见**:原话作为一个真人回合落进会话时间线。
  const lockedSession = (await db.select().from(sessions).where(eq(sessions.taskId, lockedTaskId))).at(0)!;
  const lockedTranscript = transcript.sessionTranscriptPath(lockedTaskId, lockedSession.id);
  await waitFor(
    () => existsSync(lockedTranscript)
      && readFileSync(lockedTranscript, "utf8").includes("结算钩子里投递的这句话不许丢"),
    "消息标成 sent 了,原话却没落进会话时间线",
  );
  await waitFor(
    async () => {
      const t = (await db.select().from(tasks).where(eq(tasks.id, lockedTaskId))).at(0)!;
      return t.status !== "running" && t.status !== "queued";
    },
    "结算钩子里投递出去的那一轮没有结算",
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  console.log("✓ 结算钩子里投递:锁还锁着不抢跑,锁一放立刻把原话送进会话");

  // ── 进程死在投递中途:重启后必须自己回来 ──────────────────────────────────
  // 上一段证明了「锁挡回不丢消息」,但锁不是唯一能掐断投递的东西 —— 服务重启会把内存里
  // 的等待/在途标记连根拔掉。所以「有人正在送」必须**落库**成一个可回收的租约,而不是
  // 提前把状态改成 sent:后者一断电就是一条永远没人管的 sent 行(2026-08-07 那条就是)。
  await db.insert(scheduledMessages).values([
    messageRow("scheduled-crashed", crashTaskId, "重启也不许弄丢这句话", "queued"),
  ]);
  const crash = spawnSync(process.execPath, [...process.execArgv, selfPath], {
    env: { ...process.env, HARNESS_TEST_CRASH_MESSAGE: "scheduled-crashed" },
    encoding: "utf8",
  });
  // 「它确实是被硬杀的」这件事,两个平台的证据不一样:POSIX 下父进程拿得到 signal='SIGKILL',
  // Windows 上没有信号这回事 —— Node 的 process.kill 落到 TerminateProcess,回来的是
  // status=1 / signal=null。原来这里无条件断言 signal,于是真 Windows 上这条回归**固定**停在
  // 这一行,后面「租约还挂着 / 开机回收 / 原话补发进时间线」三段核心断言一条都没跑过,
  // 而那台机器正是我们唯一能验 Windows 行为的地方。
  assert.ok(!crash.error, `子进程根本没起来:${crash.error?.message ?? ""}`);
  assert.notEqual(crash.status, 3, "子进程没抢到租约,这一段的前提就不成立(beginDelivery 返回 false)");
  if (IS_WINDOWS) {
    assert.equal(crash.status, 1, `子进程应当在持有租约时被硬杀:status=${crash.status} ${crash.stderr ?? ""}`);
  } else {
    assert.equal(crash.signal, "SIGKILL", `子进程应当在持有租约时被硬杀:${crash.stderr ?? ""}`);
  }

  const crashed = (await db.select().from(scheduledMessages)
    .where(eq(scheduledMessages.id, "scheduled-crashed"))).at(0)!;
  assert.equal(crashed.status, "pending", "投递中途的行必须还是 pending —— 这是它还能被补发的唯一前提");
  assert.ok(crashed.deliveringSince, "「有人正在送」必须落库,否则重启后没人知道这条得重投");

  // 租约还挂着时不许有人插手:真在跑的那个投递(以及另一个触发源)都靠它排他。
  await pending.deliverPendingMessages();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(
    (await db.select().from(sessions).where(eq(sessions.taskId, crashTaskId))).length,
    0,
    "租约还挂着就抢着投递了——同一条消息会被发两遍",
  );

  // 这就是「重启」:一个新进程走真实开机路径(startScheduler 先回收租约再跑第一次 tick)。
  schedulesModule.startScheduler(3_600_000);
  await waitFor(
    async () => (await db.select().from(sessions).where(eq(sessions.taskId, crashTaskId))).length > 0,
    "重启后没人补发这条消息——它被永久卡在「正在投递」了",
  );
  const crashSession = (await db.select().from(sessions).where(eq(sessions.taskId, crashTaskId))).at(0)!;
  const crashTranscript = transcript.sessionTranscriptPath(crashTaskId, crashSession.id);
  await waitFor(
    () => existsSync(crashTranscript) && readFileSync(crashTranscript, "utf8").includes("重启也不许弄丢这句话"),
    "重启补发之后原话仍然没有落进会话时间线",
  );
  await waitFor(
    async () => {
      const m = (await db.select().from(scheduledMessages)
        .where(eq(scheduledMessages.id, "scheduled-crashed"))).at(0)!;
      return m.status === "sent" && m.deliveringSince === null;
    },
    "补发成功后应当标 sent 并清掉租约",
  );
  await waitFor(
    async () => {
      const t = (await db.select().from(tasks).where(eq(tasks.id, crashTaskId))).at(0)!;
      return t.status !== "running" && t.status !== "queued";
    },
    "重启补发出去的那一轮没有结算",
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  console.log("✓ 进程死在投递中途:行留在 pending + 租约,重启后开机第一件事就把它补发出去");
} catch (e) {
  failure = e;
  console.error(e);
} finally {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  delete process.env.HARNESS_TEST_LEAD_LOG;
  rmSync(join(paths.RUNS_DIR, deliveredTaskId), { recursive: true, force: true });
  rmSync(join(paths.RUNS_DIR, unavailableTaskId), { recursive: true, force: true });
  rmSync(join(paths.RUNS_DIR, queuedTaskId), { recursive: true, force: true });
  rmSync(join(paths.RUNS_DIR, lockedTaskId), { recursive: true, force: true });
  rmSync(join(paths.RUNS_DIR, crashTaskId), { recursive: true, force: true });
  // 删舞台前先松开库文件,否则 Windows 上必然 EBUSY(理由见 tmp-db.ts 的 releaseTmpDb)。
  await releaseTmpDb();
  // 收尾**不许盖住正主**:这里跑在 finally 里,try 抛出的断言错会被这一句的异常顶掉,
  // 于是「假 claude 起不来」在真机上显示成「删不掉临时目录」,白查一轮。Windows 还有
  // 一层:被 SIGKILL 的那个子进程句柄要等系统回收,文件删了目录也可能一时删不掉
  // (删除是延迟生效的),重试几次多半就过去了;实在删不掉就只提一句,让真错自己冒出来。
  for (let i = 0; ; i++) {
    try {
      rmSync(root, { recursive: true, force: true });
      break;
    } catch (e) {
      if (i >= 10) {
        console.warn(`⚠︎ 临时目录没删掉(不影响结论):${root} — ${(e as Error).message}`);
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  process.exit(failure ? 1 : 0); // startScheduler 的 interval 还挂着,不然进程不会自己退
}
