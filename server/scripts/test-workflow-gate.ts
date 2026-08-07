// 一条把「等我点头」画在「自动验证」前面的线，在**真数据库 + 真 git 仓库**上走两条路：
// ① 推进器（干活结算之后必须停在关口，不许自己往下验、更不许自己合）；
// ② 用户真按下去那条路（acceptTask：这一按是放行，不是验收——不合并、不清理）。
//
// **两条路各有一套「这是不是最后一道关口」的判断，必须一起钉**。2026-08-05 那次事故就
// 是分两段爆的：先是推进器按锚点类型硬排「验证 → 关口 → 合并」，关口被整个跳过；修完
// 之后线老老实实停在了关口，可 acceptTask 的判据仍写着「后面还有没有别的**等我点头**」
// ——这条线只有一道关口，于是那一按被当成最终验收，直接合并 + 删 worktree + 删分支，
// 中间那站「自动验证」从没跑过，面板上却显示它已过（见 docs/incidents.md「关口画在
// 验证前面就被跳过」）。同一个错误模型换个地方又活了一次，所以两条路都得有红灯。
//
// 为什么单独一个文件而不是并进 test-workflow-run.ts：那边全是纯函数（段落切分、
// 轮数、验收计划），这边要真的建库、建仓库、建 worktree、看游标和 git ref 落在哪。
// 两种测试的启动代价差一个量级，混在一起会让纯函数那批也跟着变慢。
// Run: npm -w server run test:workflow-gate
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "harness-workflow-gate-"));
process.env.HARNESS_DB = join(root, "harness.db");
process.env.HARNESS_RUNS_DIR = join(root, "runs");
// 段落里那条命令要有地方跑：给一个真的 git 仓库当项目根目录。
const repo = join(root, "repo");
execFileSync("git", ["init", "-q", repo]);

const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks } = await import("../src/db/schema.js");
const { eq } = await import("drizzle-orm");
const { advanceWorkflowFrom } = await import("../src/workflow-advance.js");
const { taskWorkflowDef } = await import("../src/workflows.js");

await ensureSchema();

const at = new Date().toISOString();
await db.insert(projects).values({
  id: "p1", name: "gate", repoPath: repo, createdAt: at, updatedAt: at,
});

// 用户亲手画的顺序：干活 → 跑一条命令 → **等我点头** → 自动验证 → 合并并清理。
// 关口在验证**前面**，这正是老推进器读不出来的那一种。
const line = {
  workspace: "isolated" as const,
  steps: [
    { id: "s1", kind: "run", p: { instruction: null, executorId: null, model: null, reasoningEffort: null }, fail: null },
    { id: "s2", kind: "command", p: { cmd: "true", where: "workspace" }, fail: { mode: "stop", max: 2 } },
    { id: "s3", kind: "human", p: { show: [], notify: [] }, fail: null },
    { id: "s4", kind: "verify", p: { executorId: null, model: null, reasoningEffort: null, checks: [] }, fail: { mode: "stop", max: 1 } },
    { id: "s5", kind: "accept", p: { strategy: "safe", clean: "all" }, fail: { mode: "stop", max: 2 } },
  ],
};

async function makeTask(id: string): Promise<void> {
  await db.insert(tasks).values({
    id,
    projectId: "p1",
    title: "关口画在验证前面",
    body: "",
    mode: "single",
    status: "done",
    stage: null,
    priority: "none",
    labels: "[]",
    dependsOn: "[]",
    resumeDependsOn: "[]",
    agentType: "claude",
    autoTitle: false,
    useWorktree: false,
    workflow: JSON.stringify(line),
    workflowAt: null,
    createdAt: at,
    updatedAt: at,
  });
}

const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;
const noAgent = { startVerifyRound: async () => ({ round: 1 }) };

// ── ① 干活结算之后：跑完命令那一段，停在关口 ─────────────────────────────
await makeTask("t1");
await advanceWorkflowFrom(await row("t1"), taskWorkflowDef(JSON.stringify(line)), "s1", noAgent);
const stopped = await row("t1");

assert.equal(stopped.workflowAt, "s3", "游标必须停在用户画的那道「等我点头」上");
assert.equal(stopped.stage, "awaiting_acceptance", "停在关口 = 待验收，等人来点");
assert.equal(stopped.verifyRound, null, "**没点头就不许开验证**：这一站的下一步是人，不是验证者");
assert.notEqual(stopped.stage, "accepted", "更不许自己合并");

