import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import type { ChatMember } from "@ash/shared/chat";

if (process.env.ASH_ALLOW_REAL_AGENT !== "1") throw new Error("此验证会调用真实 Claude；请设置 ASH_ALLOW_REAL_AGENT=1 后运行。");
const rounds = Number(process.env.ASH_ASSISTANT_LIVE_ROUNDS ?? 8);
assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 10);
const stage = mkdtempSync(join(tmpdir(), "ash-assistant-live-"));
process.env.ASH_DB = join(stage, "test.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
const { agents, chatMessages, chatRooms, projects, tasks } = await import("../src/db/schema.js");
const { ChatService } = await import("../src/chat/service.js");
const { invokeChat, AssistantToolError } = await import("../src/chat/execution.js");
const { parseLastJsonObject } = await import("../src/chat/json-object.js");
const { setInstanceMode } = await import("../src/auth/mode.js");
await ensureSchema();
await setInstanceMode("single", stage);
let toolErrors = 0;
let retries = 0;
const service = new ChatService(async (...args) => {
  if (args[2].includes("【工具调用重试】")) retries++;
  try {
    const response = await invokeChat(...args);
    if (!parseLastJsonObject(response.text)) console.error("Claude non-JSON response:", response.text.slice(0, 1500));
    return response;
  }
  catch (error) { if (error instanceof AssistantToolError) toolErrors++; throw error; }
}, async () => { throw new Error("答疑、搜索和起手式草案不应启动任务"); });
const timestamp = new Date().toISOString();
const member: ChatMember = {
  id: "claude", name: "助手", agentType: "claude", executorId: "claude-live",
  model: process.env.ASH_ASSISTANT_LIVE_MODEL ?? "sonnet", reasoningEffort: null,
};

try {
  await db.insert(agents).values({ id: member.executorId!, name: "Claude live", type: "claude", createdAt: timestamp });
  await db.insert(projects).values({ id: "live-project", name: "账户中心", repoPath: stage, createdAt: timestamp });
  await db.insert(tasks).values({ id: "live-auth-task", projectId: "live-project", title: "登录认证重构", body: "统一登录与用户认证流程", status: "done", archived: true, createdAt: timestamp, updatedAt: timestamp });
  const cases = [
    { kind: "help", text: "任务显示失败，但智能体说已经做完了，该怎么排查？" },
    { kind: "search", text: "帮我找之前做登录或认证的任务，记不清在哪个项目了。" },
    ...Array.from({ length: rounds }, () => ({ kind: "workflow", text: "帮我搭一个起手式：写完代码后跑构建和测试，等我确认再合并。" })),
  ];
  for (const [index, sample] of cases.entries()) {
    const [room] = await db.insert(chatRooms).values({ id: `live-room-${index}`, kind: "assistant", name: "真实 CLI 验证", projectId: "", members: JSON.stringify([member]), createdAt: timestamp }).returning();
    await service.send(room!, sample.text, `live-message-${index}`, "验证用户");
    const deadline = Date.now() + 240000;
    for (;;) {
      const rows = await db.select().from(chatMessages).where(eq(chatMessages.roomId, room!.id));
      const answer = rows.find((message) => message.role === "agent");
      if (answer && !["queued", "running"].includes(answer.status)) {
        assert.equal(answer.status, "done", `${sample.kind}: ${answer.body}`);
        assert.equal(answer.taskId, null);
        const result = JSON.parse(answer.assistant!);
        if (sample.kind === "workflow") assert.ok(result.workflow?.def.steps.some((step: { kind: string }) => step.kind === "human"), answer.body);
        if (sample.kind === "search") assert.ok(result.matches.some((match: { taskId: string }) => match.taskId === "live-auth-task"), answer.body);
        console.log(`✓ Claude ${sample.kind} ${index + 1}/${cases.length}: ${answer.body.slice(0, 140).replaceAll("\n", " ")}`);
        break;
      }
      assert.ok(Date.now() < deadline, `Claude ${sample.kind} 超时`);
      await delay(250);
    }
  }
  assert.equal(toolErrors, 0);
  assert.equal(retries, 0);
  console.log(`assistant live passed: ${cases.length} 个真实 Claude 回合，无工具事件或工具重试`);
} finally {
  for (const room of await db.select().from(chatRooms)) await service.stop(room.id);
  await delay(100);
  dbClient.close();
  rmSync(stage, { recursive: true, force: true });
}
