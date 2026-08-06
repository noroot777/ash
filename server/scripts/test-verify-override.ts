// 「人工强制通过这一站自动验证」在**真数据库 + 真 git 仓库**上走一遍。
//
// 这一按的全部风险都在「按完会发生什么」上：它不是把一个 stage 从 verify_failed 改成
// verified 就完事，而是要把这一站之后那一段真的跑掉——线上画着「合并并清理」时，这一
// 按就是**不可逆的合并**。所以这里的红灯分两类：
//
// ① 该往下走的走到位（游标、stage、下一个锚点是关口就停在关口）；
// ② 不该受理的一律挡回（游标不在验证站、任务还在跑），别让它变成一个「随时能按的
//    万能放行键」——那样人工关口和验证站就都白画了。
//
// 另有一条容易在重构里丢掉的：**证据不许被改**。签字的是人，那一轮验证的报告和轮数
// 账本要原样留着，否则日后没人分得清哪一轮是验证器真验过的。
// Run: npm -w server run test:verify-override
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "harness-verify-override-"));
process.env.HARNESS_DB = join(root, "harness.db");
const repo = join(root, "repo");
execFileSync("git", ["init", "-q", repo]);

const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks } = await import("../src/db/schema.js");
const { eq } = await import("drizzle-orm");
const { forcePassVerifyStation } = await import("../src/verify-override.js");

await ensureSchema();

const at = new Date().toISOString();
await db.insert(projects).values({
  id: "p1", name: "override", repoPath: repo, createdAt: at, updatedAt: at,
});

const runStep = {
  id: "s1", kind: "run",
  p: { instruction: null, executorId: null, model: null, reasoningEffort: null },
  fail: null,
};
const verifyStep = {
  id: "s2", kind: "verify",
  p: { executorId: null, model: null, reasoningEffort: null, checks: [] },
  fail: { mode: "back", max: 2 },
};

// 干活 → 自动验证 → 等我点头：强制通过之后应当停在关口，什么都不合。
const gated = { workspace: "isolated" as const, steps: [runStep, verifyStep, { id: "s3", kind: "human", p: { show: [], notify: [] }, fail: null }] };
// 干活 → **等我点头** → 自动验证 → 合并并清理：关口画在验证前面（图一那条线的形状，
// 闸也只要求 accept 之前某处有过 human，不要求紧邻）。这条线上验证站后面直接就是合并，
// 强制通过 = **真合并 + 清 worktree**，没有第二道闸拦着。
const merging = {
  workspace: "isolated" as const,
  steps: [
    runStep,
    { id: "m2", kind: "human", p: { show: [], notify: [] }, fail: null },
    verifyStep,
    { id: "m4", kind: "accept", p: { strategy: "safe", clean: "all" }, fail: { mode: "stop", max: 2 } },
  ],
};

async function makeTask(id: string, line: unknown, extra: Record<string, unknown> = {}): Promise<void> {
  await db.insert(tasks).values({
    id,
    projectId: "p1",
    title: "验证卡住了",
    body: "",
    mode: "single",
    status: "done",
    stage: "verify_failed",
    priority: "none",
    labels: "[]",
    dependsOn: "[]",
    resumeDependsOn: "[]",
    agentType: "claude",
    autoTitle: false,
    useWorktree: false,
    workflow: JSON.stringify(line),
    workflowAt: "s2",
    verifyRounds: 2,
    verifyStationRounds: 2,
    reviewStep: "s2",
    createdAt: at,
    updatedAt: at,
    ...extra,
  });
}

const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;

// ── ① 轮数用尽（图二那种）：签字之后停在下一道关口 ────────────────────────
await makeTask("t1", gated);
const forced = await forcePassVerifyStation("t1");
assert.equal("forced" in forced, true, `强制通过应当受理，实得：${JSON.stringify(forced)}`);
const t1 = await row("t1");
assert.equal(t1.workflowAt, "s3", "签字之后必须真往下走，停在下一个锚点（这条线上是「等我点头」）");
assert.equal(t1.stage, "awaiting_acceptance", "走到关口就该是待验收，等人来点");
// 证据与账本原样保留：签字的是人，不是验证器
assert.equal(t1.verifyRounds, 2, "已跑完的验证轮数不许被改");
assert.equal(t1.verifyStationRounds, 2, "这一站验过几轮不许被抹掉（抹掉等于伪造一次没验过）");

