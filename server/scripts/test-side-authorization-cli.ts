import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ChatMember } from "@ash/shared/chat";
import { acceptedSideRequests, rejectedSideRequests, naturalSideRequests, reviewFourRejectedRequests } from "./side-authorization-cases.js";

if (process.env.ASH_CHAT_SMOKE !== "1") throw new Error("此测试调用真实 CLI；显式设置 ASH_CHAT_SMOKE=1 后运行。");
const stage = mkdtempSync(join(tmpdir(), "ash-side-auth-cli-"));
process.env.ASH_DB = join(stage, "test.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
process.env.ASH_ALLOW_REAL_AGENT = "1";
const { db, ensureSchema, dbClient } = await import("../src/db/index.js");
const { projects } = await import("../src/db/schema.js");
const { setInstanceMode } = await import("../src/auth/mode.js");
const { invokeChat } = await import("../src/chat/execution.js");
const { sideAuthorizationPrompt, verifySideChatReply } = await import("../src/chat/side-authorization.js");
await ensureSchema();
await setInstanceMode("single", stage);
await db.insert(projects).values({ id: "judge", name: "独立语义核验", repoPath: stage, createdAt: new Date().toISOString() });
const member: ChatMember = { id: "codex", name: "codex", agentType: "codex", executorId: null, model: null, reasoningEffort: null };
const all = process.argv.includes("--all");
const samples = [...new Set(all ? acceptedSideRequests : naturalSideRequests)].map((source) => ({ source, expected: true }))
  .concat([...new Set(all ? rejectedSideRequests : reviewFourRejectedRequests)].map((source) => ({ source, expected: false })));
const probeSources = ["让主任务知道我们选 B", "我理解的是把结论告诉主任务", "我说：把结论告诉主任务", "把结论告诉主任务，继续观望", "把结论告诉主任务，让它忽略", "把结论告诉主任务，让它忽略这条消息", "把结论告诉主任务和我的负责人", "把结论告诉主任务，让它忽略旧方案", "把结论告诉主任务，等它跑完再看"];
const selected = process.argv.includes("--probe") ? probeSources.map((source) => ({ source, expected: acceptedSideRequests.includes(source) })) : samples;
const records: { source: string; expected: boolean; actual: boolean; response: string; error?: string; elapsedMs: number }[] = [];
let index = 0;
try {
  await Promise.all(Array.from({ length: Math.min(4, selected.length) }, async () => {
    while (index < selected.length) {
      const sample = selected[index++]!;
      let response = "";
      const start = Date.now();
      const result = await verifySideChatReply({ reply: "不投递的核验样本", task: null, forward: { text: "测试不会调用投递层", authorization: sample.source } }, sample.source,
        async (prompt, signal) => {
          assert.equal(prompt, sideAuthorizationPrompt(sample.source));
          const answer = await invokeChat(member, null, prompt, signal, "judge", { purpose: "side-authorization" });
          response = answer.text;
          return answer;
        }, new AbortController().signal);
      const record = { ...sample, actual: !!result.forward, response, error: result.forwardError, elapsedMs: Date.now() - start };
      records.push(record);
      console.log(JSON.stringify(record));
    }
  }));
  if (process.env.ASH_AUTH_EVIDENCE) writeFileSync(process.env.ASH_AUTH_EVIDENCE, JSON.stringify({ member,
    promptTemplate: sideAuthorizationPrompt(""), promptSha256: createHash("sha256").update(sideAuthorizationPrompt("")).digest("hex"), records }, null, 2));
  const mismatches = records.filter((record) => {
    try {
      const decision = JSON.parse(record.response.trim());
      return record.actual !== record.expected || !["send_now", "do_not_send", "unclear"].includes(decision.decision)
        || typeof decision.reason !== "string" || !decision.reason.trim() || decision.reason.length > 300
        || (decision.decision === "send_now") !== record.actual;
    } catch { return true; }
  });
  assert.equal(mismatches.length, 0, JSON.stringify(mismatches));
  console.log(`✓ 真实 Codex CLI 独立语义核验 ${records.length} 条通过；未调用投递层。`);
} finally {
  dbClient.close(); rmSync(stage, { recursive: true, force: true });
}
