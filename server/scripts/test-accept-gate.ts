// 「验收前置命令」(accept gate) 的回归：点验收那一刻才跑的那条命令，rc=0 才合并。
//
// 钉住的几条硬约束（对应 server/src/accept-gate.ts 的设计）：
//  · 不设门禁 = 老行为，一个字节都不该变。
//  · 设了门禁：第一按**不合并**，命令在任务工作区里跑；绿了系统自动把这次验收做完
//    （用户只点一次），红了不合并、不清理、目标分支一动不动，日志回流给 agent。
//  · 跳过只能是用户明确选的，而且要在时间线上留痕；取消/重启打断都落成看得见的终态。
//
// 每个用例自带一个临时仓库，checkout 和 ref 更新一律出不了临时目录。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { desc, eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-accept-gate-test-"));
process.env.ASH_DB = join(root, "ash.db");
// RUNS_DIR 指到临时目录，顺带把 guardAgentSpawn 打开：门禁红了会**真的发起一轮**去叫醒
// agent，拦截器保证那一轮不会起真 CLI（验的是「有没有发起」，不是 CLI 本身）。
process.env.ASH_RUNS_DIR = join(root, "runs");
process.on("exit", () => { try { rmSync(root, { recursive: true, force: true }); } catch {} });
assert.ok(
  process.env.ASH_ALLOW_REAL_AGENT !== "1",
  "门禁失败那一条会叫醒任务；拦截器一失效，测试就会拿用户的真额度跑 agent",
);

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function makeRepo(name: string): string {
  const repo = join(root, name);
  execFileSync("git", ["init", "-b", "main", repo]);
  git(repo, "config", "user.name", "Ash Gate Test");
  git(repo, "config", "user.email", "gate@example.test");
  writeFileSync(join(repo, ".gitignore"), ".worktrees/\n");
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "seed");
  return repo;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

