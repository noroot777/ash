import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { mock } from "node:test";
import type { AgentEvent } from "@ash/shared";
import type { ChatMember } from "@ash/shared/chat";

const stage = mkdtempSync(join(tmpdir(), "ash-chat-large-workspace-"));
const realRepo = process.argv[2] ? await fs.realpath(resolve(process.argv[2])) : undefined;
process.env.ASH_DB = join(stage, "test.db");
process.env.ASH_RUNS_DIR = realRepo ? join(realRepo, "data", "runs") : join(stage, "runs");
const projectDir = join(stage, "project");
mkdirSync(projectDir);
const shallow = ["node_modules", "mobile/node_modules", ".worktrees", ".claude/worktrees"];
const included = ["src", "node_modules-notes", ".worktrees-notes", ".claude/worktrees-notes", ".github/worktrees"];
for (const directory of [...shallow, ...included]) {
  mkdirSync(join(projectDir, directory), { recursive: true });
  writeFileSync(join(projectDir, directory, "source.txt"), "before");
  mkdirSync(join(projectDir, directory, "pkg", "dist"), { recursive: true });
  writeFileSync(join(projectDir, directory, "pkg", "dist", "index.js"), "before");
}
const root = await fs.realpath(projectDir);
const shallowPaths = shallow.map((directory) => resolve(root, directory));
const originalReadDir = fs.readdir;
let detectTraversal = true;
mock.method(fs, "readdir", (...args: Parameters<typeof fs.readdir>) => {
  const path = resolve(String(args[0]));
  if (detectTraversal && shallowPaths.some((directory) => path === directory || path.startsWith(`${directory}${sep}`))) {
    throw new Error("依赖及其他工作树不应参与基线枚举，无论包含多少条目");
  }
  return originalReadDir(...args);
});
syncBuiltinESMExports();

const { db, ensureSchema, dbClient } = await import("../src/db/index.js");
const { projects } = await import("../src/db/schema.js");
const { setInstanceMode } = await import("../src/auth/mode.js");
const { CLI_SPEC_BY_KEY } = await import("../src/executors/catalog/index.js");
const { invokeChat } = await import("../src/chat/execution.js");
const { ChatBoundaryError } = await import("../src/chat/boundary.js");
await ensureSchema();
await setInstanceMode("single", stage);
const createdAt = new Date().toISOString();
await db.insert(projects).values([
  { id: "project", name: "大目录边界", repoPath: projectDir, createdAt },
  { id: "nested", name: "独立工作树", repoPath: join(projectDir, ".worktrees"), createdAt },
]);
const member: ChatMember = { id: "codex", name: "codex", agentType: "codex", executorId: null, model: null, reasoningEffort: null };
const originalFactory = CLI_SPEC_BY_KEY.codex.factory;
let starts = 0;
let mutate: (cwd: string) => void = () => {};
CLI_SPEC_BY_KEY.codex.factory = () => ({
  type: "codex", label: "large workspace fixture", resumeCommand: () => "",
  run: (opts) => {
    starts++;
    mutate(opts.cwd);
    return {
      sessionId: "fixture", commandLine: "fixture", kill: () => {},
      events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { kind: "text", text: '{"reply":"已读取当前项目，可以正常咨询。","task":null}' };
        yield { kind: "done", exitStatus: 0 };
      })(),
    };
  },
});
const invoke = (project = "project") => invokeChat(member, null, "@codex 请给建议，不执行修改", AbortSignal.timeout(30000), project);
try {
  await assert.doesNotReject(invoke(), "初始化后没有写入的咨询应成功");
  assert.equal(starts, 1, "依赖/工作树的体量不能在启动前拒绝只读智能体");
  for (const directory of shallow) {
    const sideEffect = join(directory, "pkg", "side-effect.txt");
    const existing = join(directory, "pkg", "dist", "index.js");
    const renamed = join(directory, "pkg", "dist", "renamed.js");
    mutate = (cwd) => assert.equal(readFileSync(join(cwd, existing), "utf8"), "before");
    await assert.doesNotReject(invoke(), `${directory}: 仅读取已有文件应成功`);
    for (const operation of ["create", "edit", "delete", "rename", "transient"]) {
      mutate = (cwd) => {
        if (operation === "create" || operation === "transient") writeFileSync(join(cwd, sideEffect), "unexpected dependency change");
        if (operation === "edit") writeFileSync(join(cwd, existing), "after!");
        if (operation === "delete") rmSync(join(cwd, existing));
        if (operation === "rename") renameSync(join(cwd, existing), join(cwd, renamed));
        if (operation === "transient") rmSync(join(cwd, sideEffect));
      };
      await assert.rejects(invoke(), (error: unknown) => error instanceof ChatBoundaryError && error.message.includes("咨询已中止"), `${directory}: ${operation}`);
      if (operation === "create") assert.ok(existsSync(join(projectDir, sideEffect)), "只告警，不自动回滚依赖改动");
      rmSync(join(projectDir, sideEffect), { force: true });
      rmSync(join(projectDir, renamed), { force: true });
      writeFileSync(join(projectDir, existing), "before");
    }
  }
  for (const directory of included) {
    mutate = (cwd) => writeFileSync(join(cwd, directory, "source.txt"), "after!");
    await assert.rejects(invoke(), ChatBoundaryError, directory);
    writeFileSync(join(projectDir, directory, "source.txt"), "before");
  }
  detectTraversal = false;
  mutate = () => {};
  await invoke("nested");
  mutate = (cwd) => writeFileSync(join(cwd, "source.txt"), "after!");
  await assert.rejects(invoke("nested"), ChatBoundaryError, "群所属项目本身位于 .worktrees 内时仍要监测");
  assert.equal(starts, 32);
  console.log("chat large workspace: 依赖与其他工作树不深度枚举、只读仍通过；无工具事件的同步写入/等长修改/删除/重命名/瞬时改动均告警；源码及当前工作树仍监测");

  if (realRepo) {
    const repoPath = realRepo;
    await db.insert(projects).values({ id: "real", name: "真实大仓只读复现", repoPath, createdAt });
    const packageFile = join(repoPath, "package.json");
    const before = readFileSync(packageFile, "utf8");
    mutate = (cwd) => assert.equal(readFileSync(join(cwd, "package.json"), "utf8"), before);
    const began = Date.now();
    const testDb = process.env.ASH_DB;
    let result: { reply: string; task: unknown };
    try {
      process.env.ASH_DB = join(repoPath, "data", "ash.db");
      result = JSON.parse(await invoke("real"));
    } finally { process.env.ASH_DB = testDb; }
    assert.equal(starts, 33);
    assert.equal(result.task, null);
    assert.equal(readFileSync(packageFile, "utf8"), before);
    console.log(JSON.stringify({ repoPath, runCalled: true, task: result.task, elapsedMs: Date.now() - began, read: relative(repoPath, packageFile) }));
  }
} finally {
  CLI_SPEC_BY_KEY.codex.factory = originalFactory;
  mock.restoreAll();
  syncBuiltinESMExports();
  dbClient.close();
  rmSync(stage, { recursive: true, force: true });
}
