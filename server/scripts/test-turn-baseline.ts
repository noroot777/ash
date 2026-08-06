// 「这一轮到底产出新一版没有」的前后快照比对，在**真数据库 + 真 git 仓库**上钉住。
//
// 病根（2026-08-06）：任务验收合并完，用户再发一条消息让 agent 改点东西。改完 agent
// 确认完成，线接着往下走 —— 可账本上记的还是**上一版**的成绩：那一站验证已经跑满轮数，
// `verifyStationAction` 判 skip 整站略过；「等我点头」看见 stage 是 merged/accepted 也
// 静默放行。于是没人验过的新代码被自动合并、分支被删，而用户以为它还会走一遍流程。
//
// 三条是这套判据的全部要害，改动任何一条都必须让这里先红：
//   ① 改了代码 + 确认完成 → 账本必须**整个**清干净（游标、轮数、review_step、stage
//      四样少清一样，新代码都还能从那个缺口溜过去）；
//   ② 只是问了句话 → 线**一个字节都不许动**（否则纯询问会把用户辛苦走到的位置打回起点）；
//   ③ 验证没过时用户插进来指点 → **不清零**（用户拍板）。那还是同一版在修，清零的话
//      轮数上限就形同虚设：每被打回一次说句话，就能无限重验。
//
// 另外钉住「拆屋」：为接住一句话临时建的空壳 worktree，agent 一个字没改就该删掉 ——
// 这个任务早已验收过、不会再验收第二次，不在这儿删就永远没人删了，而用户看不见它。
// Run: npm -w server run test:turn-baseline
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "harness-turn-baseline-"));
process.env.HARNESS_DB = join(root, "harness.db");
const repo = join(root, "repo");
execFileSync("git", ["init", "-q", repo]);
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
git("config", "user.email", "t@example.com");
git("config", "user.name", "t");
writeFileSync(join(repo, "seed.txt"), "seed\n");
git("add", "-A");
git("commit", "-qm", "seed");

const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks } = await import("../src/db/schema.js");
const { eq } = await import("drizzle-orm");
const { RUNS_DIR } = await import("../src/paths.js");
const { recordTurnBaseline, reconcileTurnBaseline } = await import("../src/turn-baseline.js");

const IDS = ["tb-changed", "tb-asked", "tb-verify-failed", "tb-unconfirmed", "tb-shell01"];