try {
  const { prepareWorktree, worktreeBranchName } = await import("../src/git.js");
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { acceptGateRuns, projects, sessions, tasks } = await import("../src/db/schema.js");
  const { acceptTask } = await import("../src/task-accept.js");
  const { acceptGateState, cancelAcceptGate, recoverAcceptGates, rehandOffAcceptGate, whenAcceptGateSettled } = await import("../src/accept-gate.js");
  const { sessionTranscriptPath } = await import("../src/transcript.js");
  const { isTurnClaimed, releaseTurn } = await import("../src/turn-lock.js");
  await ensureSchema();

  const createdAt = new Date().toISOString();
  const runsOf = (taskId: string) => db.select().from(acceptGateRuns).where(eq(acceptGateRuns.taskId, taskId))
    .orderBy(desc(acceptGateRuns.startedAt), desc(acceptGateRuns.id));
  const taskRow = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!;

  /** 等这一次门禁连同「跑完之后那一步」全部做完。 */
  async function settled(taskId: string): Promise<void> {
    for (let i = 0; i < 400; i++) {
      const latest = (await runsOf(taskId)).at(0);
      if (latest && latest.status !== "running") { await whenAcceptGateSettled(latest.id); return; }
      await sleep(25);
    }
    throw new Error("门禁没有在 10 秒内结束");
  }

  async function seedProject(name: string, repo: string, gateCommand: string | null): Promise<string> {
    const id = `gate-project-${name}`;
    await db.insert(projects).values({ id, name, repoPath: repo, acceptGateCommand: gateCommand, createdAt });
    return id;
  }

  async function seedTask(projectId: string, repo: string, taskId: string, file: string): Promise<string> {
    const ws = await prepareWorktree(repo, taskId, "main");
    writeFileSync(join(ws.path, file), `${file}\n`);
    git(ws.path, "add", "-A");
    git(ws.path, "commit", "-m", `task ${file}`);
    await db.insert(tasks).values({
      id: taskId, projectId, title: file, body: "", mode: "single", status: "done", stage: "verified",
      labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "claude",
      useWorktree: true, worktreeBase: "main", mergeTargetBranch: "main", workflowMode: "free",
      autoTitle: false, createdAt, updatedAt: createdAt,
    });
    return ws.path;
  }

  // 1. 不设门禁 = 老行为：一按就合，一条门禁记录都不该有。
  {
    const repo = makeRepo("no-gate");
    const projectId = await seedProject("no-gate", repo, null);
    const taskId = "gatenone0001";
    await seedTask(projectId, repo, taskId, "plain.txt");
    const result = await acceptTask(taskId);
    assert.equal(result.accepted, true, "没设门禁的项目，验收行为必须跟上线前一模一样");
    assert.equal((await runsOf(taskId)).length, 0, "没设门禁就不该留下任何门禁记录");
  }

  // 2. 设了门禁：第一按不合并、命令在**任务工作区**里跑；绿了自动把验收做完。
  {
    const repo = makeRepo("gate-pass");
    // 命令把自己的 cwd 写进文件：验「它到底在哪儿跑的」只能靠这个，不能靠读代码。
    // 落在舞台根目录而不是工作区里 —— 验收会把 worktree 删掉，证据得活过那一刀。
    const cwdProof = join(root, "gate-cwd.txt");
    const projectId = await seedProject("gate-pass", repo, `pwd > ${cwdProof}`);
    const taskId = "gatepass00002";
    const wsPath = await seedTask(projectId, repo, taskId, "passing.txt");
    // 工作区路径先解析好:验收做完会把这个目录删掉,事后 realpath 不出来。
    const wsReal = realpathSync(wsPath);
    const before = git(repo, "rev-parse", "main");

    const first = await acceptTask(taskId);
    assert.equal(first.accepted, false, "门禁还没跑过，这一按不许合并");
    if (first.accepted) throw new Error("门禁没跑就合并了");
    assert.equal(first.reason, "accept_gate_running");
    assert.equal(first.gate?.status, "running");
    assert.equal(git(repo, "rev-parse", "main"), before, "门禁期间目标分支一个字节都不许动");
    assert.equal((await taskRow(taskId)).stage, "verified", "门禁期间不许提前盖 accepted");

    await settled(taskId);
    const run = (await runsOf(taskId)).at(0)!;
    assert.equal(run.status, "passed");
    assert.equal(run.exitCode, 0);
    // 目录这会儿已经被清理删掉了,只能拿字符串比(macOS 上 pwd 给的是 /private/var 那一支)。
    const ranIn = readFileSync(cwdProof, "utf8").trim();
    assert.ok(
      ranIn === join(realpathSync(dirname(run.cwd)), basename(run.cwd)) && ranIn !== wsReal && ranIn !== wsPath,
      `门禁必须跑在独立的被测源码快照中(实际 ${ranIn})`,
    );
    assert.notEqual(git(repo, "rev-parse", "main"), before, "门禁绿了就该自动把这次验收做完");
    assert.equal((await taskRow(taskId)).stage, "accepted", "用户只点一次，剩下的是系统欠他的");
    assert.equal((await runsOf(taskId)).length, 1, "自动续跑的那一次不许再触发一轮门禁");
  }

  // 3. 门禁红了：不合并、不清理、目标分支一动不动，日志回流给 agent；
  {
    const repo = makeRepo("gate-fail");
    const projectId = await seedProject("gate-fail", repo, "echo 这条回归故意红的 >&2; exit 3");
    const taskId = "gatefail00003";
    await seedTask(projectId, repo, taskId, "failing.txt");
    const before = git(repo, "rev-parse", "main");
    // 叫醒那一轮要往会话里写，得先有一条会话行（跟验收冲突交接那条回归同款舞台）。
    const seededSession = "gate-fail-session";
    await db.insert(sessions).values({
      id: seededSession, taskId, role: "single", agentType: "claude", executor: "claude",
      cwd: repo, startedAt: createdAt, turnStartedAt: createdAt, endedAt: createdAt, activeMs: 0,
    });

    const first = await acceptTask(taskId);
    assert.equal(first.accepted, false);
    await settled(taskId);
    const run = (await runsOf(taskId)).at(0)!;
    assert.equal(run.status, "failed");
    assert.equal(run.exitCode, 3);
    assert.equal(run.failure, "exit_code");
    assert.equal(git(repo, "rev-parse", "main"), before, "门禁红了，目标分支一个字节都不许动");
    assert.equal((await taskRow(taskId)).stage, "verified", "红了不许盖 accepted");
    assert.match(readFileSync(run.logPath, "utf8"), /这条回归故意红的/, "命令的输出要落进日志");

    // 「已叫醒它去修」必须是真的：多出一行会话 = 真发起了一轮。
    const woke = async () => (await db.select().from(sessions).where(eq(sessions.taskId, taskId))).length > 1;
    for (let i = 0; i < 200 && !(await woke()); i++) await sleep(25);
    assert.equal(await woke(), true, "时间线说「已叫醒」，就必须真有一轮跑起来");
    const timeline = readFileSync(sessionTranscriptPath(taskId, seededSession), "utf8");
    assert.match(timeline, /门禁交接：/, "交接说明要留在时间线上（刷新后仍看得见）");
    assert.equal(timeline.includes("门禁交接失败"), false, "真叫醒了就不该同时写着失败");

    // 交接要落在那一行上（而不是只写进时间线）：用户几小时后刷新页面，卡上还得答得出
    // 「它到底去修了没有」。
    assert.ok(run.handoffAt, "自动交接必须留下刷新后仍看得见的记录");
    assert.equal(run.handoffError, null, "真叫醒了就不该同时记着失败原因");

    // 被叫醒那一轮会把任务拉回 running —— 「正在修」期间本来就不该能验收（既有的
    // free workflow 前置闸）。测试里 CLI 不真起，所以手动把它放回终态，模拟那一轮跑完。
    const turnEnded = async () => {
      // 叫醒是异步发出的:先等它真把任务拉成 running,再放回终态,否则这一行会被随后
      // 到达的那次 running 覆盖掉。
      for (let i = 0; i < 200 && (await taskRow(taskId)).status !== "running"; i++) await sleep(25);
      await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, taskId));
      releaseTurn(taskId); // 测试里 CLI 不真起,回合锁得自己松开(验收闸同时看它和 status)
    };
    await turnEnded();

    for (const [index, failure] of ["exit_code", "timeout"].entries()) {
      const previous = (await runsOf(taskId))[0]!;
      if (failure === "timeout") {
        await db.update(acceptGateRuns).set({ failure, exitCode: null }).where(eq(acceptGateRuns.id, previous.id));
      }
      const again = await acceptTask(taskId);
      assert.equal(again.accepted, false);
      if (again.accepted) throw new Error("红着的门禁不该放行");
      assert.equal(again.reason, "accept_gate_running", `${failure} 后没改源码，再点验收也要真正重跑`);
      await settled(taskId);
      assert.equal((await runsOf(taskId)).length, index + 2);
      assert.notEqual((await runsOf(taskId))[0]!.id, previous.id, "新一轮记录与旧失败分开保留");
      assert.equal(git(repo, "rev-parse", "main"), before, "重跑失败仍不合并");
      await turnEnded();
    }

    // 明确要求重跑 → 真的再跑一次。
    const rerun = await acceptTask(taskId, "human", { acceptGate: "rerun" });
    assert.equal(rerun.accepted, false);
    await settled(taskId);
    assert.equal((await runsOf(taskId)).length, 4, "点了「重跑一次」就要真的重跑");
    await turnEnded(); // 又红了一次,又被叫醒了一轮

    // 「再交给智能体去修」：红了那次已经自动交过一次，这条是补救与再推一把。
    // 证据不能再数会话行 —— 第二次交接 resume 的是同一条会话（那正是它比新建便宜的
    // 原因），数会话会得出「没交成」的假结论。改看任务有没有真的被重新拉起来。
    {
      const again2 = await rehandOffAcceptGate(taskId);
      assert.equal(again2.ok, true, "红着的那一次应该可以再交给 agent");
      const woken = async () => (await taskRow(taskId)).status === "running";
      for (let i = 0; i < 200 && !(await woken()); i++) await sleep(25);
      assert.equal(await woken(), true, "「再交一次」必须真的再起一轮，不能只写一句话");
      assert.equal((await runsOf(taskId)).length, 4, "交给 agent 去修不等于重跑那条命令");
      await turnEnded();
    }

    // 通过/取消/被打断都没有「红」可交：这条路必须明确拒绝，而不是假装交了一次。
    {
      const passedTask = "gatepass00002";
      const refused = await rehandOffAcceptGate(passedTask);
      assert.equal(refused.ok, false, "通过了的那一次没有红可以交给 agent");
    }

    // 明确跳过 → 直接合并，且时间线上留下「这是你自己选的」。
    const skipped = await acceptTask(taskId, "human", { acceptGate: "skip" });
    assert.equal(skipped.accepted, true, "跳过是用户的权利（门禁可能是 flake）");
    assert.equal((await runsOf(taskId)).length, 4, "跳过不该再起一次命令");
    assert.notEqual(git(repo, "rev-parse", "main"), before);
    // 痕迹写在**当下最新**那条会话上(红了被叫醒会新开会话),所以全读一遍。
    const everything = (await db.select().from(sessions).where(eq(sessions.taskId, taskId)))
      .map((row) => { try { return readFileSync(sessionTranscriptPath(taskId, row.id), "utf8"); } catch { return ""; } })
      .join("\n");
    assert.match(everything, /跳过/, "跳过门禁必须留下刷新后仍看得见的痕迹");
  }

  // 4. 新鲜度：结果绑在被测的那棵树上 —— 树一变就必须重跑。
  //    舞台：门禁绿了但自动续跑的合并失败（目标分支工作区脏），任务于是还停在可验收态。
  {
    const repo = makeRepo("gate-stale");
    const projectId = await seedProject("gate-stale", repo, "sleep 0.3; true");
    const taskId = "gatestale0004";
    const wsPath = await seedTask(projectId, repo, taskId, "stale.txt");
    await acceptTask(taskId);
    writeFileSync(join(repo, "seed.txt"), "dirty\n");
    await settled(taskId);
    assert.equal((await runsOf(taskId)).at(0)!.status, "passed");
    assert.equal((await taskRow(taskId)).stage, "verified", "合并被拦下了，不该盖 accepted");

    // 同一棵树再点：沿用上次的通过，不重跑（目标分支还脏着，所以这一按仍合不进去 ——
    // 但挡住它的得是合并，不能是门禁)。工作区留着不清,后面还要往里压提交。
    const reused = await acceptTask(taskId);
    assert.equal((await runsOf(taskId)).length, 1, "同一棵树不许重跑");
    assert.equal(reused.accepted, false);
    if (!reused.accepted) {
      assert.equal(String(reused.reason).startsWith("accept_gate"), false, `挡住它的不该是门禁(${reused.reason})`);
    }

    // 树变了：必须重跑。
    writeFileSync(join(wsPath, "more.txt"), "more\n");
    git(wsPath, "add", "-A");
    git(wsPath, "commit", "-m", "task more");
    git(repo, "checkout", "--", "seed.txt");
    const afterChange = await acceptTask(taskId);
    writeFileSync(join(repo, "seed.txt"), "dirty\n");
    assert.equal(afterChange.accepted, false, "代码改过了，上一次的绿不作数");
    if (!afterChange.accepted) assert.equal(afterChange.reason, "accept_gate_running");
    await settled(taskId);
    assert.equal((await runsOf(taskId)).length, 2, "树变了必须重跑");

    // 新这棵树也绿了,把脏工作区收拾掉再点：这次该一路合到底,且不再起第三次。
    git(repo, "checkout", "--", "seed.txt");
    const finallyIn = await acceptTask(taskId);
    assert.equal(finallyIn.accepted, true, "门禁绿着、障碍清掉了,就该放行");
    assert.equal((await runsOf(taskId)).length, 2, "放行那一按不许再烧一次门禁");
  }

  // 5. 取消：收掉进程、落成 canceled（不是 failed —— 两者下一步完全不同）。
  {
    const repo = makeRepo("gate-cancel");
    const projectId = await seedProject("gate-cancel", repo, "sleep 120");
    const taskId = "gatecancel005";
    await seedTask(projectId, repo, taskId, "cancel.txt");
    const started = await acceptTask(taskId);
    assert.equal(started.accepted, false);
    const gate = await acceptGateState(taskId);
    assert.equal(gate.running?.status, "running");
    assert.equal(gate.command, "sleep 120");
    const pid = (await runsOf(taskId)).at(0)!.pid!;
    const canceled = await cancelAcceptGate(taskId);
    assert.equal(canceled.outcome, "canceled");
    assert.equal(canceled.gate?.status, "canceled");
    assert.equal(canceled.gate?.failure, "canceled");
    for (let i = 0; i < 100 && alive(pid); i++) await sleep(25);
    assert.equal(alive(pid), false, "取消必须真的把那条命令收掉，不是只改一行状态");
    assert.equal((await acceptGateState(taskId)).running, null);
  }

  // 6. ash 重启：上一轮留在「正在跑」的行一律落成「被打断」，不留永远转圈的幽灵。
  {
    const repo = makeRepo("gate-restart");
    const projectId = await seedProject("gate-restart", repo, "sleep 120");
    const taskId = "gaterestart06";
    await seedTask(projectId, repo, taskId, "restart.txt");
    await acceptTask(taskId);
    const pid = (await runsOf(taskId)).at(0)!.pid!;
    const recovered = await recoverAcceptGates();
    assert.equal(recovered.interrupted, 1);
    const row = (await runsOf(taskId)).at(0)!;
    assert.equal(row.status, "interrupted");
    assert.equal(row.failure, "server_restarted");
    for (let i = 0; i < 100 && alive(pid); i++) await sleep(25);
    assert.equal(alive(pid), false, "被打断的那条命令也要收掉，不然它在后台接着烧机器");
    // 被打断不算结果：再点验收要从头跑一遍。
    const again = await acceptTask(taskId);
    assert.equal(again.accepted, false);
    assert.equal(again.reason, "accept_gate_running", "打断过的不复用，重新跑一遍");
    await cancelAcceptGate(taskId);
  }

  // 7. 命令起不来：如实落成失败，不许当成通过放行。
  {
    const repo = makeRepo("gate-spawn-fail");
    const projectId = await seedProject("gate-spawn-fail", repo, "definitely-not-a-real-command-xyz");
    const taskId = "gatespawn0007";
    await seedTask(projectId, repo, taskId, "spawn.txt");
    const before = git(repo, "rev-parse", "main");
    const result = await acceptTask(taskId);
    assert.equal(result.accepted, false);
    await settled(taskId);
    assert.equal((await runsOf(taskId)).at(0)!.status, "failed");
    assert.equal(git(repo, "rev-parse", "main"), before, "命令都没跑成，更不许合");
    // 这一条也会叫醒任务去修。等那一轮自己收完再拆台,否则它的收尾写操作会撞上已关的库,
    // 在一场全绿的测试末尾刷一屏假的报错栈。
    for (let i = 0; i < 200 && isTurnClaimed(taskId); i++) await sleep(25);
    await sleep(200);
  }

  // 8. 门禁跑的那十几分钟里工作区又进了一笔提交：**绝不许**把这条命令没看过的代码合进去。
  //    （第 1 轮审查实测的头号问题：被测的是开跑那一刻的树，合的是收尾那一刻的树。）
  {
    const repo = makeRepo("gate-drift");
    const projectId = await seedProject("gate-drift", repo, "sleep 1");
    const taskId = "gatedrift0008";
    const wsPath = await seedTask(projectId, repo, taskId, "drift.txt");

    const first = await acceptTask(taskId);
    assert.equal(first.accepted, false);
    const tested = (await runsOf(taskId)).at(0)!.sourceCommit!;

    // 命令还跑着的时候，这个任务在另一个窗口里又干了一笔活。
    await sleep(250);
    assert.equal((await runsOf(taskId)).at(0)!.status, "running", "舞台没搭对：命令已经跑完了");
    writeFileSync(join(wsPath, "late.txt"), "late\n");
    git(wsPath, "add", "-A");
    git(wsPath, "commit", "-m", "late commit");
    const late = git(wsPath, "rev-parse", "HEAD");
    assert.notEqual(late, tested, "舞台没搭对：树没变");

    await settled(taskId);          // 第一次绿了 → 自动续验收时发现树变了 → 重新登记一次
    await settled(taskId);          // 第二次（跑的是新这棵树）
    const runs = await runsOf(taskId);
    assert.equal(runs.length, 2, "树在跑动期间变了，那次绿灯就不作数，必须按新的树再跑一遍");
    assert.equal(runs.at(0)!.sourceCommit, late, "第二次跑的必须是现在这棵树");
    assert.equal(git(repo, "rev-parse", "main"), late, "合进去的必须就是被命令验过的那棵树");
    assert.equal((await taskRow(taskId)).stage, "accepted");
  }

  // 9. 项目把命令换了一条：旧命令的绿灯不再放行 —— 新这条一次都没跑过。
  //    舞台同第 4 条：绿了但自动续跑的合并被脏工作区拦下，任务还停在可验收态。
  {
    const repo = makeRepo("gate-newcmd");
    const projectId = await seedProject("gate-newcmd", repo, "sleep 0.3; true");
    const taskId = "gatenewcmd009";
    await seedTask(projectId, repo, taskId, "newcmd.txt");
    const before = git(repo, "rev-parse", "main");
    await acceptTask(taskId);
    writeFileSync(join(repo, "seed.txt"), "dirty\n");
    await settled(taskId);
    assert.equal((await runsOf(taskId)).at(0)!.status, "passed");
    assert.equal(git(repo, "rev-parse", "main"), before, "舞台没搭对：这一次本来就不该合进去");

    // 障碍清掉，换一条命令，再点验收。
    git(repo, "checkout", "--", "seed.txt");
    await db.update(projects).set({ acceptGateCommand: "true # v2" }).where(eq(projects.id, projectId));
    const second = await acceptTask(taskId);
    assert.equal(second.accepted, false, "换了命令就不能拿上一条的绿灯直接合");
    await settled(taskId);
    const runs = await runsOf(taskId);
    assert.equal(runs.length, 2, "新命令必须真的跑一遍");
    assert.equal(runs.at(0)!.command, "true # v2");
    assert.notEqual(git(repo, "rev-parse", "main"), before, "新命令也绿了，这次该合进去");
  }

  // 10. 统一验收遇上门禁：按下去之前就说清「一次只能验一个」，一个都不动。
  {
    const { readBranchPlan, acceptFamily } = await import("../src/task-branch-routes.js");
    const repo = makeRepo("gate-family");
    const projectId = await seedProject("gate-family", repo, "true");
    // 这两个 id 的**前 8 个字符**必须不同：worktree 分支名只取这一截（worktreeBranchName）。
    const parentId = "famparent010";
    const childId = "famchild0011";
    const parentWs = await seedTask(projectId, repo, parentId, "parent.txt");
    // 子任务从父任务的分支上开，形成一串要按顺序合的派生。
    const parentBranch = worktreeBranchName(parentId);
    const childWs = await prepareWorktree(repo, childId, parentBranch);
    writeFileSync(join(childWs.path, "child.txt"), "child\n");
    git(childWs.path, "add", "-A");
    git(childWs.path, "commit", "-m", "task child");
    await db.insert(tasks).values({
      id: childId, projectId, title: "child", body: "", mode: "single", status: "done", stage: "verified",
      labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "claude",
      // 真实派生任务的形状：开工起点是父任务的分支（baseTaskId 把这层关系钉死），最终
      // 仍然合进 main。只写 worktreeBase 的话它的合入目标就是父分支，而父分支正检出在
      // 父任务的工作区里 —— 那是另一条阻塞，会挡在门禁判据前面。
      useWorktree: true, worktreeBase: parentBranch, baseTaskId: parentId, mergeTargetBranch: "main", workflowMode: "free",
      // 派生任务的开工记录：没有它，验收会先被「未记录继承的父提交」挡住。
      worktreeStartCommit: git(parentWs, "rev-parse", "HEAD"),
      autoTitle: false, createdAt, updatedAt: createdAt,
    });
    assert.ok(parentWs, "父任务工作区要在");

    const view = (await readBranchPlan(parentId))!;
    const expected = [view.task, ...view.descendants].map((row) => ({ taskId: row.taskId, fingerprint: row.fingerprint }));
    assert.equal(expected.length, 2, "舞台没搭对：这一串应该有两个任务");
    const before = git(repo, "rev-parse", "main");
    const blocked = await acceptFamily(parentId, expected, acceptTask);
    assert.equal(blocked.ok, false);
    assert.deepEqual(blocked.completed, [], "拦住就是一个都没合");
    assert.match(blocked.error!, /一次只能验一个/);
    assert.equal(git(repo, "rev-parse", "main"), before, "拦住就是一个字节都没动");
    assert.equal((await runsOf(parentId)).length, 0, "整批拦下的时候，命令一次都不该起来");
    assert.equal((await runsOf(childId)).length, 0);

    // 只选一个（子任务还等着父成果合入，所以这里选的是父任务）：照常开跑，而且话要说准
    // —— 这不是「暂停在它身上」，是「它已经在跑了，绿了自己会合完」。
    const one = await acceptFamily(parentId, [{ taskId: parentId, fingerprint: view.task.fingerprint }], acceptTask);
    assert.equal(one.ok, false, "门禁还没跑完，这一按本来就不该合");
    assert.match(one.error!, /已经开跑/);
    assert.equal((await runsOf(parentId)).length, 1, "只选一个时要真的把命令起起来");
    await settled(parentId);
    assert.equal((await taskRow(parentId)).stage, "accepted", "绿了它自己会把这一个合完");
  }

  // 11. 命令还跑着的时候：这条任务动不得，而「这次跳过」得先把它收掉再合。
  //     （界面不给这条路，HTTP/MCP 给得出来：不收掉它，合并紧接着的清理会把它脚下的
  //      工作区删掉，而那条全量回归还在往里跑。）
  {
    const { taskBusyRejection } = await import("../src/task-busy.js");
    const repo = makeRepo("gate-skip-running");
    const projectId = await seedProject("gate-skip-running", repo, "sleep 120");
    const taskId = "gateskiprun12";
    await seedTask(projectId, repo, taskId, "skiprun.txt");
    await acceptTask(taskId);
    const pid = (await runsOf(taskId)).at(0)!.pid!;

    const busy = await taskBusyRejection(taskId, "删除");
    assert.match(busy?.error ?? "", /验收前置命令正在/, "命令跑着的时候不许把它脚下的工作区抽走");

    const skipped = await acceptTask(taskId, "human", { acceptGate: "skip" });
    assert.equal(skipped.accepted, true, "跳过是用户的权利");
    assert.equal((await runsOf(taskId)).at(0)!.status, "canceled", "跳过的时候那条命令要落成「已取消」");
    for (let i = 0; i < 100 && alive(pid); i++) await sleep(25);
    assert.equal(alive(pid), false, "跳过必须真的把它收掉：工作区马上就要被清理删掉了");
    assert.equal(await taskBusyRejection(taskId, "删除"), null, "收完之后不该再挡着");
  }

  // 12. 任务列表看得见「它此刻在跑门禁」。
  //     门禁跑的那十几分钟里任务自己的 status 和 stage 一个字都不会变（它早就 done 了、
  //     正等着验收），所以侧栏那颗圆点和会话页那条全靠 enrichTasks 现查的这个字段。
  //     它一旦不准，界面上就只剩一个「安静地等你验收」的任务 —— 而工作区里有条命令在跑。
  {
    const { enrichTasks } = await import("../src/task-store.js");
    const repo = makeRepo("gate-list-flag");
    const projectId = await seedProject("gate-list-flag", repo, "sleep 120");
    const taskId = "gatelistflag1";
    await seedTask(projectId, repo, taskId, "listflag.txt");
    const rowOf = async () => (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!;
    assert.equal(
      (await enrichTasks([await rowOf()]))[0]!.acceptGateRunning,
      false,
      "还没点验收：什么都没在跑",
    );

    await acceptTask(taskId);
    assert.equal(
      (await enrichTasks([await rowOf()]))[0]!.acceptGateRunning,
      true,
      "命令跑着的时候列表必须看得出来，否则这颗点跟平时一模一样",
    );

    await cancelAcceptGate(taskId, "测试收尾");
    assert.equal(
      (await enrichTasks([await rowOf()]))[0]!.acceptGateRunning,
      false,
      "收掉之后要落回去：留着就是一个永远在转的幽灵",
    );
  }

  // 13. **回执的凭据**：这一按到底拿什么放的行，必须是这一按自己记下来的，不能拿「最近
  //     一次门禁」反推（第 1 轮审查 F1 实测出一份假回执）。这里把那一幕原样跑一遍：
  //     命令在 A 上跑绿 → 合并被挡住（目标工作区脏）→ 工作区里又提交了 B → 项目撤掉命令
  //     → 再按一次。这一次真正放行的理由是「那一刻没有门禁」，而「最近一次」仍是那条绿的。
  {
    const repo = makeRepo("gate-basis");
    const projectId = await seedProject("gate-basis", repo, "sleep 0.3; true");
    const taskId = "gatebasis0013";
    const wsPath = await seedTask(projectId, repo, taskId, "basis.txt");

    // 目标工作区脏：main 上放一份未跟踪的 basis.txt，合并会拒绝覆盖它 —— 于是门禁绿了、
    // 凭据也记下了，章却没盖成。这正是 F1 那一幕的前半段。
    await acceptTask(taskId);
    writeFileSync(join(repo, "basis.txt"), "conflicting local edit\n");
    await settled(taskId);
    const greenRun = (await runsOf(taskId)).at(0)!;
    assert.equal(greenRun.status, "passed");
    const treeA = greenRun.sourceCommit!;
    assert.notEqual((await taskRow(taskId)).stage, "accepted", "目标工作区脏，这一次不该合进去");
    assert.equal((await taskRow(taskId)).acceptedGateMode, null, "没有实际合并，不能冻结合并凭据");
    assert.equal((await taskRow(taskId)).acceptedGateRunId, null);

    // 代码又改了（B），项目把命令撤了，目标工作区收拾干净 —— 这一按是「直接合」。
    writeFileSync(join(wsPath, "basis.txt"), "second round\n");
    git(wsPath, "add", "-A");
    git(wsPath, "commit", "-m", "round B");
    const treeB = git(wsPath, "rev-parse", "HEAD");
    assert.notEqual(treeA, treeB);
    // 那份脏改动是未跟踪文件（main 上还没有 basis.txt），所以收拾干净就是把它删掉。
    rmSync(join(repo, "basis.txt"));
    await db.update(projects).set({ acceptGateCommand: null }).where(eq(projects.id, projectId));

    const second = await acceptTask(taskId);
    assert.equal(second.accepted, true, "没有门禁了，这一按就该直接合");
    const row = await taskRow(taskId);
    assert.equal(row.acceptedSourceCommit, treeB, "合进去的是 B");
    assert.equal(row.acceptedGateMode, "unset", "这一按的凭据是「那一刻没有门禁」，不是那条绿的");
    assert.equal(row.acceptedGateRunId, null);
    const view = await acceptGateState(taskId);
    assert.equal(view.basis?.mode, "unset");
    assert.equal(view.basis?.run, null, "凭据里不许塞一次跟这一按无关的 run");
    assert.equal(view.latest?.status, "passed", "历史照常查得到");
    assert.equal(view.latest?.sourceCommit, treeA, "而它验的是 A —— 界面据此说清「这不是本次凭据」");
  }

  // 14. **「已取消」必须是整棵进程树真的退出了**（第 1 轮审查 F2 实测）：从前取消只发一刀
  //     TERM 就返回，而 `trap '' TERM` 的后代照样在跑 —— 紧接着的合并/清理会把它脚下的
  //     工作区删掉，它却还在往里写。领头那个一 TERM 就没了，所以「父进程不在了」根本
  //     证明不了后代也不在。
  {
    const repo = makeRepo("gate-stop-tree");
    const childFile = join(root, "stubborn-child.pid");
    // 领头的 shell 吃默认 TERM（一刀就死），后台那个把 TERM 忽略掉并接着跑。
    const command = `sh -c 'trap "" TERM; echo $$ > ${childFile}; sleep 120' & sleep 120`;
    const projectId = await seedProject("gate-stop-tree", repo, command);
    const taskId = "gatestoptree1";
    await seedTask(projectId, repo, taskId, "stoptree.txt");
    await acceptTask(taskId);
    let childPid = 0;
    for (let i = 0; i < 200 && !childPid; i++) {
      try { childPid = Number(readFileSync(childFile, "utf8").trim()); } catch { await sleep(25); }
    }
    assert.ok(childPid > 0, "测试自己的前提：那个忽略 TERM 的后代得先真的起来");
    assert.equal(alive(childPid), true);

    await cancelAcceptGate(taskId, "测试：取消必须等整棵树退出");
    // **取消返回的那一刻**就得是真的没了：这个返回值被「跳过门禁直接合并」当成
    // 「可以动工作区了」的信号，中间不许再有一个「它马上就会死」的窗口。
    assert.equal(alive(childPid), false, "取消返回时那个忽略 TERM 的后代必须已经被补刀收掉");
    assert.equal((await runsOf(taskId)).at(0)!.status, "canceled");
  }

  // 15. **命令点名要跑的东西不在被测快照里**：这不是「测试红了」，而是它根本没跑到。
  //
  // 本机 2026-10-24/25 连撞四次（日志 data/runs/*/accept-gate-*.log）：项目把
  // `test:accept` 加进 package.json 的那次提交晚于任务的开工基线，于是门禁在任务那份
  // 快照里跑它，只拿到 npm 的原始报错 + rc=1。门禁照旧说一句「未通过：命令退出码非 0」，
  // 执行者于是把命令在两个提交上各复跑一遍，最后还是停下来问用户 —— 四次都这样。
  //
  // 用一个自己写的 runner 复现**那个形状**（npm 原话 + rc=1 + 脚本名在 git 里查得到），
  // 不依赖机器上装没装 npm。夹具故意让基线里已经有一个**撞名**的 `test:accept-merge`：
  // 第 1 轮审查 F3 实测，按子串算落点时它会把真正那个文件排除掉，于是结论反过来说
  // 「目标分支上也找不到」。钉住四件事：归类不是 exit_code、结论里有核实过的落点和出路、
  // 交回给 agent 的那份字明确不让它改代码、以及内部缺件那一档**不**走这副面孔。
  {
    const repo = makeRepo("gate-missing-command");
    // runner 本身在两棵树里都有；它照 npm 的措辞报「这个脚本名我找不到」。
    const runner = [
      "#!/bin/sh",
      'grep -qx "$1" scripts.json 2>/dev/null && exit 0',
      'printf \'npm error Missing script: "%s"\\n\' "$1"',
      "exit 1",
    ].join("\n");
    writeFileSync(join(repo, "runner.sh"), `${runner}\n`, { mode: 0o755 });
    // 基线里已经有一个撞名的（`test:accept-merge` 含 `test:accept` 这个子串）。
    writeFileSync(join(repo, "scripts.json"), "build\ntest:accept-merge\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "baseline runner");

    const projectId = await seedProject("gate-missing-command", repo, "./runner.sh test:accept");
    const taskId = "gatemissing01";
    const wsPath = await seedTask(projectId, repo, taskId, "missing.txt");
    // 任务开工**之后**，目标分支才把这条命令加进去 —— 这正是本机那四次的形状。
    writeFileSync(join(repo, "scripts.json"), "build\ntest:accept-merge\ntest:accept\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "Move frontend regression from push to acceptance");
    const introduced = git(repo, "rev-parse", "HEAD");
    const before = git(repo, "rev-parse", "main");
    const seededSession = "gate-missing-session";
    await db.insert(sessions).values({
      id: seededSession, taskId, role: "single", agentType: "claude", executor: "claude",
      cwd: repo, startedAt: createdAt, turnStartedAt: createdAt, endedAt: createdAt, activeMs: 0,
    });

    const first = await acceptTask(taskId);
    assert.equal(first.accepted, false, "命令没跑到，这一按一样不许合并");
    await settled(taskId);
    const run = (await runsOf(taskId)).at(0)!;
    assert.equal(run.status, "failed");
    assert.equal(run.exitCode, 1, "测试自己的前提：这个形状的退出码就是 1，不是 127");
    // 核心那一条：跟普通测试红了**不是同一种** failure。
    assert.equal(run.failure, "command_missing", "「命令点名要跑的东西不在树里」不能还叫 exit_code");
    assert.equal(git(repo, "rev-parse", "main"), before, "归类不改变拦不拦：目标分支仍一动不动");
    assert.equal((await taskRow(taskId)).stage, "verified");

    // 结论要落盘（刷新后看得见），而且三件事齐全。
    assert.ok(run.diagnosis, "归类结论必须落在那一行上，不能只在这一次响应里说一句");
    const conclusion = run.diagnosis!;
    assert.match(conclusion, /一行都没跑到/, "① 命令点名要跑的东西没解析出来");
    assert.match(conclusion, /Missing script/, "① 判据原文");
    // ② 撞名的 `test:accept-merge` 不许把真正的落点挤掉（F3 的那条反例走生产路径）。
    assert.match(conclusion, /scripts\.json/, "② 它在目标分支上的落点（整词命中，不是子串）");
    assert.match(conclusion, new RegExp(introduced.slice(0, 8)), "② 最早把它写进那个文件的是哪次提交");
    assert.match(conclusion, /落后 main 1 个提交/, "② 任务分支落后目标分支多少");
    assert.equal(/上也找不到/.test(conclusion), false, "撞名不许让结论反过来说「目标分支上也没有」（F3）");
    // ③ 核实过目标分支上有，这一档才给合入建议。
    assert.match(conclusion, /把 main 合进任务分支/, "③ 出路一：合目标分支再验收");
    assert.match(conclusion, /跳过前置命令/, "③ 出路二：这次显式跳过");
    assert.equal(/\*\*|`/.test(conclusion), false, "结论要纯文本：日志和 MCP 回执都不渲染 markdown（N4）");
    assert.match(readFileSync(run.logPath, "utf8"), /一行都没跑到/, "结论也要写进这一次的日志");
    const timeline = () => readFileSync(sessionTranscriptPath(taskId, seededSession), "utf8");
    for (let i = 0; i < 200 && !/一行都没跑到/.test(timeline()); i++) await sleep(25);
    assert.match(timeline(), /一行都没跑到/, "结论要单独进时间线（用户刷新后唯一找得回的地方）");

    // 交回给 agent 的那份字：不许派「去修代码」这件它根本做不到的活。
    const { gateFailurePrompt } = await import("../src/accept-gate-messages.js");
    const promptOf = (failure: "command_missing" | "exit_code") => gateFailurePrompt({
      command: run.command, summary: "未通过", logPath: run.logPath, tail: "",
      cwd: run.cwd, sourceCwd: repo, failure, diagnosis: conclusion,
    });
    const prompt = promptOf("command_missing");
    assert.match(prompt, /不要为这件事改任何代码/, "这一种不许让 agent 去改代码");
    assert.match(prompt, /不要为了确认而反复复跑/, "四次实测里烧掉的就是这几遍复跑");
    assert.match(prompt, /转述给用户/, "出路由用户拍板，agent 只负责转述");
    assert.equal(prompt.includes("定位到底是哪一条红的"), false, "普通红那一版的措辞不该出现在这一种上");
    // F2：同一段诊断、失败类型不同，面孔必须跟着**类型**走而不是跟着「有没有诊断」走。
    assert.equal(promptOf("exit_code").includes("不要为这件事改任何代码"), false,
      "带着诊断但 failure 仍是 exit_code 的那一档，不许被交成「不许修」（审查 F2）");

    // 对照组一：同一个项目、真的跑起来并红了的命令，一个字都不许被改写。
    const again = async () => {
      await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, taskId));
      releaseTurn(taskId);
      await acceptTask(taskId);
      await settled(taskId);
      return (await runsOf(taskId)).at(0)!;
    };
    await db.update(projects).set({ acceptGateCommand: "echo 真断言失败 >&2; exit 4" }).where(eq(projects.id, projectId));
    const real = await again();
    assert.equal(real.failure, "exit_code", "真跑起来、真红了的仍是 exit_code —— 归类不许吃掉真 bug");
    assert.equal(real.diagnosis, null, "普通的红没有「不是你的代码」这种结论可给");

    // 对照组二（审查 F1 的生产路径）：顶层**跑起来了**，缺的是它内部点名的东西。
    // 必须停在 inner —— failure 不改写，也不许摆那两条出路。
    //
    // 这个脚本必须提交进**任务自己那条分支**：门禁跑的是任务那份快照，提交到 repo 的 main
    // 上它压根不在快照里，于是「入口文件缺失」那条硬证据会（正确地）把它判成 entry ——
    // 第一次写这条用例就栽在这儿，夹具错了而生产是对的。
    writeFileSync(join(wsPath, "nested.sh"), [
      "#!/bin/sh",
      'echo ACCEPTANCE STARTED',
      './runner.sh helper-missing',
    ].join("\n") + "\n", { mode: 0o755 });
    git(wsPath, "add", "-A");
    git(wsPath, "commit", "-m", "nested runner");
    await db.update(projects).set({ acceptGateCommand: "./nested.sh" }).where(eq(projects.id, projectId));
    const nested = await again();
    assert.equal(nested.failure, "exit_code", "顶层跑起来了，内部缺件不许冒充顶层缺失（审查 F1）");
    assert.match(nested.diagnosis ?? "", /这条命令跑起来了/, "inner 要如实说命令启动了");
    assert.match(nested.diagnosis ?? "", /也可能是这次改动把名字写错了/, "inner 不许排除「是你改出来的」");
    assert.equal(/一行都没跑到|跳过前置命令|合进任务分支/.test(nested.diagnosis ?? ""), false,
      "inner 不许摆那两条出路，也不许说测试没跑");

    // 对照组三：命令的**入口文件**不在这份快照里。这条硬证据跟日志里说了什么无关
    // （命令可能把输出全吞了），是 127/126 降级成 inner 之后补上的那一路（审查 N1）。
    await db.update(projects).set({ acceptGateCommand: "./only-on-target.sh 2>/dev/null" }).where(eq(projects.id, projectId));
    writeFileSync(join(repo, "only-on-target.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "add gate entry script on target only");
    const entryIntroduced = git(repo, "rev-parse", "HEAD");
    const absent = await again();
    assert.equal(absent.failure, "command_missing", "入口文件不在快照里 = 命令点名要跑的东西不在树里");
    // 这一档的判据是**入口文件在不在**，跟日志里写了什么无关 —— 夹具的 stderr 被
    // 2>/dev/null 丢干净了，一个字都没有，它照样能定性。
    assert.match(absent.diagnosis ?? "", /被测快照里没有 \.\/only-on-target\.sh 这个文件/, "硬证据要出现在结论里");
    // 这个名字就是个文件路径，而这个文件只有目标分支上有 —— 文件级的确定事实，
    // 措辞不许退回「文字命中」那一档的对冲（反过来也不许，见纯函数那组）。
    assert.match(absent.diagnosis ?? "", /只有目标分支上有/, "文件级事实可以直说");
    assert.equal(/文字命中/.test(absent.diagnosis ?? ""), false, "路径模式不是文字命中");
    assert.match(absent.diagnosis ?? "", new RegExp(entryIntroduced.slice(0, 8)), "要指出是哪次提交把它加到目标分支的");
    assert.match(absent.diagnosis ?? "", /把 main 合进任务分支/, "核实过目标分支上有，才给合入建议");
  }

  console.log("accept gate: 不设=老行为 / 绿了自动续验收 / 红了不合并且回流 / 新鲜度 / 跳过与重跑 / 取消 / 重启打断 / 起不来 / 跑动期间树变了 / 换了命令 / 统一验收 / 跑着时删不掉且跳过要先收掉 / 列表看得见在跑 / 回执只认本次凭据 / 取消等整棵树退出 / 命令没跑到≠测试红了(含嵌套缺件只落 inner) 全部通过");
  await (await import("./test-accept-gate-lifecycle.js")).testGateLifecycle({
    root, makeRepo, seedProject, seedTask, taskRow, settled,
  });
  await (await import("./test-accept-gate-startup.js")).testGateStartup({
    root, makeRepo, seedProject, seedTask, taskRow, settled,
  });
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
