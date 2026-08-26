import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { IS_WINDOWS } from "../src/platform.js";
import { releaseTmpDb } from "./tmp-db.js";
import { parseSessionOutput, TEAM_DEFAULTS } from "@ash/shared";
import { installFakeClaude } from "./scheduled-messages-fixture.js";

// 子进程抢下投递租约后 SIGKILL，留下可由重启回收的「pending + 租约」现场。
const crashMessageId = process.env.ASH_TEST_CRASH_MESSAGE;
if (crashMessageId) {
  const { beginDelivery } = await import("../src/pending-messages.js");
  if (!(await beginDelivery(crashMessageId))) process.exit(3); // 没抢到 = 测试前提就不成立
  process.kill(process.pid, "SIGKILL");
}

const selfPath = fileURLToPath(import.meta.url);
const root = mkdtempSync(join(tmpdir(), "ash-scheduled-messages-"));
const leadLog = join(root, "lead-input.jsonl");
const originalPath = process.env.PATH;
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_TEST_LEAD_LOG = leadLog;
const fakeBin = installFakeClaude(root);
// Windows PATH 使用 `;`，必须走 path.delimiter。
process.env.PATH = `${fakeBin}${delimiter}${originalPath ?? ""}`;

const [{ db, ensureSchema }, schema, schedulesModule, pending, runs, status, steer, orchestrator, transcript, paths, { bus }, acceptance, runRoutes, team] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/schedules.js"),
  import("../src/pending-messages.js"),
  import("../src/runs.js"),
  import("../src/status.js"),
  import("../src/task-steer.js"),
  import("../src/orchestrator.js"),
  import("../src/transcript.js"),
  import("../src/paths.js"),
  import("../src/bus.js"),
  import("../src/acceptance-lock.js"),
  import("../src/task-run-routes.js"),
  import("../src/team/session.js"),
]);
const { projects, scheduledMessages, sessions, tasks } = schema;
await ensureSchema();

// 托盘靠显式事件收口，不能从一闪而过的任务状态跃迁推断。
const trayEvents: string[] = [];
const statusEvents: Array<{ taskId: string; status: string }> = [];
const agentEvents: Array<{ taskId: string; event: { kind: string; exitStatus?: number; text?: string } }> = [];
bus.subscribe((event) => {
  if (event.type === "task.pendingMessages") trayEvents.push(event.taskId);
  if (event.type === "task.status") statusEvents.push({ taskId: event.taskId, status: event.status });
  if (event.type === "agent.event") agentEvents.push({ taskId: event.taskId, event: event.event });
});
const trayEventCount = (taskId: string) => trayEvents.filter((id) => id === taskId).length;

const now = new Date();
const at = now.toISOString();
const dueAt = new Date(now.getTime() - 60_000).toISOString();
const projectId = "scheduled-project";
const deliveredTaskId = "scheduled-team-delivered";
const unavailableTaskId = "scheduled-team-unavailable";
const closingTaskId = "scheduled-team-closing";
const queuedTaskId = "scheduled-single-queued";
const lockedTaskId = "scheduled-single-locked";
const pausedChatTaskId = "scheduled-single-paused-chat";
const pausedCompleteTaskId = "scheduled-single-paused-complete";
const crashTaskId = "scheduled-single-crashed";
const steerTaskId = "scheduled-single-steer";
const steerLockedTaskId = "scheduled-single-steer-locked";
const steerLateTaskId = "scheduled-single-steer-late-tool";
const steerUnavailableTaskId = "scheduled-single-steer-unavailable";
const unavailableSessionId = "scheduled-team-unavailable-session";
const closingSessionId = "scheduled-team-closing-session";
const unavailableTranscript = transcript.sessionTranscriptPath(unavailableTaskId, unavailableSessionId);