// ── ② 游标不在验证站上：一律挡回 ─────────────────────────────────────────
// 这条红灯就是「别把它做成万能放行键」：t1 此刻停在人工关口上，再按一次不许穿过去。
const wrongStop = await forcePassVerifyStation("t1");
assert.equal("forced" in wrongStop, false, "游标已经离开验证站，不该还能强制通过");
assert.equal((wrongStop as { httpStatus: number }).httpStatus, 409);

// ── ③ 任务还在跑：挡回 ───────────────────────────────────────────────────
// 那一轮验证可能下一秒就有结论，此刻签字既是跟它抢方向盘，往下跑的那一段又会撞进
// 同一个工作目录。
await makeTask("t2", gated, { status: "running", verifyRound: 3, stage: "verifying" });
const running = await forcePassVerifyStation("t2");
assert.equal("forced" in running, false, "running 的任务不许强制通过");
assert.equal((running as { httpStatus: number }).httpStatus, 409);

// ── ④ 一轮验证卡在半路（任务已停、verify_round 还挂着）：签字时一并收尾 ────
// 不收的话任务身上永远显示「正在验证」，而那一轮再也不会有结论了。
await makeTask("t3", gated, { verifyRound: 3, stage: "verifying", question: "要不要继续？" });
const stale = await forcePassVerifyStation("t3");
assert.equal("forced" in stale, true, `半路卡住的那一轮不该挡住签字，实得：${JSON.stringify(stale)}`);
const t3 = await row("t3");
assert.equal(t3.verifyRound, null, "没有结论的那一轮要摘掉，否则任务永远显示「正在验证」");
assert.equal(t3.verifyRounds, 2, "**没跑完的轮不计数**：它不该占掉用户写的轮数额度");
assert.equal(t3.question, null, "那一回合早已结束，提问卡片不该继续挂着等人答");
assert.equal(t3.workflowAt, "s3", "照样往下走");

// ── ⑤ 线上写着「合并并清理」：这一按是**真合并**（前端确认框要照实说的那件事）──
const repo2 = join(root, "repo2");
execFileSync("git", ["init", "-q", "-b", "main", repo2]);
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
git(repo2, "config", "user.name", "Harness Override Test");
git(repo2, "config", "user.email", "override@example.test");
writeFileSync(join(repo2, ".gitignore"), ".worktrees/\n");
git(repo2, "add", "-A");
git(repo2, "commit", "-q", "-m", "seed");
const mainBefore = git(repo2, "rev-parse", "main");

await db.insert(projects).values({
  id: "p2", name: "override-merge", repoPath: repo2, createdAt: at, updatedAt: at,
});

const { prepareWorktree } = await import("../src/git.js");
const mergeTask = "override00001";
await makeTask(mergeTask, merging, { projectId: "p2", useWorktree: true });
const ws = await prepareWorktree(repo2, mergeTask, "main");
writeFileSync(join(ws.path, "work.txt"), "产物\n");
git(ws.path, "add", "-A");
git(ws.path, "commit", "-q", "-m", "干完了");

const merged = await forcePassVerifyStation(mergeTask);
assert.equal("forced" in merged, true, `这条线上的强制通过应当受理，实得：${JSON.stringify(merged)}`);
assert.notEqual(git(repo2, "rev-parse", "main"), mainBefore, "线上画了「合并并清理」，强制通过就该真合进去");
assert.equal(existsSync(ws.path), false, "「合并并清理」写的是 clean=all，worktree 该随之清掉");
assert.equal((await row(mergeTask)).stage, "accepted", "合完就是验收完成");

console.log("verify override ok");
rmSync(root, { recursive: true, force: true });
process.exit(0);
