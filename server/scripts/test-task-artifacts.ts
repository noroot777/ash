// 「这个任务做出来了什么」的判据（server/src/task-artifacts.ts）。
//
// 这块逻辑全部的难点都在**认人**上——同一个目录里躺着三类文件，只有一类是这个任务的产物：
//   1. 仓库本来就有的图（被跟踪、没动过）：一个都不能进
//   2. 这个任务做的（提交了的 / 没提交的 / 被 .gitignore 挡着的）：三档都要进，且要报对
//   3. 依赖树里的图（node_modules 之类）：一个都不能进
// 其中最容易写错、也最没法靠手测发现的是**第 1 类靠 mtime 认会全军覆没**：建 worktree 是
// 一次检出，所有被跟踪的文件 mtime 都等于任务开跑那一刻。所以这里专门钉一条「仓库原有的
// 图，mtime 比任务开跑还新，照样不算产物」。
// 跑：npm -w server run test:task-artifacts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-artifacts-"));
process.env.ASH_DB = join(stage, "ash.db");
requireTmpDb("task-artifacts");

const repo = join(stage, "repo");
const TASK_ID = "Art1FactTest";
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const write = (path: string, body: string | Buffer = png) => {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), body);
};
/** 把某个文件的 mtime 挪到指定时刻——「任务开跑之前 / 之后写的」得能造出来。 */
const touchAt = (path: string, at: Date) => utimesSync(join(repo, path), at, at);

