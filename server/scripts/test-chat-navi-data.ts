import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import type { AgentEvent } from "@navi/shared";
import type { ChatMember } from "@navi/shared/chat";

// 群聊的项目常常就是 navi 仓库本身，navi 又在一边服务咨询一边写自己的 data/。这些并发写不能
// 算成被咨询智能体的越界，否则被 @ 的成员会齐刷刷报「检测到咨询期间项目文件变化」。
const stage = mkdtempSync(join(tmpdir(), "navi-chat-navi-data-"));
const projectDir = join(stage, "project");
const data = join(projectDir, "data");
mkdirSync(join(data, "runs"), { recursive: true });
mkdirSync(join(data, "uploads"), { recursive: true });
process.env.NAVI_DB = join(data, "ash.db");
process.env.NAVI_RUNS_DIR = join(data, "runs");
process.env.NAVI_UPLOADS_DIR = join(data, "uploads");
const source = join(projectDir, "source.txt");
writeFileSync(source, "unchanged\n");
// 与 data/ 同前缀的普通文件：排除必须按目录边界切，不能变成前缀匹配。
writeFileSync(join(projectDir, "data.txt"), "project file\n");

const { db, ensureSchema, dbClient } = await import("../src/db/index.js");
const { projects } = await import("../src/db/schema.js");
const { setInstanceMode } = await import("../src/auth/mode.js");
const { CLI_SPEC_BY_KEY } = await import("../src/executors/catalog/index.js");
const { invokeChat } = await import("../src/chat/execution.js");
await ensureSchema();
await setInstanceMode("single", stage);
await db.insert(projects).values({ id: "self", name: "navi 自己", repoPath: projectDir, createdAt: new Date().toISOString() });

const member: ChatMember = { id: "codex", name: "codex", agentType: "codex", executorId: null, model: null, reasoningEffort: null };
const originalFactory = CLI_SPEC_BY_KEY.codex.factory;
let mutate = () => {};
CLI_SPEC_BY_KEY.codex.factory = () => ({
  type: "codex", label: "navi-data fixture", resumeCommand: () => "",
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
  // 一次把 navi 会在 data/ 里动的各类东西都写一遍：日志、库锁、校准文件、暂存、产物、上传、运行记录。
  const naviWrites = [
    join(data, "server.log"), join(data, "ash.db.ash.lock"), join(data, "skill-calibrations.json"),
    join(data, "scratch", "task-1", "note.txt"), join(data, "task-artifacts", "shot.png"),
    join(data, "uploads", "pasted.png"), join(data, "runs", "task-1", "turn.md"),
  ];
  mutate = () => {
    for (const file of naviWrites) {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, "navi 自己在写");
    }
  };
  const reply = await invoke();
  assert.deepEqual(JSON.parse(reply.text), { reply: "只读咨询", task: null }, "navi 自己的 data/ 并发写不该中止咨询");
  assert.equal(reply.notice, undefined, "navi 自己的 data/ 并发写也不该附注");
  console.log(`chat navi data: ${naviWrites.length} 处 navi 自身写入均未误判`);

  for (const file of [source, join(projectDir, "data.txt"), join(projectDir, "data-report.md")]) {
    mutate = () => writeFileSync(file, "unexpected change");
    const result = await invoke();
    assert.ok(result.text.includes("只读咨询"), `${file} 的回复不得作废`);
    assert.match(result.notice ?? "", new RegExp(basename(file).replace(/\./gu, "\\.")), `${file} 仍须如实附注`);
  }
  console.log("chat navi data: 项目文件与 data 同前缀的兄弟文件仍照常附注");
} finally {
  CLI_SPEC_BY_KEY.codex.factory = originalFactory;
  dbClient.close();
  rmSync(stage, { recursive: true, force: true });
}