// 用不实现 openResident 的 GenericCliExecutor 固定复现「调度台不可用」。
const taskRow = (id: string, lead: "claude" | "gemini", status: "idle" | "running" | "done" | "paused") => ({
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

// 真实起进程并写盘，15s 只用于兜死锁，避免并行构建造成假超时。
const waitFor = async (predicate: () => boolean | Promise<boolean>, message: string) => {
  const deadline = Date.now() + 15_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

// 投递判定：queued 等任务空闲，timed 等钟点；任务忙都只是等待。
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

// 保存断言错误，避免 finally 的 process.exit 覆盖真实失败。
let failure: unknown = null;
try {
  await db.insert(projects).values({ id: projectId, name: "scheduled", repoPath: root, apiKeys: null, createdAt: at });
  await db.insert(tasks).values([
    taskRow(deliveredTaskId, "claude", "running"),
    taskRow(unavailableTaskId, "gemini", "idle"),
    taskRow(closingTaskId, "claude", "running"),
    { ...taskRow(queuedTaskId, "claude", "running"), mode: "single", team: null },
    { ...taskRow(lockedTaskId, "claude", "running"), mode: "single", team: null, resumePrompt: "旧检查点" },
    { ...taskRow(pausedChatTaskId, "claude", "paused"), mode: "single", team: null, resumePrompt: "等上游完成后继续第三步" },
    { ...taskRow(pausedCompleteTaskId, "claude", "paused"), mode: "single", team: null, resumePrompt: "Windows 打开后继续验证" },
    { ...taskRow(crashTaskId, "claude", "done"), mode: "single", team: null },
    {
      ...taskRow(steerTaskId, "claude", "done"),
      mode: "single",
      team: null,
      completeConfirmedAt: at,
      resumePrompt: "旧方向留下的续跑指令",
      question: "旧方向留下的问题",
      questionOptions: JSON.stringify(["旧答案"]),
    },
    {
      ...taskRow(steerUnavailableTaskId, "claude", "running"),
      mode: "single",
      team: null,
      completeConfirmedAt: at,
      resumePrompt: "仍属于当前回合的检查点",
      question: "仍属于当前回合的问题",
    },
    { ...taskRow(steerLockedTaskId, "claude", "running"), mode: "single", team: null },
    { ...taskRow(steerLateTaskId, "claude", "running"), mode: "single", team: null },
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
  await db.insert(sessions).values({
    id: "scheduled-steer-session",
    taskId: steerTaskId,
    role: "single",
    agentType: "claude",
    executor: "claude@test",
    cwd: root,
    cliSessionId: "scheduled-steer-cli-session",
    commandLine: "claude --resume scheduled-steer-cli-session",
    startedAt: at,
    turnStartedAt: at,
  });
  await db.insert(sessions).values({
    id: closingSessionId,
    taskId: closingTaskId,
    role: "lead",
    agentType: "claude",
    executor: "claude@test",
    cwd: root,
    cliSessionId: closingSessionId,
    resumeCommand: `claude --resume ${closingSessionId}`,
    startedAt: at,
    turnStartedAt: at,
    activeMs: 0,
  });
  mkdirSync(dirname(unavailableTranscript), { recursive: true });
  await db.insert(scheduledMessages).values([
    messageRow("scheduled-delivered", deliveredTaskId, "团队定时消息到期"),
    messageRow("scheduled-unavailable", unavailableTaskId, "这条消息应安全取消"),
    messageRow("scheduled-queued", queuedTaskId, "排队追问:等这一轮跑完再发", "queued"),
    messageRow("scheduled-locked", lockedTaskId, "结算钩子里投递的这句话不许丢", "queued"),
    messageRow("scheduled-steer-unavailable", steerUnavailableTaskId, "没有活动进程时仍要留队", "queued"),
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

  // 普通追问保留检查点；本轮明确 complete 才消费。
  const replyApi = new Hono(); runRoutes.mountTaskRunRoutes(replyApi);
  const chatReply = await replyApi.request(`/tasks/${pausedChatTaskId}/reply`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "怎么样了？" }),
  });
  assert.equal(chatReply.status, 202);
  await waitFor(async () => !["running", "queued"].includes(
    (await db.select().from(tasks).where(eq(tasks.id, pausedChatTaskId))).at(0)?.status ?? "",
  ), "普通追问回合没有结算");
  const pausedChat = (await db.select().from(tasks).where(eq(tasks.id, pausedChatTaskId))).at(0)!;
  assert.equal(pausedChat.status, "paused", "暂停任务上的普通追问结束后必须恢复 paused");
  assert.equal(pausedChat.resumePrompt, "等上游完成后继续第三步", "普通追问不得吞掉原检查点");

  const completeReply = await replyApi.request(`/tasks/${pausedCompleteTaskId}/reply`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "等待本轮完成确认：Windows 已打开，继续" }) });
  assert.equal(completeReply.status, 202);
  await waitFor(
    async () => (await db.select().from(tasks).where(eq(tasks.id, pausedCompleteTaskId))).at(0)?.status === "running",
    "检查点答复没有启动同一会话的下一轮",
  );
  await db.update(tasks).set({ completeConfirmedAt: new Date().toISOString() }).where(eq(tasks.id, pausedCompleteTaskId));
  await waitFor(async () => !["running", "queued"].includes(
    (await db.select().from(tasks).where(eq(tasks.id, pausedCompleteTaskId))).at(0)?.status ?? "",
  ), "明确完成的检查点答复没有结算");
  const pausedComplete = (await db.select().from(tasks).where(eq(tasks.id, pausedCompleteTaskId))).at(0)!;
  assert.equal(pausedComplete.status, "done", "检查点答复明确完成后应落 done");
  assert.equal(pausedComplete.resumePrompt, null, "明确完成应消费旧检查点，不再阻塞预约派审");
  console.log("✓ checkpoint-paused 普通追问保状态与指令，明确完成才消费检查点");
  // 投递成功和取消都得让托盘知道 —— 这两条是它「少一行」的唯一权威信号。
  assert.ok(trayEventCount(deliveredTaskId) > 0, "消息标成 sent 却没通知托盘,前端会一直挂着「排队中」");
  assert.ok(trayEventCount(unavailableTaskId) > 0, "消息取消了却没通知托盘");

  // ── 调度台在收尾窗口里明确拒收:行留在 pending,下一台接手时补送 ──────────────
  // 「lead 不可用」上面已经测了,但那一档是**开不起来**(执行器不支持常驻会话)。真实
  // 生命周期里还有一档更窄的:空闲回收已经 close() 了 stdin / codex resident 已经进
  // closing,但 closeLead 还没把它从 leads 里摘掉 —— 调度台「看起来在线」,两种 resident
  // 都会按 ResidentHandle.send 的回执契约明确返回 false。这一句一个字都没进去,却曾经被
  // 上层无条件当成投递成功:行标 sent、租约清掉,全表扫描只看 pending,于是它从托盘里消失
  // 再没人补送,而同一份事实在时间线里写着「没能送进调度台进程」(2026-08-26 第 14 轮审查)。
  const closingText = "定时指令:调度台收尾窗口也必须真正送达";
  // 接手的那台是**真开出来的**(假 claude 在 PATH 上):旧台一收台,closeLead 把任务落回
  // idle,status 钩子就地把托盘排空 —— 走的正是生产那条路。resume 会复用同一行会话,
  // 所以补送前后是同一份 .md,「原文只能出现一遍」在这一个文件上就验得干净。
  const closingMd = transcript.sessionTranscriptPath(closingTaskId, closingSessionId);
  const countIn = (path: string, needle: string) =>
    (existsSync(path) ? readFileSync(path, "utf8") : "").split(needle).length - 1;
  mkdirSync(dirname(closingMd), { recursive: true });
  let closingAttempts = 0;
  let releaseClosing!: () => void;
  const closingGate = new Promise<void>((resolve) => { releaseClosing = resolve; });
  async function* closingEvents() {
    await closingGate;
    yield { kind: "done", exitStatus: 0 } as const;
  }
  team.attachLead({
    taskId: closingTaskId, sessId: closingSessionId, cliSessionId: closingSessionId,
    agentType: "claude", executorId: null, model: null, reasoningEffort: null, cwd: root,
    handle: {
      sessionId: closingSessionId, commandLine: `claude --resume ${closingSessionId}`,
      events: closingEvents(),
      // 收尾窗口里的 resident 就是这么回执的:stdin 已经关了,一个字都进不去。
      send: () => { closingAttempts += 1; return false; },
      interrupt: () => {}, dropSession: () => {}, close: () => {}, kill: () => {},
    },
    out: createWriteStream(closingMd, { flags: "a" }),
    busy: false, turnStart: null, pending: [], notices: [], pendingCredential: null,
    wantedStatus: null, statusTimer: null, retired: false, idleTimer: null, closing: "recycle",
  });

  await db.insert(scheduledMessages).values([messageRow("scheduled-closing", closingTaskId, closingText)]);
  await pending.deliverPendingMessages(closingTaskId);
  await waitFor(() => closingAttempts === 1, "这一档的前提是真的尝试送过一次并被拒收");
  await new Promise((resolve) => setTimeout(resolve, 150));

  const rejected = (await db.select().from(scheduledMessages)
    .where(eq(scheduledMessages.id, "scheduled-closing"))).at(0)!;
  assert.equal(rejected.status, "pending", "调度台一个字都没收下,这条却被标成 sent —— 它从此从托盘里消失,再没人补送");
  assert.equal(rejected.sentAt, null, "没送出去的消息不得记 sentAt");
  assert.equal(rejected.deliveringSince, null, "拒收之后必须把租约还回去,否则这条永远卡在「正在投递」");
  assert.match(readFileSync(closingMd, "utf8"), /没能送进调度台进程/, "拒收必须持久可见,不能只弹个 toast");
  assert.equal(
    countIn(closingMd, closingText),
    0,
    "被拒的那一次就把原文当成「用户已经说过」落了盘 —— 下一台补送时同一句话会在会话里出现两遍",
  );

  releaseClosing(); // 旧台收台 → closeLead → 落 idle → status 钩子排空托盘
  await waitFor(
    async () => (await db.select().from(scheduledMessages)
      .where(eq(scheduledMessages.id, "scheduled-closing"))).at(0)!.status === "sent",
    "换上一台健康调度台之后仍然没人补送这条 —— 用户预定的指令永久不执行",
  );
  await waitFor(() => countIn(closingMd, closingText) > 0, "补送成功了,原话却没落进会话时间线");
  await waitFor(() => !team.teamIsLive(closingTaskId), "补送那一台没有收台");
  await new Promise((resolve) => setTimeout(resolve, 200)); // 让可能的第二次投递自己冒出来
  const resent = (await db.select().from(scheduledMessages)
    .where(eq(scheduledMessages.id, "scheduled-closing"))).at(0)!;
  assert.ok(resent.sentAt, "补送成功必须记 sentAt");
  assert.equal(countIn(leadLog, closingText), 1, "补送必须恰好一次 —— 送两遍等于调度者被同一条指令支使两回");
  assert.equal(countIn(closingMd, closingText), 1, "同一句话在会话时间线里落了不止一遍");
  console.log("✓ 调度台收尾窗口拒收:行留在 pending + 租约清空,下一台接手时恰好补送一次");

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
  // 真实结算钩子触发补送时单飞锁仍在；这里锁住复现，防止消息被提前标 sent。
  assert.equal(runs.claimTurn(lockedTaskId), true, "测试自身前提:这一轮的锁应该抢得到");
  await status.setTaskStatus(lockedTaskId, "done");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    (await db.select().from(sessions).where(eq(sessions.taskId, lockedTaskId))).length,
    0,
    "锁还锁着就不该起下一轮(会跟当前这一轮撞在一起)",
  );
  // 等待只活在内存里，因此数据库行必须保持 pending，供重启后的扫描补送。
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
  assert.equal(
    (await db.select({ resumePrompt: tasks.resumePrompt }).from(tasks)
      .where(eq(tasks.id, lockedTaskId))).at(0)?.resumePrompt,
    null, "排队真人消息真正送进会话时必须消费旧检查点，不能继续阻塞完成与预约派审",
  );
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

  // ── 引导会话:默认排队,点按钮后在同一 Claude 进程里 interrupt + send ───────
  const oldRun = orchestrator.continueTask(steerTaskId, "保持运行等待引导");
  await waitFor(() => runs.isRunning(steerTaskId), "旧方向的一次性回合没有进入 running");
  await waitFor(() => agentEvents.some(({ taskId, event }) => taskId === steerTaskId && event.text?.includes("旧方向最后一段正文")), "旧方向正文尚未到达消费层");
  await db.update(tasks).set({
    completeConfirmedAt: at,
    resumePrompt: "旧方向留下的续跑指令",
    question: "旧方向留下的问题",
    questionOptions: JSON.stringify(["旧答案"]),
  }).where(eq(tasks.id, steerTaskId));
  runs.confirmDone(steerTaskId); // 旧方向刚拿到的完成票也不能穿进新方向
  await db.insert(scheduledMessages).values(
    messageRow("scheduled-steer", steerTaskId, "先停下旧方案，改做更稳妥的新方向", "queued"),
  );
  const statusEventStart = statusEvents.length;
  const agentEventStart = agentEvents.length;

  const steered = await steer.steerQueuedMessage("scheduled-steer");
  assert.equal(steered.ok, true, "活动单飞回合上的 queued 消息应能升级为引导");
  assert.equal(await oldRun, true, "旧回合应由原 run loop 完整接管并受控收口");
  const steeringAgentEvents = agentEvents.slice(agentEventStart).filter((event) => event.taskId === steerTaskId);
  assert.equal(
    steeringAgentEvents.some(({ event }) => event.kind === "done" && (event.exitStatus ?? 0) !== 0),
    false,
    "原生引导的中间 interrupt 不得向 SSE 发布红色 done 边界",
  );
  assert.equal(
    steeringAgentEvents.some(({ event }) => event.kind === "system" && event.text?.includes("当前回合已由")),
    false,
    "原生引导不应伪装成旧回合结束后重启",
  );
  const steeringStatuses = statusEvents.slice(statusEventStart).filter((event) => event.taskId === steerTaskId);
  assert.equal(steeringStatuses.filter((event) => event.status !== "running").length, 1,
    `同一活动回合只允许最终结算一次，实际事件：${JSON.stringify(steeringStatuses)}`);
  const steeredMessage = (await db.select().from(scheduledMessages)
    .where(eq(scheduledMessages.id, "scheduled-steer"))).at(0)!;
  assert.equal(steeredMessage.status, "sent", "新方向真正落进会话后才标 sent");
  assert.equal(steeredMessage.deliveringSince, null, "成功引导后应清掉投递租约");
  const steeredTask = (await db.select().from(tasks).where(eq(tasks.id, steerTaskId))).at(0)!;
  assert.equal(steeredTask.completeConfirmedAt, null, "旧方向的完成确认不得污染新方向");
  assert.equal(steeredTask.resumePrompt, null, "旧方向的 pause 指令不得污染新方向");
  assert.equal(steeredTask.question, null, "旧方向的提问不得污染新方向");
  assert.equal(runs.takeConfirmed(steerTaskId), false, "旧方向的内存完成票也应清掉");
  const steerTranscript = transcript.sessionTranscriptPath(steerTaskId, "scheduled-steer-session");
  await waitFor(
    () => existsSync(steerTranscript)
      && readFileSync(steerTranscript, "utf8").includes("先停下旧方案，改做更稳妥的新方向"),
    "引导消息没有落回旧 CLI 会话对应的同一条 session 时间线",
  );
  assert.match(readFileSync(steerTranscript, "utf8"), /先停下旧方案，改做更稳妥的新方向/,
    "引导消息应落回旧 CLI 会话对应的同一条 session 时间线");
  assert.doesNotMatch(readFileSync(steerTranscript, "utf8"), /当前回合已由“引导会话”结束/,
    "原生引导不应写入一次假的回合结束边界");
  const steeredOutput = parseSessionOutput(readFileSync(steerTranscript, "utf8"));
  const steeredUser = steeredOutput.find((segment) => segment.kind === "user" && segment.text.includes("先停下旧方案"));
  assert.ok(steeredUser?.at, "引导消息必须带精确用户边界时间");
  const steerTrace = transcript.parseSessionTrace(
    readFileSync(transcript.sessionTracePath(steerTaskId, "scheduled-steer-session"), "utf8"),
  );
  const oldTextTrace = steerTrace.find((entry) => entry.event.kind === "text" && entry.event.text.includes("旧方向最后一段正文"));
  assert.ok(oldTextTrace, "旧方向最后一段正文必须进入结构化 trace");
  assert.ok(Date.parse(oldTextTrace.at) < Date.parse(steeredUser!.at!), "旧方向正文必须在用户边界前 flush");
  await waitFor(
    async () => {
      const current = (await db.select().from(tasks).where(eq(tasks.id, steerTaskId))).at(0)!;
      return current.status !== "running" && current.status !== "queued";
    },
    "引导出去的新回合没有结算",
  );
  console.log("✓ 引导会话:Claude 同进程 interrupt + send,清旧状态并在落盘后标 sent");

  // 活动 handle 不存在(启动缝隙/刚好结束)时不谎报成功，更不能把消息从队列拿走。
  const unavailableSteer = await steer.steerQueuedMessage("scheduled-steer-unavailable");
  assert.equal(unavailableSteer.ok, false, "没有可控活动进程时应拒绝升级");
  if (!unavailableSteer.ok) {
    assert.match(unavailableSteer.error, /启动|结束|引导/, "无活动回合不得误报成审查或旁路");
    assert.doesNotMatch(unavailableSteer.error, /审查|旁路/);
  }
  const retained = (await db.select().from(scheduledMessages)
    .where(eq(scheduledMessages.id, "scheduled-steer-unavailable"))).at(0)!;
  assert.equal(retained.status, "pending", "升级失败的消息必须继续留在队列");
  assert.equal(retained.deliveringSince, null, "升级失败必须归还投递租约,允许稍后重试");
  const retainedTaskState = (await db.select().from(tasks).where(eq(tasks.id, steerUnavailableTaskId))).at(0)!;
  assert.equal(retainedTaskState.completeConfirmedAt, at, "没有活动 handle 时不得提前清掉旧回合完成票");
  assert.equal(retainedTaskState.resumePrompt, "仍属于当前回合的检查点", "失败点击不得清掉检查点");
  assert.equal(retainedTaskState.question, "仍属于当前回合的问题", "失败点击不得清掉提问");
  console.log("✓ 引导会话失败:消息保持 pending 并归还租约");

  // 旧回合已跳过结算、但新回合被验收锁挡回：任务必须离开假 running，消息仍 pending。
  const lockedOldRun = orchestrator.continueTask(steerLockedTaskId, "保持运行等待引导");
  await waitFor(() => runs.isRunning(steerLockedTaskId), "验收锁复现的旧回合没有进入 running");
  await db.insert(scheduledMessages).values(
    messageRow("scheduled-steer-locked", steerLockedTaskId, "验收结束后再执行这条新方向", "queued"),
  );
  assert.equal(acceptance.beginAccepting(steerLockedTaskId), true, "测试前提:验收锁应能占住");
  const lockedSteer = await steer.steerQueuedMessage("scheduled-steer-locked");
  acceptance.endAccepting(steerLockedTaskId);
  assert.equal(lockedSteer.ok, false, "续送被验收锁挡回应如实失败");
  assert.equal(runs.isRunning(steerLockedTaskId), true, "验收挡回不应强行切断当前原生回合");
  const lockedSteerMessage = (await db.select().from(scheduledMessages)
    .where(eq(scheduledMessages.id, "scheduled-steer-locked"))).at(0)!;
  assert.equal(lockedSteerMessage.status, "pending", "续送失败的原话必须继续排队");
  assert.equal(lockedSteerMessage.deliveringSince, null, "续送失败应在落位后归还租约");
  assert.equal(runs.stopTask(steerLockedTaskId), true);
  assert.equal(await lockedOldRun, true);
  console.log("✓ 引导被验收挡回:当前回合不断线，原话保留并归还租约");

  // 真引导成功后新方向仍在跑：旧回合迟到的 ask_question（旧 token 或无 token）都不能写入。
  const lateOldRun = orchestrator.continueTask(steerLateTaskId, "保持运行等待引导");
  await waitFor(() => runs.isRunning(steerLateTaskId), "迟到工具复现的旧回合没有进入 running");
  const oldTurnToken = (await db.select().from(tasks).where(eq(tasks.id, steerLateTaskId))).at(0)!.activeTurnToken!;
  await db.insert(scheduledMessages).values(
    messageRow("scheduled-steer-late", steerLateTaskId, "保持新方向运行", "queued"),
  );
  assert.equal((await steer.steerQueuedMessage("scheduled-steer-late")).ok, true, "迟到工具复现应先成功引导");
  const newTurnToken = (await db.select().from(tasks).where(eq(tasks.id, steerLateTaskId))).at(0)!.activeTurnToken!;
  assert.equal(newTurnToken, oldTurnToken, "原生引导仍属于同一个活动回合，必须保留 turn token");
  const api = new Hono();
  runRoutes.mountTaskRunRoutes(api);
  const currentAsk = await api.request(`/tasks/${steerLateTaskId}/ask`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ash-turn-token": oldTurnToken },
    body: JSON.stringify({ question: "current question after native steer" }),
  });
  assert.equal(currentAsk.status, 200, "同一进程后续工具调用必须继续使用原 turn token");
  await db.update(tasks).set({ question: null, questionOptions: null, questionItems: null })
    .where(eq(tasks.id, steerLateTaskId));
  assert.equal(
    (await db.select().from(tasks).where(eq(tasks.id, steerLateTaskId))).at(0)!.question,
    null,
    "测试收尾前应清掉问题卡",
  );
  assert.equal(runs.stopTask(steerLateTaskId), true, "测试收尾应停止挂起的新方向");
  assert.equal(await lateOldRun, true);
  await waitFor(async () => (await db.select().from(tasks).where(eq(tasks.id, steerLateTaskId))).at(0)!.status !== "running",
    "挂起的新方向没有完成停止结算");
  console.log("✓ 原生引导保留 turn token，同一进程的后续工具调用仍然有效");

  // ── 进程死在投递中途:重启后必须自己回来 ──────────────────────────────────
  // 上一段证明了「锁挡回不丢消息」,但锁不是唯一能掐断投递的东西 —— 服务重启会把内存里
  // 的等待/在途标记连根拔掉。所以「有人正在送」必须**落库**成一个可回收的租约,而不是
  // 提前把状态改成 sent:后者一断电就是一条永远没人管的 sent 行(2026-08-07 那条就是)。
  await db.insert(scheduledMessages).values([
    messageRow("scheduled-crashed", crashTaskId, "重启也不许弄丢这句话", "queued"),
  ]);
  const crash = spawnSync(process.execPath, [...process.execArgv, selfPath], {
    env: { ...process.env, ASH_TEST_CRASH_MESSAGE: "scheduled-crashed" },
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
  delete process.env.ASH_TEST_LEAD_LOG;
  rmSync(join(paths.RUNS_DIR, deliveredTaskId), { recursive: true, force: true });
  rmSync(join(paths.RUNS_DIR, unavailableTaskId), { recursive: true, force: true });
  rmSync(join(paths.RUNS_DIR, closingTaskId), { recursive: true, force: true });
  rmSync(join(paths.RUNS_DIR, queuedTaskId), { recursive: true, force: true });
  rmSync(join(paths.RUNS_DIR, lockedTaskId), { recursive: true, force: true });
  rmSync(join(paths.RUNS_DIR, crashTaskId), { recursive: true, force: true });
  rmSync(join(paths.RUNS_DIR, steerTaskId), { recursive: true, force: true });
  rmSync(join(paths.RUNS_DIR, steerUnavailableTaskId), { recursive: true, force: true });
  rmSync(join(paths.RUNS_DIR, steerLockedTaskId), { recursive: true, force: true });
  rmSync(join(paths.RUNS_DIR, steerLateTaskId), { recursive: true, force: true });
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
