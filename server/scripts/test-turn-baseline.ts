// 「这一轮到底产出新一版没有」的前后快照比对，在**真数据库 + 真 git 仓库**上钉住。
//
// 病根（2026-08-06）：任务验收合并完，用户再发一条消息让 agent 改点东西。改完 agent
// 确认完成，线接着往下走 —— 可账本上记的还是**上一版**的成绩：那一站验证已经跑满轮数，
// `verifyStationAction` 判 skip 整站略过；「等我点头」看见 stage 是 merged/accepted 也
// 静默放行。于是没人验过的新代码被自动合并、分支被删，而用户以为它还会走一遍流程。
//
// 四条是这套判据的全部要害，改动任何一条都必须让这里先红：
//   ① **清账在回合开头就发生**，不等结算（2026-08-07 第二次改，实测任务 nInnSY6WiMoS）。
//      判据没错、时机错了一样出事：一个回合要跑几十分钟，这整段时间账本还记着上一版的
//      成绩，游标停在验证站上 —— 那一站的「再验一轮」「人工强制通过」此刻就能点，点下去
//      直接跑完 accept 段，**把一个正在被 agent 改写的分支合并掉、再删掉它脚下的 worktree**。
//      所以这里的断言全都排在 `recordTurnBaseline` 之后、`reconcileTurnBaseline` 之前；
//   ② 改了代码 → 账本必须**整个**清干净（游标、轮数、review_step、stage 四样少清一样，
//      新代码都还能从那个缺口溜过去）。**跟这一轮确认没确认完成无关**：续聊回合本来就
//      不要求确认（followUpFrom 会回落到原终态），按确认与否决定清不清，最常见的那条路
//      恰好一个字都不清（2026-08-07，任务 1rojF5Tjau91）；
//   ③ 只是问了句话 → 结算后线**一个字节都不许动**（否则纯询问会把用户辛苦走到的位置打回
//      起点）。现在是「开头先清、照片一样再原样放回」，所以这一条要连着两头一起断言。
//      并且**必须按 continueTask 的真实顺序调**（先摘牌再拍照），跳过入口直接调底层函数
//      会给出跟真实路径相反的保证 —— 上一版就是这么漏掉「纯询问也会摘掉已合并」的；
//   ④ 验证没过时用户插进来指点 → **不清零**（用户拍板）。那还是同一版在修，清零的话
//      轮数上限就形同虚设：每被打回一次说句话，就能无限重验。
//
// 另外钉住「拆屋」：为接住一句话临时建的空壳 worktree，agent 一个字没改就该删掉 ——
// 这个任务早已验收过、不会再验收第二次，不在这儿删就永远没人删了，而用户看不见它。
// Run: npm -w server run test:turn-baseline
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const { reopenAcceptedStage, setTaskStage } = await import("../src/task-stage.js");
const { recordTurnBaseline, reconcileTurnBaseline } = await import("../src/turn-baseline.js");