try {
  await ensureSchema();
  const at = new Date().toISOString();
  await db.insert(projects).values({ id: "p1", name: "baseline", repoPath: repo, createdAt: at, updatedAt: at });

  // 干活 → 自动验证 → 等我点头 → 合并并清理。就是出事那条线的形状
  //（闸要求 accept 前面必须有一道 human，所以最短的真线就长这样）。
  const line = {
    workspace: "isolated" as const,
    steps: [
      { id: "s1", kind: "run", p: { instruction: null, executorId: null, model: null, reasoningEffort: null }, fail: null },
      { id: "s2", kind: "verify", p: { executorId: null, model: null, reasoningEffort: null, checks: [] }, fail: { mode: "stop", max: 2 } },
      { id: "s3", kind: "human", p: { show: [], notify: [] }, fail: null },
      { id: "s4", kind: "accept", p: { strategy: "safe", clean: "all" }, fail: { mode: "stop", max: 2 } },
    ],
  };

  // 「上一版已经跑完并合并了」的账本：线走到头停在验证站、这一站验过 2 轮、stage 已 merged。
  async function makeSettledTask(id: string, stage: string | null): Promise<void> {
    await db.insert(tasks).values({
      id,
      projectId: "p1",
      title: id,
      body: "",
      mode: "single",
      status: "done",
      stage,
      priority: "none",
      labels: "[]",
      dependsOn: "[]",
      resumeDependsOn: "[]",
      agentType: "claude",
      autoTitle: false,
      useWorktree: false,
      workflow: JSON.stringify(line),
      workflowAt: "s2",
      verifyStationRounds: 2,
      reviewStep: "s2",
      createdAt: at,
      updatedAt: at,
    });
  }
  const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;

  // ── ① 改了代码 + 确认完成 → 账本整个清干净 ───────────────────────────────
  await makeSettledTask("tb-changed", "merged");
  await recordTurnBaseline("tb-changed", repo, false);
  writeFileSync(join(repo, "agent-wrote-this.txt"), "new version\n"); // agent 干了活
  await reconcileTurnBaseline("tb-changed", true);

  const cleared = await row("tb-changed");
  assert.equal(cleared.workflowAt, "s1", "游标必须搬回「让 AI 干活」那一站，让新改动重走一遍");
  assert.notEqual(cleared.workflowAt, null, "**不能清成 null** —— 前端无游标时按 status 猜位置，反而显示成已走过第一站");
  assert.equal(cleared.verifyStationRounds, 0, "上一版验过几轮不能算在新版头上，否则验证站被判 skip");
  assert.equal(cleared.reviewStep, null, "轮数的另一半载体也要清，只清一个仍会被算进 stationRounds");
  assert.equal(cleared.stage, null, "merged/accepted 留着的话，「等我点头」那道关口会静默放行");

  // ── ② 只问了句话 → 线一个字节都不许动 ────────────────────────────────────
  await makeSettledTask("tb-asked", "merged");
  await recordTurnBaseline("tb-asked", repo, false);
  await reconcileTurnBaseline("tb-asked", true); // 工作区一个字节没变

  const untouched = await row("tb-asked");
  assert.equal(untouched.workflowAt, "s2", "纯询问不该把游标打回起点");
  assert.equal(untouched.verifyStationRounds, 2, "纯询问不该清零验证轮数");
  assert.equal(untouched.reviewStep, "s2", "纯询问不该动 review_step");
  assert.equal(untouched.stage, "merged", "纯询问不该撤销上一版的验收结论");

  // ── ③ 验证没过时用户插手 → 不清零（用户 2026-08-06 拍板） ────────────────
  await makeSettledTask("tb-verify-failed", "verify_failed");
  await recordTurnBaseline("tb-verify-failed", repo, false);
  writeFileSync(join(repo, "fix-attempt.txt"), "still the same version\n");
  await reconcileTurnBaseline("tb-verify-failed", true);

  const stillFailing = await row("tb-verify-failed");
  assert.equal(stillFailing.verifyStationRounds, 2, "验证没过是**同一版在修**，清零会让轮数上限形同虚设");
  assert.equal(stillFailing.workflowAt, "s2", "还停在那一站上，不是新开一版");
  assert.equal(stillFailing.stage, "verify_failed", "结论还没被推翻，别替它翻篇");

  // ── ④ 改了但 agent 没确认完成 → 什么都不动 ───────────────────────────────
  await makeSettledTask("tb-unconfirmed", "merged");
  await recordTurnBaseline("tb-unconfirmed", repo, false);
  writeFileSync(join(repo, "half-done.txt"), "interrupted\n");
  await reconcileTurnBaseline("tb-unconfirmed", false);

  const halfway = await row("tb-unconfirmed");
  assert.equal(halfway.workflowAt, "s2", "这一轮压根没走完，线不该被搬动");
  assert.equal(halfway.verifyStationRounds, 2, "没确认完成就清账 = 一次中断就把上一版的成绩抹了");

  // ── ⑤ 空壳工作间没被动过 → 拆屋 ──────────────────────────────────────────
  const shellId = "tb-shell01";
  const shellPath = join(repo, ".worktrees", shellId);
  const shellBranch = `harness/${shellId.slice(0, 8)}`;
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", shellBranch, shellPath]);
  await db.insert(tasks).values({
    id: shellId,
    projectId: "p1",
    title: shellId,
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
    useWorktree: true,
    createdAt: at,
    updatedAt: at,
  });
  assert.ok(existsSync(shellPath), "前置条件：空壳工作间确实建出来了");

  await recordTurnBaseline(shellId, shellPath, true); // fresh = 这一轮才凭空建的
  await reconcileTurnBaseline(shellId, false); // 里面一个字没改

  assert.equal(existsSync(shellPath), false, "没产出任何东西的临时工作间必须删掉，不然永远没人清它");
  assert.equal(
    git("branch", "--list", shellBranch).trim(),
    "",
    "零提交的空分支跟着一起删 —— 它在界面上没有任何入口，留着就是纯垃圾",
  );

  console.log("turn baseline: 改了就清账 / 只问不动 / 验证没过不清零 / 未确认不动 / 空壳拆屋，五条通过");
} finally {
  for (const id of IDS) rmSync(join(RUNS_DIR, id), { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