try {
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(stage, "hooks"), { recursive: true });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Artifacts test");
  git("config", "user.email", "artifacts@example.test");
  git("config", "commit.gpgSign", "false");
  git("config", "core.hooksPath", join(stage, "hooks"));

  // ── 基线：仓库本来就有的东西，一个都不该被认成产物 ────────────────────────
  write(".gitignore", "output/\nnode_modules/\n*.tmp.png\n");
  write("assets/仓库原有.png");
  write("src/app.ts", "export const x = 1;\n");
  git("add", ".");
  git("commit", "-qm", "base");

  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, sessions, tasks } = await import("../src/db/schema.js");
  const { readTaskArtifacts } = await import("../src/task-artifacts.js");
  await ensureSchema();

  const startedAt = new Date();
  const before = new Date(startedAt.getTime() - 60 * 60 * 1000);
  const after = new Date(startedAt.getTime() + 60 * 1000);
  const stamp = startedAt.toISOString();
  await db.insert(projects).values({ id: "p", name: "artifacts", repoPath: repo, createdAt: stamp });
  await db.insert(tasks).values({
    id: TASK_ID, projectId: "p", title: "产物", body: "造点东西出来",
    mode: "single", status: "done", agentType: "claude",
    mergeTargetBranch: "main", createdAt: stamp, updatedAt: stamp,
  });
  await db.insert(sessions).values({
    id: "s1", taskId: TASK_ID, role: "main", agentType: "claude", executor: "claude",
    cwd: repo, startedAt: stamp,
  });

  const root = { path: repo, branch: "main", gitRepo: true, source: "repo" as const, repo, projectId: "p" };
  const read = async () => {
    const result = await readTaskArtifacts(TASK_ID, root);
    assert.equal(result.error, null, "三路线索都该读得通");
    return result;
  };
  const originOf = (result: { artifacts: { path: string; origin: string }[] }, path: string) =>
    result.artifacts.find((artifact) => artifact.path === path)?.origin ?? null;

  // 仓库原有的图 mtime 比任务开跑还新（worktree 检出就是这个效果），仍然不算产物。
  touchAt("assets/仓库原有.png", after);
  assert.deepEqual((await read()).artifacts, [], "任务什么都没做时，仓库原有的图一张都不该算产物");

  // ── 已提交在任务分支上 ────────────────────────────────────────────────────
  // 分支名由 taskId 派生（`worktreeBranchName`），不能在这儿手写一个：写死的名字跟约定
  // 一旦分家，测试会因为「分支不存在」而绿着跑过去，什么都没验到。
  const { worktreeBranchName } = await import("../src/git.js");
  git("checkout", "-qb", worktreeBranchName(TASK_ID));
  write("out/海报.png");
  write("out/页面.html", "<!doctype html><p>hi</p>");
  write("src/app.ts", "export const x = 2;\n");
  git("add", ".");
  git("commit", "-qm", "做了张图和一个页面");
  let result = await read();
  assert.equal(originOf(result, "out/海报.png"), "committed");
  assert.equal(originOf(result, "out/页面.html"), "committed");
  assert(!result.artifacts.some((a) => a.path === "src/app.ts"), "代码改动不是产物，那是「改动」面板的事");
  assert(!result.artifacts.some((a) => a.path === "assets/仓库原有.png"), "没在这条分支上动过的图仍然不算");

  // ── 还没提交 ──────────────────────────────────────────────────────────────
  write("out/草稿.png");                       // 未跟踪
  write("out/海报.png", Buffer.concat([png, png])); // 已跟踪、改过
  result = await read();
  assert.equal(originOf(result, "out/草稿.png"), "working");
  assert.equal(
    originOf(result, "out/海报.png"), "working",
    "既提交过又刚改过时报最靠近当下的那一档",
  );

  // ── 被 .gitignore 挡着 ────────────────────────────────────────────────────
  write("output/渲染.png");
  touchAt("output/渲染.png", after);
  write("output/上一轮.png");
  touchAt("output/上一轮.png", before);        // 任务开跑之前就在了
  write("output/nested/深一层.png");
  touchAt("output/nested/深一层.png", after);
  write("旧图.tmp.png");                        // 单文件被忽略（不是整个目录）
  touchAt("旧图.tmp.png", after);
  write("node_modules/pkg/logo.png");          // 依赖树，永远不进
  touchAt("node_modules/pkg/logo.png", after);
  result = await read();
  assert.equal(originOf(result, "output/渲染.png"), "ignored");
  assert.equal(originOf(result, "output/nested/深一层.png"), "ignored", "被忽略的目录要往里走");
  assert.equal(originOf(result, "旧图.tmp.png"), "ignored", "按模式忽略的单个文件也要认");
  assert.equal(originOf(result, "output/上一轮.png"), null, "任务开跑之前就在的，不是这一趟的产物");
  assert.equal(originOf(result, "node_modules/pkg/logo.png"), null, "依赖树里的图一张都不进");

  // ── 分类、排序、元信息 ────────────────────────────────────────────────────
  assert.equal(result.artifacts.find((a) => a.path === "out/页面.html")?.kind, "page");
  assert.equal(result.artifacts.find((a) => a.path === "out/海报.png")?.kind, "image");
  assert.equal(result.artifacts.find((a) => a.path === "out/海报.png")?.dir, "out");
  assert.equal(result.artifacts.find((a) => a.path === "out/海报.png")?.size, png.length * 2);
  const times = result.artifacts.map((a) => Date.parse(a.mtime ?? ""));
  assert.deepEqual(times, [...times].sort((a, b) => b - a), "新的排前面");
  assert.equal(result.since, stamp);

  // ── 删掉之后就该消失（清单里留着一个点开是 404 的条目比没有更糟） ──────────
  rmSync(join(repo, "out/草稿.png"));
  assert.equal(originOf(await read(), "out/草稿.png"), null, "磁盘上没了的路径不能留在清单里");

  // ── 没跑过的任务：被忽略那一档整个跳过（没有时间下限可用） ──────────────────
  await db.insert(tasks).values({
    id: "NoRunTask00", projectId: "p", title: "没跑过", body: "-",
    mode: "single", status: "backlog", agentType: "claude", createdAt: stamp, updatedAt: stamp,
  });
  const fresh = await readTaskArtifacts("NoRunTask00", root);
  assert.equal(fresh.since, null);
  assert(!fresh.artifacts.some((a) => a.origin === "ignored"), "没有开跑时刻就不敢认被忽略的文件");

  console.log("✓ task artifacts: committed/working/ignored 三档、仓库原有物免疫 mtime、依赖树与过期产物排除、删除即消失");
} finally {
  // ASH_DB 落在舞台目录里,Windows 上不先松开就删不掉(见 tmp-db.ts)。
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