const IDS = ["tb-changed", "tb-asked", "tb-restaged", "tb-verify-failed", "tb-unconfirmed", "tb-legacy", "tb-shell01"];

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

  // ── ① 改了代码 → 账本整个清干净，而且**清在回合开头** ────────────────────
  // 这条**有意不走摘牌**：真实路径下 accepted/merged 早在回合开头就被摘了，这里留着牌子，
  // 顺带覆盖「摘牌管不着的那些 stage（verified 等）在清账时也得一起清」。
  await makeSettledTask("tb-changed", "merged");
  await recordTurnBaseline("tb-changed", repo, false);

  // ↓ 全部断言排在拍照之后、agent 还一个字没写之前 —— 这就是这次修复的要害：
  //   账必须在收到指令那一刻作废，而不是等它干完几十分钟后追认。
  const atStart = await row("tb-changed");
  assert.equal(atStart.workflowAt, "s1", "收到指令那一刻游标就得退回「让 AI 干活」，不能等结算");
  assert.notEqual(atStart.workflowAt, null, "**不能清成 null** —— 前端无游标时按 status 猜位置，反而显示成已走过第一站");
  assert.equal(atStart.verifyStationRounds, 0, "上一版验过几轮不能算在新版头上，否则验证站被判 skip");
  assert.equal(atStart.reviewStep, null, "轮数的另一半载体也要清，只清一个仍会被算进 stationRounds");
  assert.equal(
    atStart.stage,
    null,
    "牌子留到结算才摘的话，这几十分钟里游标停在验证站上 —— 那两颗按钮点下去会合并掉正在被改写的分支",
  );

  writeFileSync(join(repo, "agent-wrote-this.txt"), "new version\n"); // agent 干了活
  await reconcileTurnBaseline("tb-changed", true);

  const cleared = await row("tb-changed");
  assert.equal(cleared.workflowAt, "s1", "结算时照片不一样 → 开头清掉的保持清空，不许放回");
  assert.equal(cleared.verifyStationRounds, 0, "同上：改了字节就是新一版，轮数不能回来");
  assert.equal(cleared.reviewStep, null, "同上");
  assert.equal(cleared.stage, null, "merged/accepted 留着的话，「等我点头」那道关口会静默放行");

  // ── ② 只问了句话 → 结算后线一个字节都不许动 ──────────────────────────────
  // **必须按 continueTask 的真实顺序走**：真人消息进来先摘牌（orchestrator.ts 开头无条件
  // 调 reopenAcceptedStage），隔了近百行才拍照。上一版这条测试直接调后两个函数、跳过摘牌
  // 那一步，于是给出了跟真实路径**相反**的保证 —— 真跑起来纯询问照样把「已合并」摘掉，
  // 用户问一句话就得重新点一次验收（第 2 轮验收 P1）。新增函数时别再图省事跳过入口。
  await makeSettledTask("tb-asked", "merged");
  const reopened = await reopenAcceptedStage("tb-asked");
  assert.equal(reopened, "merged", "回合开头照旧摘牌（既有行为），但要把摘掉的是哪块交出来");
  assert.equal((await row("tb-asked")).stage, null, "前置条件：这时候牌子确实已经被摘掉了");
  await recordTurnBaseline("tb-asked", repo, false, reopened);
  assert.equal(
    (await row("tb-asked")).workflowAt,
    "s1",
    "前置条件：纯询问回合的账同样是开头就清的 —— 那会儿谁也不知道这一轮会不会动代码",
  );
  await reconcileTurnBaseline("tb-asked", true); // 工作区一个字节没变

  const untouched = await row("tb-asked");
  assert.equal(untouched.workflowAt, "s2", "纯询问白清一场，游标必须原样放回，不能停在起点");
  assert.equal(untouched.verifyStationRounds, 2, "纯询问不该清零验证轮数");
  assert.equal(untouched.reviewStep, "s2", "纯询问不该动 review_step");
  assert.equal(untouched.stage, "merged", "白摘的牌子必须挂回去，否则问一句话就得重新验收一次");

  // ── ②′ 这一轮 agent 自己报了新阶段 → 旧牌子不许盖回去 ────────────────────
  await makeSettledTask("tb-restaged", "accepted");
  const reopenedAgain = await reopenAcceptedStage("tb-restaged");
  await recordTurnBaseline("tb-restaged", repo, false, reopenedAgain);
  await setTaskStage("tb-restaged", "verified"); // agent 在这一轮 report_stage
  await reconcileTurnBaseline("tb-restaged", true);

  const restaged = await row("tb-restaged");
  assert.equal(restaged.stage, "verified", "这一轮报的结论比回合开头那块旧牌子新，恢复时不能盖掉它");
  assert.equal(restaged.workflowAt, "s2", "牌子没放回去，不影响游标那几样照常放回");

  // ── ③ 验证没过时用户插手 → 不清零（用户 2026-08-06 拍板） ────────────────
  await makeSettledTask("tb-verify-failed", "verify_failed");
  await recordTurnBaseline("tb-verify-failed", repo, false);
  const duringFix = await row("tb-verify-failed");
  assert.equal(duringFix.verifyStationRounds, 2, "回合开头这一档就该整个跳过，不是等结算才手下留情");
  assert.equal(duringFix.stage, "verify_failed", "同上：牌子也不许在开头被摘");
  writeFileSync(join(repo, "fix-attempt.txt"), "still the same version\n");
  await reconcileTurnBaseline("tb-verify-failed", true);

  const stillFailing = await row("tb-verify-failed");
  assert.equal(stillFailing.verifyStationRounds, 2, "验证没过是**同一版在修**，清零会让轮数上限形同虚设");
  assert.equal(stillFailing.workflowAt, "s2", "还停在那一站上，不是新开一版");
  assert.equal(stillFailing.stage, "verify_failed", "结论还没被推翻，别替它翻篇");

  // ── ④ 改了代码但这一轮没确认完成 → 照样清账（2026-08-07 反转） ────────────
  // 这条曾经断言「什么都不动」，理由是「一次中断不该把上一版的成绩抹了」。反转的理由：
  // **续聊回合本来就不要求确认完成**（followUpFrom 会把它回落到原终态），而那恰恰是
  // 「验收完又让 agent 改点东西」的主路 —— 按确认与否决定清不清，主路一个字都不清：
  // 上一版那道已放行的关口、已验满的轮数继续替新代码站台，游标还停在验证站上，谁点一下
  // 「再验一轮」或「人工强制通过」，没人验过也没经过关口的新代码就被合并了（实测任务
  // 1rojF5Tjau91）。真被中断且**一个字节没改**的回合照片相同，会走上面 ② 那条放回的路。
  await makeSettledTask("tb-unconfirmed", "merged");
  await recordTurnBaseline("tb-unconfirmed", repo, false);
  writeFileSync(join(repo, "half-done.txt"), "interrupted\n");
  await reconcileTurnBaseline("tb-unconfirmed", false); // 这一轮没确认完成

  const halfway = await row("tb-unconfirmed");
  assert.equal(halfway.workflowAt, "s1", "改了字节就是新一版，这一轮确认没确认完成都得把游标搬回起点");
  assert.equal(halfway.verifyStationRounds, 0, "上一版验满的轮数不能留着，否则这一站被判 skip 整站略过");
  assert.equal(halfway.stage, null, "merged 留着的话，「等我点头」看见它就静默放行");

  // ── ④′ 升级前那一轮留下的老基线 → 结算时补清一次 ─────────────────────────
  // 老 server 拍的照里没有 `ledger` 字段（那一轮开头没清过账）。升级正好卡在这种回合中间
  // 时，结算这头必须认得出来并走回「结算才清」的老路，否则这个任务的账永远没人清。
  await makeSettledTask("tb-legacy", "merged");
  mkdirSync(join(RUNS_DIR, "tb-legacy"), { recursive: true });
  writeFileSync(
    join(RUNS_DIR, "tb-legacy", "turn-baseline.json"),
    JSON.stringify({ cwd: repo, fingerprint: "old-server-took-this", fresh: false, stage: null, at }),
  );
  await reconcileTurnBaseline("tb-legacy", true);

  const legacy = await row("tb-legacy");
  assert.equal(legacy.workflowAt, "s1", "老基线没有 ledger 字段 → 认出来，在结算这头补清一次");
  assert.equal(legacy.verifyStationRounds, 0, "补清同样是四样一起清");
  assert.equal(legacy.stage, null, "同上");

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

  console.log(
    "turn baseline: 开头就清账 / 改了保持清空 / 只问则原样放回+牌子挂回 / 新结论不被盖 /"
    + " 验证没过不清零 / 没确认也清账 / 老基线补清 / 空壳拆屋，八条通过",
  );
} finally {
  for (const id of IDS) rmSync(join(RUNS_DIR, id), { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
