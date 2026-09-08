import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@ash/shared";
import type { ChatMember } from "@ash/shared/chat";

// 群聊的项目常常就是 ash 仓库本身，ash 又在一边服务咨询一边写自己的 data/。这些并发写不能
// 算成被咨询智能体的越界，否则被 @ 的成员会齐刷刷报「检测到咨询期间项目文件变化」。
const stage = mkdtempSync(join(tmpdir(), "ash-chat-ash-data-"));
const projectDir = join(stage, "project");
const data = join(projectDir, "data");
mkdirSync(join(data, "runs"), { recursive: true });
mkdirSync(join(data, "uploads"), { recursive: true });
process.env.ASH_DB = join(data, "ash.db");
process.env.ASH_RUNS_DIR = join(data, "runs");
process.env.ASH_UPLOADS_DIR = join(data, "uploads");
const source = join(projectDir, "source.txt");
writeFileSync(source, "unchanged\n");
// 与 data/ 同前缀的普通文件：排除必须按目录边界切，不能变成前缀匹配。
writeFileSync(join(projectDir, "data.txt"), "project file\n");

const { db, ensureSchema, dbClient } = await import("../src/db/index.js");
const { projects } = await import("../src/db/schema.js");
const { setInstanceMode } = await import("../src/auth/mode.js");
const { CLI_SPEC_BY_KEY } = await import("../src/executors/catalog/index.js");
const { invokeChat } = await import("../src/chat/execution.js");
const { ChatBoundaryError } = await import("../src/chat/boundary.js");
await ensureSchema();
await setInstanceMode("single", stage);
await db.insert(projects).values({ id: "self", name: "ash 自己", repoPath: projectDir, createdAt: new Date().toISOString() });

const member: ChatMember = { id: "codex", name: "codex", agentType: "codex", executorId: null, model: null, reasoningEffort: null };
const originalFactory = CLI_SPEC_BY_KEY.codex.factory;
let mutate = () => {};
CLI_SPEC_BY_KEY.codex.factory = () => ({
  type: "codex", label: "ash-data fixture", resumeCommand: () => "",
  run: () => {
    mutate();
    return {
      sessionId: "fixture", commandLine: "fixture", kill: () => {},
      events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { kind: "text", text: '{"reply":"只读咨询","task":null}' };
        yield { kind: "done", exitStatus: 0 };
      })(),
    };
  },
});
const invoke = () => invokeChat(member, null, "@codex 只给建议，不修改文件", AbortSignal.timeout(10000), "self");

try {
  // 一次把 ash 会在 data/ 里动的各类东西都写一遍：日志、库锁、校准文件、暂存、产物、上传、运行记录。
  const ashWrites = [
    join(data, "server.log"), join(data, "ash.db.ash.lock"), join(data, "skill-calibrations.json"),
    join(data, "scratch", "task-1", "note.txt"), join(data, "task-artifacts", "shot.png"),
    join(data, "uploads", "pasted.png"), join(data, "runs", "task-1", "turn.md"),
  ];
  mutate = () => {
    for (const file of ashWrites) {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, "ash 自己在写");
    }
  };
  const reply = await invoke();
  assert.deepEqual(JSON.parse(reply), { reply: "只读咨询", task: null }, "ash 自己的 data/ 并发写不该中止咨询");
  console.log(`chat ash data: ${ashWrites.length} 处 ash 自身写入均未误判`);

  for (const file of [source, join(projectDir, "data.txt"), join(projectDir, "data-report.md")]) {
    mutate = () => writeFileSync(file, "unexpected change");
    await assert.rejects(invoke(), ChatBoundaryError, `${file} 仍须告警`);
  }
  console.log("chat ash data: 项目文件与 data 同前缀的兄弟文件仍照常告警");
} finally {
  CLI_SPEC_BY_KEY.codex.factory = originalFactory;
  dbClient.close();
  rmSync(stage, { recursive: true, force: true });
}
