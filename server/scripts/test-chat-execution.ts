import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { AGENT_TYPES, type AgentEvent } from "@ash/shared";
import type { ChatMember } from "@ash/shared/chat";

const stage = mkdtempSync(join(tmpdir(), "ash-chat-execution-"));
// repoPath 存的是用户写的原样，`~/…` 只有展开后才是真目录。要如实测这一步，家目录下就得
// 真有一个目录；用完在 finally 里删掉。
const homeProject = mkdtempSync(join(homedir(), ".ash-chat-home-"));
const homeProjectName = basename(homeProject);
writeFileSync(join(homeProject, "chat-context.txt"), "来自家目录项目的建议依据");
process.env.ASH_DB = join(stage, "test.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
const projectDir = join(stage, "project");
mkdirSync(projectDir);
writeFileSync(join(projectDir, "chat-context.txt"), "来自当前项目的建议依据");
const { db, ensureSchema, dbClient } = await import("../src/db/index.js");
const { projects, agents, tasks, sessions } = await import("../src/db/schema.js");
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
  { id: "home-directory", name: "写成 ~ 的项目", repoPath: `~/${homeProjectName}`, createdAt },
  { id: "missing-directory", name: "目录已不在的项目", repoPath: join(stage, "已经被删掉的目录"), createdAt },
]);
await db.insert(agents).values(AGENT_TYPES.map((type) => ({ id: `profile-${type}`, type, name: type, model: "profile-model", extraArgs: '["--fixture-option"]', createdAt })));
const originals = new Map(AGENT_TYPES.map((type) => [type, CLI_SPEC_BY_KEY[type].factory]));
let starts = 0;
let killed = 0;
let cleaned = 0;
let lastCwd = "";
let fail = false;
let writeFromMain = false;
let sideWriteTool = false;
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
        assert.deepEqual(opts.extraArgs, type === "claude" && (opts.prompt.includes("ASSISTANT_FIXTURE") || opts.prompt.includes("AUTHORIZATION_FIXTURE"))
          ? ["--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands", "--no-chrome"] : undefined);
        for (const key of ["ASH_TASK_ID", "ASH_TURN_TOKEN", "ASH_DIRECTION_TOKEN"]) {
          assert.ok(Object.hasOwn(opts.env!, key));
          assert.equal(opts.env![key], undefined);
        }
        return {
          sessionId: "fixture", commandLine: "fixture",
          kill: () => { killed++; }, cleanup: async () => { cleaned++; },
          events: (async function* (): AsyncGenerator<AgentEvent> {
            if (writeFromMain) writeFileSync(join(opts.cwd, "main-task-change.ts"), "主任务正在正常写入");
            if (sideWriteTool) yield { kind: "tool", name: "Write", detail: join(opts.cwd, "forbidden.ts") };
            if (fail) throw new Error("fixture read failed");
            if (opts.prompt.includes("BACKGROUND_SUMMARY_FIXTURE") || opts.prompt.includes("ASSISTANT_FIXTURE") || opts.prompt.includes("AUTHORIZATION_FIXTURE")) {
              assert.notEqual(opts.cwd, projectDir);
              assert.equal(existsSync(join(opts.cwd, "chat-context.txt")), false);
              yield { kind: "text", text: '{"summary":"已有用户决定与待办事项"}' };
              yield { kind: "done", exitStatus: 0 };
              return;
            }
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
    const result = parseChatReply((await invokeChat(member, null, prompt, new AbortController().signal, "project")).text);
    assert.deepEqual(result, { reply: "来自当前项目的建议依据", task: null });
    assert.equal(lastCwd, projectDir);
    assert.ok(existsSync(projectDir));
  }
  assert.equal(starts, AGENT_TYPES.length);
  assert.equal(cleaned, starts);
  assert.equal(killed, starts);
  const member: ChatMember = { id: "codex", name: "codex", agentType: "codex", executorId: "profile-codex", model: "chat-model", reasoningEffort: null };
  const signal = new AbortController().signal;
  for (const type of AGENT_TYPES) {
    const assistantMember = { ...member, id: type, agentType: type, executorId: `profile-${type}` };
    await invokeChat(assistantMember, null, "ASSISTANT_FIXTURE", signal, "", { purpose: "assistant" });
    assert.notEqual(lastCwd, projectDir);
    assert.equal(existsSync(lastCwd), false);
  }
  await assert.rejects(invokeChat(member, null, "助手禁止工具", signal, "", { purpose: "assistant" }), { name: "AssistantToolError", message: /助手调用了未开放的工具（"Read"）/ });
  assert.equal(existsSync(lastCwd), false);
  console.log("assistant execution: 全部执行器在独立临时目录运行并清理；模型和参数保留；不携带任务完成身份；工具调用明确失败");
  for (const type of AGENT_TYPES) {
    await invokeChat({ ...member, id: type, agentType: type, executorId: `profile-${type}` }, null, "AUTHORIZATION_FIXTURE", signal, "project", { purpose: "side-authorization" });
    assert.notEqual(lastCwd, projectDir);
    assert.equal(existsSync(lastCwd), false);
  }
  await assert.rejects(invokeChat(member, null, "核验禁止工具", signal, "project", { purpose: "side-authorization" }), /核验调用使用了工具/);
  assert.equal(existsSync(lastCwd), false);
  console.log("side authorization execution: 独立临时目录、沿用执行器配置、无任务身份、工具事件拒绝并清理");
  assert.equal((await invokeChat(member, null, "BACKGROUND_SUMMARY_FIXTURE", signal, "project", { purpose: "summary" })).text, '{"summary":"已有用户决定与待办事项"}');
  assert.equal(existsSync(lastCwd), false);
  await assert.rejects(invokeChat(member, null, "摘要禁止工具", signal, "project", { purpose: "summary" }), /后台摘要调用使用了工具/);
  assert.equal(existsSync(lastCwd), false);
  const home = parseChatReply((await invokeChat(member, null, "咨询", signal, "home-directory")).text);
  assert.deepEqual(home, { reply: "来自家目录项目的建议依据", task: null });
  assert.equal(lastCwd, homeProject);
  const beforeMissing = starts;
  await assert.rejects(invokeChat(member, null, "咨询", signal, "missing-directory"), /工作目录不存在/);
  assert.equal(starts, beforeMissing);
  await invokeChat(member, null, "未配置目录的咨询", signal, "no-directory");
  assert.notEqual(lastCwd, projectDir);
  assert.equal(existsSync(lastCwd), false);
  await assert.rejects(invokeChat(member, null, "咨询", signal, "missing"), /项目不存在/);
  const aborted = new AbortController();
  aborted.abort(new Error("已停止"));
  const beforeAbort = starts;
  await assert.rejects(invokeChat(member, null, "咨询", aborted.signal, "project"), /已停止/);
  assert.equal(starts, beforeAbort);
  const sideWorktree = join(stage, "task-worktree");
  mkdirSync(sideWorktree);
  writeFileSync(join(sideWorktree, "chat-context.txt"), "主任务工作区的代码，而非项目主仓");
  await db.insert(tasks).values({ id: "side-parent", projectId: "project", title: "侧聊目录", body: "", mode: "single", createdAt, updatedAt: createdAt });
  await db.insert(sessions).values({ id: "side-session", taskId: "side-parent", role: "single", executor: "fixture", agentType: "codex", cwd: sideWorktree, startedAt: createdAt });
  writeFromMain = true;
  const sideInvocation = await invokeChat(member, null, "侧聊读取主任务代码", signal, "project", { purpose: "side", taskId: "side-parent" });
  writeFromMain = false;
  assert.equal(sideInvocation.notice, undefined, "主任务并发写入不触发侧聊越界警告");
  const sideReply = parseChatReply(sideInvocation.text);
  assert.equal(sideReply.reply, "主任务工作区的代码，而非项目主仓");
  assert.equal(lastCwd, sideWorktree);
  assert.ok(existsSync(sideWorktree), "侧聊结束不清理主任务的工作区");
  await assert.rejects(invokeChat(member, null, "错误父项目", signal, "home-directory", { purpose: "side", taskId: "side-parent" }), /主任务已不可访问/);
  sideWriteTool = true;
  await assert.rejects(invokeChat(member, null, "侧聊不能写入", signal, "project", { purpose: "side", taskId: "side-parent" }), /写入或无法确认只读/);
  sideWriteTool = false;
  console.log("side execution: 只读解析主任务会话 cwd，不继承 CLI 身份，不创建或删除工作区，跨项目绑定拒绝");
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
  console.log(`chat execution: ${AGENT_TYPES.length} 类执行器均使用原 run 通道，保留模型与参数；工具事件不中断回复；当前项目可读且不被清理；~ 开头的工作目录被展开、目录不存在时诚实报错；撤权/停止不启动进程`);
} finally {
  for (const [type, factory] of originals) CLI_SPEC_BY_KEY[type].factory = factory;
  dbClient.close();
  rmSync(stage, { recursive: true, force: true });
  rmSync(homeProject, { recursive: true, force: true });
}
