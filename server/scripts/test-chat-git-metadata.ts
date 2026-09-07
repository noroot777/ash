import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { AgentEvent } from "@ash/shared";
import type { ChatMember } from "@ash/shared/chat";

const stage = mkdtempSync(join(tmpdir(), "ash-chat-git-metadata-"));
const repo = join(stage, "main");
const linked = join(stage, "linked");
mkdirSync(repo);
process.env.ASH_DB = join(stage, "test.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
const gitEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "1" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "core.hooksPath=", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env: gitEnv }).trim();
git(repo, "init", "-q", "-b", "main");
git(repo, "config", "user.name", "Chat Metadata Test");
git(repo, "config", "user.email", "chat-metadata@ash.test");
writeFileSync(join(repo, "source.txt"), "unchanged\n");
git(repo, "add", "source.txt");
git(repo, "commit", "-qm", "fixture");
git(repo, "worktree", "add", "-q", "--detach", linked, "HEAD");
const linkedGit = join(repo, ".git", "worktrees", "linked");
const linkedIndex = join(linkedGit, "index");
const indexBefore = readFileSync(linkedIndex);
const staleTime = new Date(Date.now() - 10000);
utimesSync(join(linked, "source.txt"), staleTime, staleTime);

const { db, ensureSchema, dbClient } = await import("../src/db/index.js");
const { projects } = await import("../src/db/schema.js");
const { setInstanceMode } = await import("../src/auth/mode.js");
const { CLI_SPEC_BY_KEY } = await import("../src/executors/catalog/index.js");
const { invokeChat } = await import("../src/chat/execution.js");
const { ChatBoundaryError } = await import("../src/chat/boundary.js");
await ensureSchema();
await setInstanceMode("single", stage);
await db.insert(projects).values({ id: "main", name: "主仓聊天", repoPath: repo, createdAt: new Date().toISOString() });
const member: ChatMember = { id: "codex", name: "codex", agentType: "codex", executorId: null, model: null, reasoningEffort: null };
const originalFactory = CLI_SPEC_BY_KEY.codex.factory;
const started = Promise.withResolvers<void>();
let release: (() => void) | undefined;
let background = true;
let mutate = () => {};
let toolEvent: Extract<AgentEvent, { kind: "tool" }> | undefined;
CLI_SPEC_BY_KEY.codex.factory = () => ({
  type: "codex", label: "metadata fixture", resumeCommand: () => "",
  run: () => {
    mutate();
    started.resolve();
    return {
      sessionId: "fixture", commandLine: "fixture", kill: () => release?.(),
      events: (async function* (): AsyncGenerator<AgentEvent> {
        if (background) await new Promise<void>((resolve) => { release = resolve; });
        if (toolEvent) yield toolEvent;
        yield { kind: "text", text: '{"reply":"只读咨询","task":null}' };
        yield { kind: "done", exitStatus: 0 };
      })(),
    };
  },
});
const invoke = () => invokeChat(member, null, "@codex 只给建议，不修改文件", AbortSignal.timeout(10000), "main");
try {
  const outcome = invoke().then((result) => ({ result }), (error: unknown) => ({ error }));
  await started.promise;
  let statusRuns = 0;
  const indexStamp = lstatSync(linkedIndex, { bigint: true }).ctimeNs;
  try {
    for (let attempt = 0; attempt < 12; attempt++) {
      const status = await promisify(execFile)("git", ["-C", linked, "status", "--short"], { env: gitEnv });
      assert.equal(status.stdout.trim(), "");
      statusRuns++;
      await delay(10);
    }
  } finally { release?.(); }
  const settled = await outcome;
  assert.notEqual(lstatSync(linkedIndex, { bigint: true }).ctimeNs, indexStamp, "真实 git status 必须实际刷新索引，不能空跑正例");
  assert.notDeepEqual(readFileSync(linkedIndex), indexBefore, "索引缓存内容应被实际刷新");
  if ("error" in settled) throw settled.error;
  assert.deepEqual(JSON.parse(settled.result), { reply: "只读咨询", task: null });
  assert.equal(readFileSync(join(repo, "source.txt"), "utf8"), "unchanged\n");
  console.log(`chat git metadata: ${statusRuns} 次 linked worktree 只读 git status 实际刷新索引，主仓咨询仍成功`);

  background = false;
  release = undefined;
  // git 的记账目录整棵不算项目文件：主仓和其他工作树的索引、锁、HEAD、refs、logs，都会被 ash
  // 的状态轮询、别的任务在同一个仓库里的提交、以及用户自己的终端动到，全不是被咨询者干的。
  const gitWrites = [
    join(linkedGit, "index.lock"), join(linkedGit, "HEAD"),
    join(repo, ".git", "index.lock"), join(repo, ".git", "index"), join(repo, ".git", "HEAD"),
    join(repo, ".git", "refs", "heads", "main"), join(repo, ".git", "logs", "HEAD"),
  ].map((file) => { let before: Buffer | undefined; try { before = readFileSync(file); } catch {} return { file, before }; });
  mutate = () => { for (const { file } of gitWrites) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "git 记账"); } };
  try { await assert.doesNotReject(invoke(), "git 元数据写入不应中止咨询"); }
  finally {
    for (const { file, before } of gitWrites) {
      if (before) writeFileSync(file, before);
      else rmSync(file, { force: true });
    }
  }
  mutate = () => {};
  toolEvent = { kind: "tool", name: "Write", detail: linkedIndex };
  await assert.rejects(invoke(), ChatBoundaryError, "元数据例外不能绕过写入工具检查");
  toolEvent = undefined;
  console.log(`chat git metadata: ${gitWrites.length} 处 .git 记账写入未误判，写入工具仍被拦下`);

  mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
  // `.gitignore` 与 `index.lock` 是工作区里的普通文件，名字沾边不代表能跟着豁免。
  for (const path of ["source.txt", join("node_modules", "pkg", "side-effect.txt"), ".gitignore", "index.lock"]) {
    const file = join(repo, path);
    let before: Buffer | undefined;
    try { before = readFileSync(file); } catch {}
    mutate = () => writeFileSync(file, "unexpected change");
    try { await assert.rejects(invoke(), ChatBoundaryError, `${path} 仍须告警`); }
    finally {
      if (before) writeFileSync(file, before);
      else rmSync(file, { force: true });
    }
  }
  assert.equal(git(repo, "status", "--short", "--untracked-files=no"), "");
  console.log("chat git metadata: 豁免只到 .git 边界为止；源码、依赖、.gitignore 及同名普通文件仍告警");
} finally {
  release?.();
  CLI_SPEC_BY_KEY.codex.factory = originalFactory;
  dbClient.close();
  rmSync(stage, { recursive: true, force: true });
}
