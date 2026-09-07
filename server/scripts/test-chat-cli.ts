import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_TYPES } from "@ash/shared";
import type { ChatMember } from "@ash/shared/chat";

if (process.env.ASH_CHAT_SMOKE !== "1") throw new Error("此测试调用真实 CLI；显式设置 ASH_CHAT_SMOKE=1 后运行。");
const agentType = process.argv[2] ?? "codex";
if (!AGENT_TYPES.includes(agentType as ChatMember["agentType"])) throw new Error("未知智能体类型。");
const stage = mkdtempSync(join(tmpdir(), "ash-chat-cli-"));
process.env.ASH_DB = join(stage, "test.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
process.env.ASH_ALLOW_REAL_AGENT = "1";
const { ensureSchema, dbClient } = await import("../src/db/index.js");
const { invokeChat } = await import("../src/chat/execution.js");
const { chatPrompt, parseChatReply } = await import("../src/chat/prompt.js");
await ensureSchema();
const member: ChatMember = { id: agentType, name: agentType, agentType: agentType as ChatMember["agentType"], executorId: null, model: null, reasoningEffort: null };
try {
  const answer = parseChatReply(await invokeChat(member, null, chatPrompt(member, [], `@${agentType} 用一句话说明群聊先点名再回复的好处。这是咨询，不要创建任务，不使用工具。`), AbortSignal.timeout(120000)));
  assert.equal(answer.task, null);
  assert.ok(answer.reply.length > 0 && answer.reply.length <= 300);
  console.log(`${agentType} real CLI chat passed: ${answer.reply}`);
} finally {
  dbClient.close();
  rmSync(stage, { recursive: true, force: true });
}
