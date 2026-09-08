import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
// monitoredShallow：不参与任何枚举，但其中的变更仍要附注；ignoredTrees：其他任务的工作树，
// 持续有别的智能体在写，连附注都不给（否则每条回复都带附注，提示会被淹掉）。
const monitoredShallow = ["node_modules", "mobile/node_modules"];
const ignoredTrees = [".worktrees", ".claude/worktrees"];
const included = ["src", "node_modules-notes", ".worktrees-notes", ".claude/worktrees-notes", ".github/worktrees"];
for (const directory of [...monitoredShallow, ...ignoredTrees, ...included]) {
  mkdirSync(join(projectDir, directory), { recursive: true });
  writeFileSync(join(projectDir, directory, "source.txt"), "before");
  mkdirSync(join(projectDir, directory, "pkg", "dist"), { recursive: true });
  writeFileSync(join(projectDir, directory, "pkg", "dist", "index.js"), "before");
}
const root = await fs.realpath(projectDir);
const originalReadDir = fs.readdir;
mock.method(fs, "readdir", (...args: Parameters<typeof fs.readdir>) => {
  const path = resolve(String(args[0]));
  if (path === root || path.startsWith(`${root}${sep}`)) {
    throw new Error("目录观察不做基线枚举，项目再大也不该被扫一遍");
  }
  return originalReadDir(...args);
});
syncBuiltinESMExports();

const { db, ensureSchema, dbClient } = await import("../src/db/index.js");
const { projects } = await import("../src/db/schema.js");
const { setInstanceMode } = await import("../src/auth/mode.js");
const { CLI_SPEC_BY_KEY } = await import("../src/executors/catalog/index.js");
const { invokeChat } = await import("../src/chat/execution.js");
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
  assert.equal((await invoke()).notice, undefined, "初始化后没有写入的咨询不该有附注");
  assert.equal(starts, 1, "依赖/工作树的体量不能拖慢或拒绝只读智能体");
  for (const directory of [...monitoredShallow, ...ignoredTrees]) {
    const ignoredTree = ignoredTrees.includes(directory);
    for (const operation of ["edit", "create"]) {
      const target = join(directory, "pkg", operation === "edit" ? join("dist", "index.js") : "side-effect.txt");
      mutate = (cwd) => writeFileSync(join(cwd, target), "changed");
      const result = await invoke();
      assert.ok(result.text.includes("已读取当前项目"), `${directory}/${operation}: 回复不得作废`);
      if (ignoredTree) assert.equal(result.notice, undefined, `${directory}/${operation}: 其他工作树的并发写不附注`);
      else assert.match(result.notice ?? "", new RegExp(operation === "edit" ? "index\\.js" : "side-effect\\.txt"), `${directory}/${operation}: 依赖变更须附注`);
      rmSync(join(projectDir, directory, "pkg", "side-effect.txt"), { force: true });
      writeFileSync(join(projectDir, directory, "pkg", "dist", "index.js"), "before");
    }
  }
  for (const directory of included) {
    mutate = (cwd) => writeFileSync(join(cwd, directory, "source.txt"), "after!");
    assert.match((await invoke()).notice ?? "", /source\.txt/, `${directory}: 名字沾边不代表跟着豁免`);
    writeFileSync(join(projectDir, directory, "source.txt"), "before");
  }
  mutate = () => {};
  assert.equal((await invoke("nested")).notice, undefined, "位于 .worktrees 内的项目只读咨询不附注");
  mutate = (cwd) => writeFileSync(join(cwd, "source.txt"), "after!");
  assert.match((await invoke("nested")).notice ?? "", /source\.txt/, "群所属项目本身位于 .worktrees 内时仍要观察");
  assert.equal(starts, 1 + (monitoredShallow.length + ignoredTrees.length) * 2 + included.length + 2);
  console.log("chat large workspace: 目录观察零枚举、体量不影响咨询；依赖与项目文件的变更如实附注且不作废回复；其他工作树的并发写不附注；当前工作树自身仍观察");

  if (realRepo) {
    const repoPath = realRepo;
    await db.insert(projects).values({ id: "real", name: "真实大仓只读复现", repoPath, createdAt });
    const packageFile = join(repoPath, "package.json");
    const before = await fs.readFile(packageFile, "utf8");
    mutate = () => {};
    const began = Date.now();
    const testDb = process.env.ASH_DB;
    let result: { reply: string; task: unknown };
    try {
      process.env.ASH_DB = join(repoPath, "data", "ash.db");
      result = JSON.parse((await invoke("real")).text);
    } finally { process.env.ASH_DB = testDb; }
    assert.equal(result.task, null);
    assert.equal(await fs.readFile(packageFile, "utf8"), before);
    console.log(JSON.stringify({ repoPath, runCalled: true, task: result.task, elapsedMs: Date.now() - began, read: relative(repoPath, packageFile) }));
  }
} finally {
  CLI_SPEC_BY_KEY.codex.factory = originalFactory;
  mock.restoreAll();
  syncBuiltinESMExports();
  dbClient.close();
  rmSync(stage, { recursive: true, force: true });
}
