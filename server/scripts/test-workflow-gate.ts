// 推进器在**真数据库**上走一遍：一条把「等我点头」画在「自动验证」前面的线，
// 干活结算之后必须**停在关口**，不许自己往下验、更不许自己合。
//
// 为什么单独一个文件而不是并进 test-workflow-run.ts：那边全是纯函数（段落切分、
// 轮数、验收计划），这边要真的建库、建任务、跑段落、看游标落在哪。两种测试的启动
// 代价差一个量级，混在一起会让纯函数那批也跟着变慢。
//
// 钉住的是 2026-08-05 那次「关口被跳过」的根因（见 docs/incidents.md「关口画在验证
// 前面就被跳过」）：早先推进器按**锚点类型**决定下一步，顺序写死成「验证 → 关口 →
// 合并」，用户画的顺序根本没人读；`workflowPolicy.humanGate` 更是要求 human 排在
// verify **之后**才算数，所以关口画在前面时整条线被判成「没写等我点头」，一路自动
// 验证 + 自动合并到底。改成按站 id 走之后，这个文件负责让它别再退回去。
// Run: npm -w server run test:workflow-gate
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "harness-workflow-gate-"));
process.env.HARNESS_DB = join(root, "harness.db");
// 段落里那条命令要有地方跑：给一个真的 git 仓库当项目根目录。
const repo = join(root, "repo");
execFileSync("git", ["init", "-q", repo]);

const { db, ensureSchema } = await import("../src/db/index.js");
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

// ── ① 干活结算之后：跑完命令那一段，停在关口 ─────────────────────────────
await makeTask("t1");
await advanceWorkflowFrom(await row("t1"), taskWorkflowDef(JSON.stringify(line)), "s1");
const stopped = await row("t1");

assert.equal(stopped.workflowAt, "s3", "游标必须停在用户画的那道「等我点头」上");
assert.equal(stopped.stage, "awaiting_acceptance", "停在关口 = 待验收，等人来点");
assert.equal(stopped.verifyRound, null, "**没点头就不许开验证**：这一站的下一步是人，不是验证者");
assert.notEqual(stopped.stage, "accepted", "更不许自己合并");

// ── ② 人点了「放行」之后：这才轮到验证站 ─────────────────────────────────
// 验证站真开起来会拉 CLI，所以这里只验「游标挪到了验证站」这一步：atVerifyStation
// 先 setWorkflowAt 再 startVerifyRound，起不起得来都不影响游标这个断言。
await advanceWorkflowFrom(await row("t1"), taskWorkflowDef(JSON.stringify(line)), "s3");
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
await advanceWorkflowFrom(await row("t2"), taskWorkflowDef(JSON.stringify(classic)), "s1");
assert.equal((await row("t2")).workflowAt, "c2", "老顺序不变：干完先去验证站");
assert.notEqual((await row("t2")).stage, "awaiting_acceptance", "验证站还没验完，不该先跳到关口");

console.log("workflow gate ok");
rmSync(root, { recursive: true, force: true });
// 断言都在游标上，验证站起不起得来无所谓；但 t2 走到验证站会**异步**排一轮起跑，
// 库刚被删掉，它落地时会喷一串 SQLITE_READONLY_DBMOVED。断言过了就直接退，别让
// 这串跟测试无关的噪音盖住结论。
process.exit(0);
