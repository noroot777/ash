// 验收「推送到远程」回归用例的共用夹具（test-accept-push.ts / test-accept-push-destination.ts）：
// 临时 SQLite + 临时目录；每个用例自带一个项目仓库、一个裸仓库当远程、再 clone 一份当「别人」往远程推。
// 先 import 这个文件再 import ../src 下的模块：库路径环境变量要在它们第一次加载之前设好。
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

export const root = mkdtempSync(join(tmpdir(), "navi-accept-push-test-"));
process.env.NAVI_DB = join(root, "navi.db");
process.env.NAVI_RUNS_DIR = join(root, "runs");
process.on("exit", () => { try { rmSync(root, { recursive: true, force: true }); } catch {} });
export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
export const identity = (repo: string) => {
  git(repo, "config", "user.name", "Navi Push Test");
  git(repo, "config", "user.email", "push@example.test");
};

/** 项目仓库 + 裸远程（main 已推上去、设好上游）+ 「别人」的克隆。 */
export function makeStage(name: string): { repo: string; remote: string; other: string } {
  const repo = join(root, name);
  const remote = join(root, `${name}.git`);
  const other = join(root, `${name}-other`);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  identity(repo);
  writeFileSync(join(repo, ".gitignore"), ".worktrees/\n");
  writeFileSync(join(repo, "shared.txt"), "seed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "-u", "origin", "main");
  execFileSync("git", ["clone", "-q", remote, other]);
  identity(other);
  return { repo, remote, other };
}

/** 「别人」往远程 main 推一个提交。 */
export function pushFromOther(other: string, file: string, content: string): string {
  git(other, "pull", "-q", "--ff-only");
  writeFileSync(join(other, file), content);
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", `other ${file}`);
  git(other, "push", "-q", "origin", "main");
  return git(other, "rev-parse", "HEAD");
}

let seq = 0;
/** 用例里要一个不重复的序号（临时文件名之类）。 */
export const nextSeq = () => ++seq;

/** 库、任务、项目这一套：ensureSchema 之后才能用。 */
export async function pushHarness() {
  const { prepareWorktree } = await import("../src/git.js");
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks } = await import("../src/db/schema.js");
  await ensureSchema();
  const createdAt = new Date().toISOString();
  const wsOf = new Map<string, string>();
  /** 在 repo 上建一个项目 + 一个已完成的任务（分支上改了 file）。 */
  const seedTask = async (repo: string, file: string, content: string, project: Partial<typeof projects.$inferInsert> = {}) => {
    const n = nextSeq();
    const projectId = `push-project-${n}`;
    const taskId = `pushtask${String(n).padStart(4, "0")}`;
    await db.insert(projects).values({ id: projectId, name: `push-${n}`, repoPath: repo, createdAt, ...project });
    const ws = await prepareWorktree(repo, taskId, "main");
    writeFileSync(join(ws.path, file), content);
    git(ws.path, "add", "-A");
    git(ws.path, "commit", "-q", "-m", `task ${file}`);
    await db.insert(tasks).values({
      id: taskId, projectId, title: file, body: "", mode: "single", status: "done", stage: "verified",
      labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "claude",
      useWorktree: true, worktreeBase: "main", mergeTargetBranch: "main",
      autoTitle: false, createdAt, updatedAt: createdAt,
    });
    wsOf.set(taskId, ws.path);
    return taskId;
  };
  const rowOf = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!;
  const projectOf = async (taskId: string) => (await db.select().from(projects).where(eq(projects.id, (await rowOf(taskId)).projectId))).at(0)!;
  /** 一次性的 pre-push 钩子：Navi 推的那一刻，「别人」先往远程推一个提交（模拟合完到推之间远程又动了）。 */
  const raceOnPush = (repo: string, other: string, file: string, content: string) => {
    const hook = join(repo, ".git", "hooks", "pre-push");
    writeFileSync(hook, `#!/bin/sh\nrm -f "$0"\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX\n`
      + `cd ${JSON.stringify(other)} && git pull -q --ff-only && printf %b ${JSON.stringify(content)} > ${JSON.stringify(file)}`
      + ` && git add -A && git commit -q -m "race ${file}" && git push -q origin main\n`, { mode: 0o755 });
  };
  const stageOf = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!.stage;
  return { wsOf, seedTask, rowOf, projectOf, raceOnPush, stageOf };
}
