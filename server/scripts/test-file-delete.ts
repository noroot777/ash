// 删任务工作目录里的文件 / 文件夹的回归测试。
//
// 这条路是整个文件浏览里**唯一会写工作区**的，而且不可逆，所以要钉住的不是「能删掉」，
// 是那一圈不许漏的拒绝：
//   ① 只读档 force 也不解：任务归档、解析回落到项目主仓（该有 worktree 但还没建出来）；
//   ② 在飞档要 force：这个**目录**上有任务在跑（包括共用它的兄弟任务），无 force 回
//      409 + needsForce，带 force 才放行；
//   ③ 跟任务状态无关的三条硬拒：工作目录本身、`.git`、越界路径；
//   ④ 软链只删链接本身，不碰它指向的目标（跟着走等于越界的另一种写法）；
//   ⑤ overview 说的话得跟磁盘对得上：递归统计、跟踪/未提交/未跟踪三个数分得清。
//
// 删除模式一律用 `permanent`：`trash` 会把测试垃圾真的丢进跑测试这台机器的废纸篓里。
// macOS 的废纸篓通道（含带引号/空格/中文的文件名）在 `file-trash.ts` 顶部说明的那次
// 真机实测里验过。
//
// 跑法（自带临时库）：
//   npm -w server run test:file-delete
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { requireTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-file-delete-"));
process.env.ASH_DB ||= join(stage, "file-delete.db");
process.env.ASH_RUNS_DIR ||= join(stage, "runs");
requireTmpDb("test-file-delete");

const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, sessions, tasks } = await import("../src/db/schema.js");
const { Hono } = await import("hono");
const { api } = await import("../src/routes.js");

await ensureSchema();
const app = new Hono();
app.route("/api", api);

const repo = join(stage, "repo");
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

execFileSync("git", ["init", "-b", "main", repo]);
git("config", "user.name", "Ash Test");
git("config", "user.email", "ash@example.test");

// 一份有代表性的工作目录：跟踪过的、改过没提交的、压根没进过 git 的、还有一条软链。
mkdirSync(join(repo, "src"), { recursive: true });
mkdirSync(join(repo, "scratch", "nested"), { recursive: true });
writeFileSync(join(repo, "src", "tracked.ts"), "export const a = 1;\n");
writeFileSync(join(repo, "src", "dirty.ts"), "export const b = 1;\n");
writeFileSync(join(repo, "keep.txt"), "keep\n");
git("add", "-A");
git("commit", "-m", "seed");
writeFileSync(join(repo, "src", "dirty.ts"), "export const b = 2;\n");
writeFileSync(join(repo, "src", "fresh.ts"), "// 没进过 git\n");
writeFileSync(join(repo, "scratch", "a.log"), "x".repeat(100));
writeFileSync(join(repo, "scratch", "nested", "b.log"), "y".repeat(50));
const outsideTarget = join(stage, "outside.txt");
writeFileSync(outsideTarget, "我在工作区外面\n");
symlinkSync(outsideTarget, join(repo, "link-outside"));

// 名字带前后空格的一对同名文件。POSIX 上这两个是**两个不同的文件**，解析路径时少削一个
// 空格就会删错人。
writeFileSync(join(repo, " spaced.txt"), "带前导空格的那个\n");
writeFileSync(join(repo, "spaced.txt"), "不带空格的那个\n");

const ts = new Date().toISOString();
const common = {
  projectId: "proj",
  groupId: null,
  title: "删除测试",
  body: "",
  status: "backlog",
  labels: "[]",
  dependsOn: "[]",
  resumeDependsOn: "[]",
  agentType: "claude",
  autoTitle: false,
  createdAt: ts,
  updatedAt: ts,
};

await db.insert(projects).values([
  { id: "proj", name: "删除测试项目", repoPath: repo, apiKeys: null, workflowId: null, createdAt: ts },
]);
await db.insert(tasks).values([
  { ...common, id: "task-main", parentId: null, mode: "single", useWorktree: false },
  { ...common, id: "task-peer", parentId: null, mode: "single", useWorktree: false },
  { ...common, id: "task-archived", parentId: null, mode: "single", useWorktree: false, archived: true },
  // 该有独立 worktree、但目录还没建出来 → taskFileRoot 回落到项目主仓。
  { ...common, id: "task-未开工", parentId: null, mode: "single", useWorktree: true, worktreeBase: "main" },
]);