// ── ② 人点了「放行」之后：这才轮到验证站 ─────────────────────────────────
// 这里只验「游标挪到了验证站」，显式注入 no-op 验证副作用，绝不启真 CLI。
await advanceWorkflowFrom(await row("t1"), taskWorkflowDef(JSON.stringify(line)), "s3", noAgent);
assert.equal((await row("t1")).workflowAt, "s4", "点过头之后才走到验证站");

// ── ③ 关口在验证**后面**（自带起手式那种）照旧 ───────────────────────────
const classic = {
  workspace: "isolated" as const,
  steps: [
    line.steps[0],
    { id: "c2", kind: "verify", p: { executorId: null, model: null, reasoningEffort: null, checks: [] }, fail: { mode: "stop", max: 1 } },
    { id: "c3", kind: "human", p: { show: [], notify: [] }, fail: null },
  ],
};
await makeTask("t2");
await db.update(tasks).set({ workflow: JSON.stringify(classic) }).where(eq(tasks.id, "t2"));
await advanceWorkflowFrom(await row("t2"), taskWorkflowDef(JSON.stringify(classic)), "s1", noAgent);
assert.equal((await row("t2")).workflowAt, "c2", "老顺序不变：干完先去验证站");
assert.notEqual((await row("t2")).stage, "awaiting_acceptance", "验证站还没验完，不该先跳到关口");

// ── ④ 停在这道关口上点「验收通过」：是**放行**，不是合并 ──────────────────
// ①②走的是推进器；这一段走的是**用户真按下去的那条路**（acceptTask）。两条路各有一
// 个「这是不是最后一道关口」的判断，②过了不代表④过：2026-08-05 第二段事故就是推进器
// 已经修好、老老实实停在了关口，而 acceptTask 的判据仍写着「后面还有没有别的**等我
// 点头**」——这条线只有一道关口，于是那一按被当成最终验收，直接合并 + 删 worktree +
// 删分支，用户亲手画在中间的「自动验证」被整站跳过（面板上还显示它已过）。
const repo2 = join(root, "repo2");
execFileSync("git", ["init", "-q", "-b", "main", repo2]);
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
git(repo2, "config", "user.name", "Harness Gate Test");
git(repo2, "config", "user.email", "gate@example.test");
writeFileSync(join(repo2, ".gitignore"), ".worktrees/\n");
git(repo2, "add", "-A");
git(repo2, "commit", "-q", "-m", "seed");
const mainBefore = git(repo2, "rev-parse", "main");

await db.insert(projects).values({
  id: "p2", name: "gate-accept", repoPath: repo2, createdAt: at, updatedAt: at,
});

const { prepareWorktree, worktreeBranchName } = await import("../src/git.js");
const { acceptTask } = await import("../src/task-accept.js");

const gateTask = "gaterel00001";
await makeTask(gateTask);
await db.update(tasks)
  .set({ projectId: "p2", useWorktree: true, workflowAt: "s3", stage: "awaiting_acceptance" })
  .where(eq(tasks.id, gateTask));
const ws = await prepareWorktree(repo2, gateTask, "main");
writeFileSync(join(ws.path, "work.txt"), "产物\n");
git(ws.path, "add", "-A");
git(ws.path, "commit", "-q", "-m", "干完了");

const released = await acceptTask(gateTask, "human", noAgent);
assert.equal(released.accepted, true);
assert.equal(released.kind, "gate_released", "关口后面还画着「自动验证」，这一按只能是放行");
// 三条不可逆的事，一条都不许发生
assert.equal(git(repo2, "rev-parse", "main"), mainBefore, "**没走完的线不许合并**：main 必须一动没动");
assert.equal(existsSync(ws.path), true, "worktree 不许清掉——后面那站验证还要在里面跑");
assert.doesNotThrow(
  () => git(repo2, "show-ref", "--verify", "--quiet", `refs/heads/${worktreeBranchName(gateTask)}`),
  "任务分支不许删",
);
// 放行之后线要真往下走：游标落到验证站，那一站才是「自动验证」真正开始的地方
const after = await row(gateTask);
assert.equal(after.workflowAt, "s4", "放行之后游标必须挪到「自动验证」");
assert.notEqual(after.stage, "accepted", "放行不是验收完成");
assert.notEqual(after.stage, "merged", "放行更不是已合并");

console.log("workflow gate ok");
dbClient.close();
rmSync(root, { recursive: true, force: true });
