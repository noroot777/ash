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

const [{ db, ensureSchema }, schema, schedulesModule, transcript, paths] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/schedules.js"),
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
const unavailableSessionId = "scheduled-team-unavailable-session";
const unavailableTranscript = transcript.sessionTranscriptPath(unavailableTaskId, unavailableSessionId);

const taskRow = (id: string, lead: "claude" | "codex", status: "idle" | "running") => ({
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

const messageRow = (id: string, taskId: string, text: string) => ({
  id,
  taskId,
  text,
  attachments: "[]",
  agent: null,
  sendAt: dueAt,
  status: "pending",
  createdAt: at,
  sentAt: null,
});

const waitFor = async (predicate: () => boolean, message: string) => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

try {
  await db.insert(projects).values({ id: projectId, name: "scheduled", repoPath: root, apiKeys: null, createdAt: at });
  await db.insert(tasks).values([
    taskRow(deliveredTaskId, "claude", "running"),
    taskRow(unavailableTaskId, "codex", "idle"),
  ]);
  await db.insert(sessions).values({
    id: unavailableSessionId,
    taskId: unavailableTaskId,
    role: "lead",
    agentType: "codex",
    executor: "codex@test",
    target: "local",
    cwd: root,
    startedAt: at,
  });
  mkdirSync(dirname(unavailableTranscript), { recursive: true });
  await db.insert(scheduledMessages).values([
    messageRow("scheduled-delivered", deliveredTaskId, "团队定时消息到期"),
    messageRow("scheduled-unavailable", unavailableTaskId, "这条消息应安全取消"),
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
} finally {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  delete process.env.HARNESS_TEST_LEAD_LOG;
  rmSync(join(paths.RUNS_DIR, deliveredTaskId), { recursive: true, force: true });
  rmSync(join(paths.RUNS_DIR, unavailableTaskId), { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
