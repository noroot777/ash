import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const lock = join(linkedGit, "index.lock");
  mutate = () => { writeFileSync(lock, "index refresh"); rmSync(lock); };
  await assert.doesNotReject(invoke(), "其他工作树的 index.lock 创建/移除不应中止主仓咨询");
  mutate = () => {};
  toolEvent = { kind: "tool", name: "Write", detail: linkedIndex };
  await assert.rejects(invoke(), ChatBoundaryError, "索引缓存例外不能绕过写入工具检查");
  toolEvent = undefined;

  mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
  for (const path of ["source.txt", join("node_modules", "pkg", "side-effect.txt"), join(".git", "index"), join(".git", "HEAD"), join(".git", "worktrees", "linked", "HEAD"), "index.lock"]) {
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
  console.log("chat git metadata: 只豁免其他工作树的 index/index.lock；当前索引、HEAD、源码、依赖及同名普通文件仍告警");
} finally {
  release?.();
  CLI_SPEC_BY_KEY.codex.factory = originalFactory;
  dbClient.close();
  rmSync(stage, { recursive: true, force: true });
}