const request = async (method: string, path: string, body?: unknown) => {
  const response = await app.request(`/api${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
};

const overview = (taskId: string, path: string) =>
  request("GET", `/tasks/${taskId}/file/overview?path=${encodeURIComponent(path)}`);
const remove = (taskId: string, path: string, extra: Record<string, unknown> = {}) =>
  request("DELETE", `/tasks/${taskId}/file`, { path, mode: "permanent", ...extra });

let failures = 0;
const check = (name: string, run: () => void | Promise<void>) => (async () => {
  try {
    await run();
    console.log(`✓ ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
  }
})();

// ── overview：说的话得跟磁盘对得上 ──────────────────────────────────────────
await check("overview 认得出已跟踪、改过、未跟踪三种文件", async () => {
  const tracked = await overview("task-main", "src/tracked.ts");
  assert.equal(tracked.status, 200);
  assert.equal((tracked.json.target as Record<string, unknown>).kind, "file");
  assert.deepEqual(
    { ...(tracked.json.git as Record<string, unknown>), untrackedSamples: undefined, error: undefined },
    { repo: true, tracked: 1, dirty: 0, untracked: 0, untrackedSamples: undefined, error: undefined },
    "干净的已跟踪文件：能从提交里找回来",
  );

  const dirty = await overview("task-main", "src/dirty.ts");
  assert.equal((dirty.json.git as { dirty: number }).dirty, 1, "改过没提交要数出来");

  const fresh = await overview("task-main", "src/fresh.ts");
  assert.deepEqual(
    [(fresh.json.git as { tracked: number }).tracked, (fresh.json.git as { untracked: number }).untracked],
    [0, 1],
    "没进过 git 的文件：git 里没有备份，对话框要为此变红",
  );
});

await check("overview 对文件夹给递归统计和这一层的子项", async () => {
  const folder = await overview("task-main", "scratch");
  assert.equal((folder.json.target as { kind: string }).kind, "dir");
  const stats = folder.json.stats as { files: number; dirs: number; bytes: number };
  assert.equal(stats.files, 2, "a.log + nested/b.log");
  assert.equal(stats.dirs, 1, "nested");
  assert.equal(stats.bytes, 150, "字节数是递归加出来的");
  assert.equal((folder.json.git as { untracked: number }).untracked, 2, "整个目录都没进过 git");
  const entries = folder.json.entries as { name: string }[];
  assert.deepEqual(entries.map((entry) => entry.name).sort(), ["a.log", "nested"], "详情页要列出这一层");
  assert.ok(folder.json.trash, "去向信息要一起给，按钮上的话按它写");
});

// ── 跟任务状态无关的三条硬拒 ────────────────────────────────────────────────
await check("工作目录本身 / .git / 越界路径一律拒", async () => {
  for (const path of ["", ".", "./"]) {
    const result = await remove("task-main", path);
    assert.equal(result.status, 400, `根目录不能删：${JSON.stringify(path)}`);
  }
  const dotGit = await remove("task-main", ".git");
  assert.equal(dotGit.status, 400, ".git 不能删");
  assert.ok(existsSync(join(repo, ".git")), ".git 还在");
  const nested = await remove("task-main", ".git/config");
  assert.equal(nested.status, 400, ".git 里面的也不能删");
  const escape = await remove("task-main", "../outside.txt");
  assert.equal(escape.status, 400, "越界路径不能删");
  assert.ok(existsSync(outsideTarget), "工作区外面的文件没被碰");
  const missing = await remove("task-main", "src/不存在.ts");
  assert.equal(missing.status, 404);
});

// 名字里的空格是名字的一部分，不是「脏数据」。曾经在解析时 trim 过一次：用户点着
// `" spaced.txt"` 按删除，后端删掉的是旁边那个 `"spaced.txt"`，被点中的那个还在——
// 永久删除那一档没有后悔药，所以这条必须钉住。
await check("名字前后的空格是名字本身，不许被削掉", async () => {
  const seen = await overview("task-main", " spaced.txt");
  assert.equal(seen.status, 200);
  assert.equal((seen.json.target as { name: string }).name, " spaced.txt", "overview 就不该改写用户给的名字");

  const gone = await remove("task-main", " spaced.txt");
  assert.equal(gone.status, 200);
  assert.equal((gone.json as { name: string }).name, " spaced.txt");
  assert.ok(!existsSync(join(repo, " spaced.txt")), "被点中的那个要没");
  assert.ok(existsSync(join(repo, "spaced.txt")), "旁边那个同名文件不许受牵连");
});

