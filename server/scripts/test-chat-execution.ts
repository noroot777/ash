import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_TYPES, type AgentEvent } from "@ash/shared";
import type { ChatMember } from "@ash/shared/chat";

const stage = mkdtempSync(join(tmpdir(), "ash-chat-execution-"));
process.env.ASH_DB = join(stage, "test.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
const projectDir = join(stage, "project");
mkdirSync(projectDir);
writeFileSync(join(projectDir, "chat-context.txt"), "来自当前项目的建议依据");
const { db, ensureSchema, dbClient } = await import("../src/db/index.js");
const { projects, agents } = await import("../src/db/schema.js");
const { setInstanceMode } = await import("../src/auth/mode.js");
const { CLI_SPEC_BY_KEY } = await import("../src/executors/catalog/index.js");
const { invokeChat } = await import("../src/chat/execution.js");
const { chatPrompt, parseChatReply } = await import("../src/chat/prompt.js");
await ensureSchema();
await setInstanceMode("single", stage);
const createdAt = new Date().toISOString();
await db.insert(projects).values([
  { id: "project", name: "当前项目", repoPath: projectDir, createdAt },
  { id: "no-directory", name: "无目录项目", repoPath: "", createdAt },
]);
await db.insert(agents).values(AGENT_TYPES.map((type) => ({ id: `profile-${type}`, type, name: type, model: "profile-model", extraArgs: '["--fixture-option"]', createdAt })));
const originals = new Map(AGENT_TYPES.map((type) => [type, CLI_SPEC_BY_KEY[type].factory]));
let starts = 0;
let killed = 0;
let cleaned = 0;
let lastCwd = "";
let fail = false;
try {
  for (const type of AGENT_TYPES) {
    CLI_SPEC_BY_KEY[type].factory = (built) => ({
      type, label: type, model: built.model,
      resumeCommand: () => "",
      run: (opts) => {
        starts++;
        lastCwd = opts.cwd;
        assert.equal(built.model, "chat-model");
        assert.deepEqual(built.extraArgs, ["--fixture-option"]);
        assert.equal(opts.sessionId, undefined);
        for (const key of ["ASH_TASK_ID", "ASH_TURN_TOKEN", "ASH_DIRECTION_TOKEN"]) {
          assert.ok(Object.hasOwn(opts.env!, key));
          assert.equal(opts.env![key], undefined);
        }
        return {
          sessionId: "fixture", commandLine: "fixture",
          kill: () => { killed++; }, cleanup: async () => { cleaned++; },
          events: (async function* (): AsyncGenerator<AgentEvent> {
            if (fail) throw new Error("fixture read failed");
            yield { kind: "text", text: "先查看当前项目。" };
            const file = join(opts.cwd, "chat-context.txt");
            const evidence = existsSync(file) ? readFileSync(file, "utf8") : "未配置目录";
            yield { kind: "tool", name: "Read", detail: file };
            yield { kind: "text", text: JSON.stringify({ reply: evidence, task: null }) };
            yield { kind: "done", exitStatus: 0 };
          })(),
        };
      },
    });
    const member: ChatMember = { id: type, name: type, agentType: type, executorId: `profile-${type}`, model: "chat-model", reasoningEffort: null };
    const prompt = chatPrompt(member, [], `@${type} 请查看文件后给建议`);
    assert.match(prompt, /可以使用现有工具读取当前项目文件/);
    assert.match(prompt, /不要在聊天回合修改文件/);
    const result = parseChatReply(await invokeChat(member, null, prompt, new AbortController().signal, "project"));
    assert.deepEqual(result, { reply: "来自当前项目的建议依据", task: null });
    assert.equal(lastCwd, projectDir);
    assert.ok(existsSync(projectDir));
  }
  assert.equal(starts, AGENT_TYPES.length);
  assert.equal(cleaned, starts);
  assert.equal(killed, starts);
  const member: ChatMember = { id: "codex", name: "codex", agentType: "codex", executorId: "profile-codex", model: "chat-model", reasoningEffort: null };
  const signal = new AbortController().signal;
  await invokeChat(member, null, "未配置目录的咨询", signal, "no-directory");
  assert.notEqual(lastCwd, projectDir);
  assert.equal(existsSync(lastCwd), false);
  await assert.rejects(invokeChat(member, null, "咨询", signal, "missing"), /项目不存在/);
  const aborted = new AbortController();
  aborted.abort(new Error("已停止"));
  const beforeAbort = starts;
  await assert.rejects(invokeChat(member, null, "咨询", aborted.signal, "project"), /已停止/);
  assert.equal(starts, beforeAbort);
  fail = true;
  await assert.rejects(invokeChat(member, null, "咨询", signal, "project"), /fixture read failed/);
  assert.ok(existsSync(projectDir));
  assert.equal(cleaned, starts);
  await setInstanceMode("multi", join(stage, "users"));
  const { createUser } = await import("../src/auth/store.js");
  const user = await createUser({ name: "alice", role: "member", dirName: "alice", gitName: "alice", gitEmail: "alice@example.test", createdBy: null });
  const beforeDenied = starts;
  await assert.rejects(invokeChat(member, user.id, "咨询", signal, "project"), /失去访问权限/);
  assert.equal(starts, beforeDenied);
  console.log(`chat execution: ${AGENT_TYPES.length} 类执行器均使用原 run 通道，保留模型与参数；工具事件不中断回复；当前项目可读且不被清理；撤权/停止不启动进程`);
} finally {
  for (const [type, factory] of originals) CLI_SPEC_BY_KEY[type].factory = factory;
  dbClient.close();
  rmSync(stage, { recursive: true, force: true });
}
