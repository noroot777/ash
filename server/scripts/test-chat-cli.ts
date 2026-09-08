import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_TYPES } from "@ash/shared";
import type { ChatMember } from "@ash/shared/chat";

if (process.env.ASH_CHAT_SMOKE !== "1") throw new Error("此测试调用真实 CLI；显式设置 ASH_CHAT_SMOKE=1 后运行。");
const agentType = process.argv[2] ?? "claude";
if (!AGENT_TYPES.includes(agentType as ChatMember["agentType"])) throw new Error("未知智能体类型。");
const stage = mkdtempSync(join(tmpdir(), "ash-chat-cli-"));
const projectDir = join(stage, "project");
mkdirSync(projectDir);
const marker = `chat-read-${randomUUID()}`;
writeFileSync(join(projectDir, "chat-context.txt"), marker);
process.env.ASH_DB = join(stage, "test.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
process.env.ASH_ALLOW_REAL_AGENT = "1";
const { db, ensureSchema, dbClient } = await import("../src/db/index.js");
const { projects } = await import("../src/db/schema.js");
const { invokeChat } = await import("../src/chat/execution.js");
const { chatPrompt, parseChatReply } = await import("../src/chat/prompt.js");
const { summaryPrompt, parseChatSummary } = await import("../src/chat/context-format.js");
await ensureSchema();
await db.insert(projects).values({ id: "chat-cli", name: "读取测试", repoPath: projectDir, createdAt: new Date().toISOString() });
const member: ChatMember = { id: agentType, name: agentType, agentType: agentType as ChatMember["agentType"], executorId: null, model: null, reasoningEffort: null };
try {
  if (process.argv.includes("--summary")) {
    const prompt = summaryPrompt("用户已确认采用方案 ALPHA，兼容性还未验证。", [JSON.stringify({ role: "user", author: "用户", body: `本次唯一验收编号是 ${marker}，后续摘要保留这个完整编号。我只授权讨论，没有授权部署。` })], 2000);
    const summary = parseChatSummary((await invokeChat(member, null, prompt, AbortSignal.timeout(120000), "chat-cli", { purpose: "summary" })).text, 2000);
    assert.ok(summary.includes(marker));
    assert.ok(summary.includes("ALPHA"));
    console.log(`${agentType} real CLI summary passed: JSON 格式、随机验收编号与已有决定保留，未调用工具。`);
  } else {
    const answer = parseChatReply((await invokeChat(member, null, chatPrompt(member, [], `@${agentType} 请读取当前项目的 chat-context.txt，在 reply 中原样回复文件内容。这是只读咨询，不修改文件、不创建任务。`), AbortSignal.timeout(120000), "chat-cli")).text);
    assert.equal(answer.task, null);
    assert.ok(answer.reply.length > 0 && answer.reply.length <= 300);
    assert.ok(answer.reply.includes(marker), "必须实际读取文件，标记不在 prompt 里");
    console.log(`${agentType} real CLI chat passed: ${answer.reply}`);
  }
  assert.equal(readFileSync(join(projectDir, "chat-context.txt"), "utf8"), marker);
} finally {
  dbClient.close();
  rmSync(stage, { recursive: true, force: true });
}