// ── 只读档：force 也不解 ───────────────────────────────────────────────────
await check("归档任务的工作区冻结，force 也不解", async () => {
  const plain = await remove("task-archived", "keep.txt");
  assert.equal(plain.status, 409);
  assert.match(String(plain.json.error), /归档/);
  const forced = await remove("task-archived", "keep.txt", { force: true });
  assert.equal(forced.status, 409, "force 是给「在飞」用的，解不开冻结");
  assert.ok(existsSync(join(repo, "keep.txt")));
});

await check("回落到项目主仓时只读", async () => {
  const result = await remove("task-未开工", "keep.txt");
  assert.equal(result.status, 409);
  assert.match(String(result.json.error), /主仓|工作区/);
  assert.ok(existsSync(join(repo, "keep.txt")), "项目主工作区里的文件没被动");
});

// ── 在飞档：要 force ──────────────────────────────────────────────────────
await check("目录上有任务在跑：无 force 拒绝、带 force 放行", async () => {
  // 在飞的是**兄弟任务**：工作目录不是一个任务的私产，只问自己就会把对面的成果抹掉。
  await db.insert(sessions).values([{
    id: "sess-peer", taskId: "task-peer", role: "main", agentType: "claude", executor: "claude",
    cwd: repo, startedAt: ts,
  }]);
  await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, "task-peer"));

  const blocked = await remove("task-main", "src/fresh.ts");
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.needsForce, true, "前端据此弹确认框，而不是报一个失败");
  assert.match(String(blocked.json.error), /task-peer|删除测试/, "得报出是谁在跑");
  assert.ok(existsSync(join(repo, "src", "fresh.ts")));

  const overviewWhileBusy = await overview("task-main", "src/fresh.ts");
  assert.equal((overviewWhileBusy.json.busy as { running: boolean }).running, true, "对话框要提前知道有人在写");

  const forced = await remove("task-main", "src/fresh.ts", { force: true });
  assert.equal(forced.status, 200, "用户明知故犯那一档得放行");
  assert.equal(existsSync(join(repo, "src", "fresh.ts")), false);

  await db.update(tasks).set({ status: "backlog" }).where(eq(tasks.id, "task-peer"));
  await db.delete(sessions).where(eq(sessions.taskId, "task-peer"));
});

// ── 真删 ─────────────────────────────────────────────────────────────────
await check("删文件：磁盘上真没了，回执说清删了什么", async () => {
  const result = await remove("task-main", "src/dirty.ts");
  assert.equal(result.status, 200);
  assert.deepEqual(
    { mode: result.json.mode, kind: result.json.kind, name: result.json.name },
    { mode: "permanent", kind: "file", name: "dirty.ts" },
  );
  assert.equal(existsSync(join(repo, "src", "dirty.ts")), false);
  assert.match(git("status", "--porcelain"), /D\s+src\/dirty\.ts/, "已跟踪文件删完会变成一条 deleted 改动——那正是它的后悔药");
});

await check("删文件夹：连里面的东西一起没", async () => {
  const result = await remove("task-main", "scratch");
  assert.equal(result.status, 200);
  assert.equal(result.json.kind, "dir");
  assert.equal(existsSync(join(repo, "scratch")), false);
});

await check("软链只删链接本身，不碰它指向的目标", async () => {
  const result = await remove("task-main", "link-outside");
  assert.equal(result.status, 200);
  assert.equal(existsSync(join(repo, "link-outside")), false);
  assert.ok(existsSync(outsideTarget), "链接指向的目标必须还在");
  assert.equal(readFileSync(outsideTarget, "utf8"), "我在工作区外面\n");
});

if (failures) {
  console.error(`\n${failures} 条没过`);
  process.exit(1);
}
console.log("\n全部通过");
process.exit(0);
