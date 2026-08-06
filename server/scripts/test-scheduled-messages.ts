import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { TEAM_DEFAULTS } from "@harness/shared";

const root = mkdtempSync(join(tmpdir(), "harness-scheduled-messages-"));
const fakeBin = join(root, "bin");
const leadLog = join(root, "lead-input.jsonl");
const originalPath = process.env.PATH;
process.env.HARNESS_DB = join(root, "harness.db");
process.env.HARNESS_TEST_LEAD_LOG = leadLog;
process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;

mkdirSync(fakeBin, { recursive: true });
writeFileSync(
  join(fakeBin, "claude"),
  `#!/bin/sh
IFS= read -r line || exit 1
printf '%s\\n' "$line" >> "$HARNESS_TEST_LEAD_LOG"
printf '%s\\n' '{"type":"system","session_id":"scheduled-message-test"}'
printf '%s\\n' '{"type":"result","subtype":"success","session_id":"scheduled-message-test"}'
`,
  { mode: 0o755 },
);

const [{ db, ensureSchema }, schema, schedulesModule, pending, status, transcript, paths] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/schedules.js"),
  import("../src/pending-messages.js"),
  import("../src/status.js"),
  import("../src/transcript.js"),
  import("../src/paths.js"),
]);
const { projects, scheduledMessages, sessions, tasks } = schema;
await ensureSchema();

const now = new Date();
const at = now.toISOString();
const dueAt = new Date(now.getTime() - 60_000).toISOString();
const projectId = "scheduled-project";
const deliveredTaskId = "scheduled-team-delivered";
const unavailableTaskId = "scheduled-team-unavailable";
const queuedTaskId = "scheduled-single-queued";
const unavailableSessionId = "scheduled-team-unavailable-session";
const unavailableTranscript = transcript.sessionTranscriptPath(unavailableTaskId, unavailableSessionId);

// 「调度台不可用」这一档必须与本机装了什么 CLI 无关:claude/codex 都实现了常驻会话,
// 装了真 codex 的机器上它会真的开起来。用一个走 GenericCliExecutor 的类型(它们一律
// 不实现 openResident,这正是「谁能当调度者」的过滤条件),失败点就锁死在协议上。
const taskRow = (id: string, lead: "claude" | "gemini", status: "idle" | "running") => ({
  id,
  projectId,
  groupId: null,
  parentId: null,
  title: id,
  body: "验证团队定时消息",
  mode: "team",
  status,
  priority: "none",
  labels: "[]",
  dependsOn: "[]",
  resumeDependsOn: "[]",
  agentType: lead,
  executorId: null,
  autoTitle: false,
  debate: null,
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
});

const waitFor = async (predicate: () => boolean | Promise<boolean>, message: string) => {
  const deadline = Date.now() + 3000;
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
  pending.deliveryVerdict({ mode: "timed", sendAt: dueAt }, { mode: "debate", status: "done", archived: false }, now)
    .action,
  "cancel",
  "辩论任务不支持回复,等下去也没意义",
);
console.log("✓ 投递判定:排队不看时间但等任务空闲,定时看时间,忙=等而不是取消");

try {
  await db.insert(projects).values({ id: projectId, name: "scheduled", repoPath: root, apiKeys: null, createdAt: at });
  await db.insert(tasks).values([
    taskRow(deliveredTaskId, "claude", "running"),
    taskRow(unavailableTaskId, "gemini", "idle"),
    { ...taskRow(queuedTaskId, "claude", "running"), mode: "single", team: null },
  ]);
  await db.insert(sessions).values({
    id: unavailableSessionId,
    taskId: unavailableTaskId,
    role: "lead",
    agentType: "gemini",
    executor: "gemini@test",
    target: "local",
    cwd: root,
    startedAt: at,
  });
  mkdirSync(dirname(unavailableTranscript), { recursive: true });
  await db.insert(scheduledMessages).values([
    messageRow("scheduled-delivered", deliveredTaskId, "团队定时消息到期"),
    messageRow("scheduled-unavailable", unavailableTaskId, "这条消息应安全取消"),
    messageRow("scheduled-queued", queuedTaskId, "排队追问:等这一轮跑完再发", "queued"),
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

  console.log("✓ 团队定时消息到期后进入 lead 常驻会话并标记 sent");
  console.log("✓ lead 不可用时消息安全取消并把原因写入时间线");

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
  await waitFor(
    async () => (await db.select().from(scheduledMessages)
      .where(eq(scheduledMessages.id, "scheduled-queued"))).at(0)!.status === "sent",
    "任务落终态后排队消息没有被立刻发出(status 钩子没接上?)",
  );
  await waitFor(
    async () => (await db.select().from(sessions).where(eq(sessions.taskId, queuedTaskId))).length > 0,
    "排队消息标记 sent 了却没真的送进任务会话",
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
  console.log("✓ 排队追问:运行中原地等待,任务一空闲立即投递进原会话");
} finally {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  delete process.env.HARNESS_TEST_LEAD_LOG;
  rmSync(join(paths.RUNS_DIR, deliveredTaskId), { recursive: true, force: true });
  rmSync(join(paths.RUNS_DIR, unavailableTaskId), { recursive: true, force: true });
  rmSync(join(paths.RUNS_DIR, queuedTaskId), { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
