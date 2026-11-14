// 回合收尾**有界**、卡住时**说得清**、占锁之后的出路**都还锁**(turn-wind-down.ts)。
//
// 原则:同一个任务任何时刻只有一个回合的代码活着,锁只由占着它的那一轮在自己的出口放。所以这里
// 钉的是三件事,没有「从旁边放开」那一档:
//   ① 收尾里等外部东西的那几步自己有时限 —— execFileText 关 stdin、到点按进程组杀;圈定时限的
//      段里等仓库锁会放弃排队、让出队位;真收尾链里一条不返回的 git(外部 diff 辅助程序睡死)
//      在时限内被这一轮自己放弃,留痕写明放弃了哪一步和后果,之后能接新回合;
//   ② 进程内卡住的收尾:记步说得出卡在哪,巡检写一条持久提示(出路是重启),人工放开照样拒绝;
//   ③ 占锁之后的出路:/retry 复核读库抛错、归档清理复核读库抛错、待发送交接被在途投递接管、
//      检查点续跑失权不起跑、fresh run 起跑前读库抛错 —— 锁都要还回去。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

const root = mkdtempSync(join(tmpdir(), "ash-turn-wind-down-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_STUCK_WIND_DOWN_MS = "150";
process.env.ASH_WIND_DOWN_COMMAND_TIMEOUT_MS = "500";
assert.ok(process.env.ASH_ALLOW_REAL_AGENT !== "1", "结算钩子失手续跑时不许真拉起 CLI");
process.on("exit", () => {
  try { rmSync(root, { recursive: true, force: true }); } catch {}
});

const { ensureSchema, db, dbClient } = await import("../src/db/index.js");
const { projects, sessions, tasks, taskNotices } = await import("../src/db/schema.js");
const { createTasks } = await import("../src/task-store.js");
const { bindTurnToken, claimOwnTurn, isTurnClaimed, releaseTurn, trackRun, turnIdentity } = await import("../src/runs.js");
const { reportStuckWindDowns, suspectTurns, turnReclaimStatus } = await import("../src/turn-lock-reclaim.js");
const { STUCK_WIND_DOWN_MS, WIND_DOWN_COMMAND_TIMEOUT_MS } = await import("../src/turn-wind-down.js");
const { consumeSingleRun } = await import("../src/single-run.js");
const { recordTurnBaseline } = await import("../src/turn-baseline.js");
const { ExecTimeout, execFileText } = await import("../src/exec.js");
const { externalWaitBound, withExternalWaitBound } = await import("../src/external-wait-bound.js");
const { recordTurnStart } = await import("../src/turn-output.js");
const { noteWindDownProgress, windDownStep, windDownWithin } = await import("../src/turn-wind-down.js");
const { RepoLockWaitTimeout, withRepoLock } = await import("../src/repo-lock.js");
const { RUNS_DIR } = await import("../src/paths.js");
const { mountTaskRunRoutes } = await import("../src/task-run-routes.js");
const { mountTaskRoutes } = await import("../src/task-routes.js");
const { resumeOrRunTask } = await import("../src/task-resume.js");
const { runTask } = await import("../src/task-run.js");
const { holdInFlight } = await import("../src/pending-in-flight.js");
const { cleanupArchivedWorkspaces } = await import("../src/task-archive-cleanup.js");
const { worktreeBranchName } = await import("../src/git.js");

await ensureSchema();
const stamp = new Date().toISOString();
const repo = join(root, "repo");
mkdirSync(repo, { recursive: true });
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
git("init", "-q", "-b", "main");
git("config", "user.email", "t@example.com");
git("config", "user.name", "t");
writeFileSync(join(repo, "a.txt"), "one\n");
git("add", ".");
git("commit", "-qm", "init");
await db.insert(projects).values({
  id: "p1", name: "wind down", repoPath: repo, apiKeys: null, workflowId: null, createdAt: stamp,
});
const baseTask = {
  projectId: "p1", groupId: null, parentId: null, body: "test", mode: "single", status: "running",
  labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
  executorId: null, model: null, reasoningEffort: null, autoTitle: false,
  duet: null, team: null, reportBack: false, scheduleId: null,
  createdAt: stamp, updatedAt: stamp,
  useWorktree: false, worktreeBase: null, originTaskId: null, workflowMode: "free",
};

const api = new Hono();
mountTaskRunRoutes(api);
mountTaskRoutes(api);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what: string, check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error(`等不到:${what}`);
    await sleep(5);
  }
}

/** 给一个 promise 设个上限:原缺陷的形状是「永远不返回」,测试不能跟着挂死。 */
async function within<T>(what: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} 超过 ${ms}ms 没有返回`)), ms); });
  try { return await Promise.race([work, late]); } finally { clearTimeout(timer); }
}

type Statement = Parameters<typeof dbClient.execute>[0];
const sqlOf = (statement: Statement) => String(typeof statement === "string" ? statement : statement.sql);

/** 拦截 SQL(单条与批量都拦):命中 `match` 的第一条交给 `hook`(挂起或抛错),其余照常。返回撤销函数。 */
function interceptSql(match: (sql: string) => boolean, hook: (run: () => Promise<unknown>) => Promise<unknown>): () => void {
  const execute = dbClient.execute.bind(dbClient);
  const batch = dbClient.batch.bind(dbClient);
  let armed = true;
  dbClient.execute = ((statement: Statement) => {
    if (armed && match(sqlOf(statement))) {
      armed = false;
      return hook(() => execute(statement));
    }
    return execute(statement);
  }) as typeof dbClient.execute;
  dbClient.batch = ((statements: readonly Statement[], mode?: Parameters<typeof batch>[1]) => {
    if (armed && statements.some((statement) => match(sqlOf(statement)))) {
      armed = false;
      return hook(() => batch(statements, mode));
    }
    return batch(statements, mode);
  }) as typeof dbClient.batch;
  return () => { dbClient.execute = execute; dbClient.batch = batch; };
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** 起一轮「CLI 已经跑完」的单飞回合,直接走真实的收尾链。返回凭据与收尾那一条 promise。 */
async function windDownTurn(taskId: string) {
  const sessId = `s-${taskId}`;
  await createTasks([{ ...baseTask, id: taskId, title: taskId }]);
  await db.insert(sessions).values({ id: sessId, taskId, role: "single", agentType: "codex", executor: "codex", startedAt: stamp });
  mkdirSync(join(RUNS_DIR, taskId), { recursive: true });
  const turn = claimOwnTurn(taskId)!;
  assert.ok(turn);
  bindTurnToken(taskId, `tok-${taskId}`);
  const handle = { sessionId: sessId, commandLine: "fake", kill() {}, events: (async function* () {})() };
  trackRun(taskId, handle);
  const consumed = consumeSingleRun({
    taskId, sessId, agentType: "codex",
    ex: { model: null, reasoningEffort: null, resumeFields: () => ({}) } as never,
    cwd: repo, handle, out: createWriteStream(join(RUNS_DIR, taskId, `${sessId}.md`), { flags: "a" }),
    turnStart: stamp, cliSessionId: sessId, autoTitle: false, turn,
  });
  return { sessId, turn, consumed };
}

// ── ① 外部命令与仓库锁的时限 ─────────────────────────────────────────────────
{
  // 读 stdin 的命令(仓库 hook、交互式凭据 helper 的形状):没有 input 也要当场读到 EOF。
  const { stdout } = await within("读 stdin 的命令", 3_000, execFileText("sh", ["-c", "read x; echo done"]));
  assert.equal(stdout.trim(), "done");
}
{
  // 到点按进程组杀:命令甩出去的后台后代一并收掉,不等输出管道关上就结算。
  const pidFile = join(root, "bg.pid");
  const started = Date.now();
  const outcome = await within("带时限的命令", 3_000,
    execFileText("sh", ["-c", `sleep 30 & echo $! > ${pidFile}; sleep 30`], { timeoutMs: 300 }).then(() => null, (error: unknown) => error));
  assert.ok(outcome instanceof ExecTimeout, `应以 ExecTimeout 结束,实际:${String(outcome)}`);
  assert.ok(Date.now() - started < 2_000, "到点就结算");
  const pid = Number(readFileSync(pidFile, "utf8"));
  await waitFor("后台后代被进程组击杀收掉", () => !alive(pid), 3_000);
}
{
  // 圈定的段里没显式给时限的命令取段上的时限,到点告诉圈段的人放弃了什么。
  const gaveUp: string[] = [];
  const outcome = await within("圈定时限的命令", 3_000, withExternalWaitBound({ ms: 200, onTimeout: (what) => gaveUp.push(what) },
    () => execFileText("sleep", ["30"])).then(() => null, (error: unknown) => error));
  assert.ok(outcome instanceof ExecTimeout);
  assert.equal(gaveUp.length, 1);
  assert.match(gaveUp[0]!, /sleep 30/);
}
{
  // 圈定的段里等仓库锁:到点放弃排队,不执行;队位让过去,后来的人不被一个走掉的号挡住。
  let releaseHolder!: () => void;
  const holding = new Promise<void>((resolve) => { releaseHolder = resolve; });
  const holder = withRepoLock(repo, () => holding);
  let ran = false;
  const gaveUp: string[] = [];
  const outcome = await within("等仓库锁", 3_000, withExternalWaitBound({ ms: 150, onTimeout: (what) => gaveUp.push(what) },
    () => withRepoLock(repo, () => { ran = true; })).then(() => null, (error: unknown) => error));
  assert.ok(outcome instanceof RepoLockWaitTimeout, `应放弃排队,实际:${String(outcome)}`);
  assert.equal(ran, false, "放弃排队的那一位不执行");
  assert.match(gaveUp[0] ?? "", /等仓库锁/);
  releaseHolder();
  await holder;
  let after = false;
  await within("放弃者之后的排队", 3_000, withRepoLock(repo, () => { after = true; }));
  assert.equal(after, true, "后来的排队照常拿到锁");
}
{
  // 没圈时限的普通调用照样排队:前一位没出来之前进不去,出来之后队尾登记也不会被它提前删掉
  // (否则再来一位、哪怕带时限,也读不到前一位而直接闯进去)。
  const entered: string[] = [];
  let releaseFirst!: () => void;
  const first = withRepoLock(repo, async () => {
    entered.push("first-enter");
    await new Promise<void>((resolve) => { releaseFirst = resolve; });
    entered.push("first-exit");
  });
  await waitFor("第一位进锁", () => entered.includes("first-enter"));
  const second = withRepoLock(repo, () => { entered.push("second"); });
  await sleep(50);
  assert.deepEqual(entered, ["first-enter"], "第一位还占着时普通调用不进");
  const third = withExternalWaitBound({ ms: 2_000, onTimeout: () => {} },
    () => withRepoLock(repo, () => { entered.push("third"); }));
  await sleep(50);
  assert.deepEqual(entered, ["first-enter"], "带时限的第三位也排在后面");
  releaseFirst();
  await within("三位依次走完", 3_000, Promise.all([first, second, third]));
  assert.deepEqual(entered, ["first-enter", "first-exit", "second", "third"]);
}
{
  // 加了时限不改变输出额度的口径:跟 execFile 一样两条流各算各的,不是加起来算。
  const script = "process.stdout.write('o'.repeat(600)); process.stderr.write('e'.repeat(600));";
  for (const timeoutMs of [undefined, 5_000]) {
    const { stdout, stderr } = await within("双流输出", 3_000,
      execFileText(process.execPath, ["-e", script], { maxBuffer: 1024, timeoutMs }));
    assert.equal(stdout.length, 600, `timeoutMs=${timeoutMs}`);
    assert.equal(stderr.length, 600, `timeoutMs=${timeoutMs}`);
  }
}

{
  // 时限只在那一段还没结束时有效:段里 void 出去、段结束之后才跑的后续工作不受它约束。
  let later!: Promise<unknown>;
  await withExternalWaitBound({ ms: 100, onTimeout: () => {} }, async () => {
    assert.ok(externalWaitBound(), "段里读得到时限");
    later = (async () => { await sleep(50); return externalWaitBound(); })();
  });
  assert.equal(await later, undefined, "段结束之后时限失效");
  // 自带 Node `timeout` 的命令(命令站那一类)不被段上的短时限覆盖。
  const { stdout } = await within("自带上限的命令", 3_000, withExternalWaitBound({ ms: 100, onTimeout: () => {} },
    () => execFileText("sh", ["-c", "sleep 0.3; echo fine"], { timeout: 5_000 })));
  assert.equal(stdout.trim(), "fine");
}
{
  // 收尾某一步里报的进度(预设工作流每过一站)记到这一轮名下,沿用那一步的阈值;段结束后不再记。
  const taskId = "t-progress";
  const turn = claimOwnTurn(taskId)!;
  windDownStep(taskId, turn, "结算后续(afterSettlement)", 999);
  await windDownWithin(taskId, turn, 999, async () => {
    await sleep(1);
    noteWindDownProgress("结算后续:预设工作流「命令」站(build)");
  });
  const recorded = turnIdentity(taskId)!.windDown!;
  assert.equal(recorded.step, "结算后续:预设工作流「命令」站(build)");
  assert.equal(recorded.boundMs, 999);
  assert.equal(recorded.index, 2);
  noteWindDownProgress("不在任何收尾里");
  assert.equal(turnIdentity(taskId)!.windDown!.index, 2);
  releaseTurn(taskId, turn);
}

// ── ① 真收尾链:工作区快照的 git 不返回 ────────────────────────────────────────
{
  const taskId = "t-git-hang";
  // 起跑那两张照片照常拍(此刻还没配外部 diff):工作区基线 + 「这一轮有没有产出」的起点。
  writeFileSync(join(repo, "a.txt"), "two\n");
  assert.equal(await recordTurnBaseline(taskId, repo, false), true);
  await recordTurnStart(taskId, repo);
  assert.ok(existsSync(join(RUNS_DIR, taskId, "turn-start.json")));
  // 结算那一张:git diff 调起的外部 diff 辅助程序睡死,并把自己的号记下来。
  const helperPids = join(root, "helper.pids");
  const helper = join(root, "hang-diff.sh");
  writeFileSync(helper, `#!/bin/sh\necho $$ >> ${helperPids}\nsleep 30\n`);
  chmodSync(helper, 0o755);
  git("config", "diff.external", helper);
  try {
    const { sessId, turn, consumed } = await windDownTurn(taskId);
    const started = Date.now();
    await within("收尾链(git 卡住)", 15_000, consumed);
    assert.ok(Date.now() - started < 10 * WIND_DOWN_COMMAND_TIMEOUT_MS, "这一轮在时限内自己结束");
    assert.equal(turnIdentity(taskId)?.windDown?.step, "交卷通道诊断(noteTurnChannelGap)",
      "收尾走完了全程(最后一步是没交卷时的通道诊断)");
    for (const pid of readFileSync(helperPids, "utf8").trim().split("\n").map(Number)) {
      await waitFor(`外部 diff 辅助程序 ${pid} 被收掉`, () => !alive(pid), 3_000);
    }
    const transcript = readFileSync(join(RUNS_DIR, taskId, `${sessId}.md`), "utf8");
    assert.match(transcript, /收尾时给工作区拍照没能完成（git -C .* diff HEAD 超过 \d+ (?:毫秒|秒)没有返回，已终止）/,
      "留痕写明放弃的是哪一步");
    assert.match(transcript, /按「这一轮改过代码」处理/, "留痕写明后果");
    assert.ok(!existsSync(join(RUNS_DIR, taskId, "turn-start.json")), "结算里那次产出探测确实跑过(它也卡在同一个 git 上,按时限放弃)");
    const row = (await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId))).at(0);
    assert.notEqual(row?.status, "running", "任务照常落位(这一轮没交卷 → 未完成)");
    // 起跑方的出口放锁(orchestrator / task-run 那道 finally),之后能接新回合。
    releaseTurn(taskId, turn);
    const next = claimOwnTurn(taskId);
    assert.ok(next, "放锁之后能接新回合");
    assert.equal(next.windDown, undefined, "新回合身上不带上一轮的收尾记步");
    releaseTurn(taskId, next);
  } finally {
    git("config", "--unset", "diff.external");
    git("checkout", "--", "a.txt");
  }
}

// ── ② 进程内卡住的收尾:持久提示 + 人工放开照样拒绝 ─────────────────────────────
{
  const taskId = "t-stuck";
  let resumeHang!: () => void;
  const hung = new Promise<void>((resolve) => { resumeHang = resolve; });
  const restore = interceptSql(
    (sql) => /^\s*update\s+"sessions"/i.test(sql) && /"exit_status"/i.test(sql),
    async (run) => { await hung; return run(); },
  );
  const { turn, consumed } = await windDownTurn(taskId);
  const stepNow = () => turnIdentity(taskId)?.windDown?.step ?? null;
  await waitFor("收尾走到写会话那一步", () => stepNow() === "写执行记录与会话收尾(closeExecution / recordTurnSpan)");

  // 没到阈值:不报;人工放开拒绝,说的是「正在收尾,会自己放」。
  assert.equal(await reportStuckWindDowns(), 0);
  const early = turnReclaimStatus(taskId);
  assert.equal(early.kind, "blocked");
  assert.match(early.kind === "blocked" ? early.reason : "", /正在收尾.*会自己放开占位/);

  await sleep(STUCK_WIND_DOWN_MS + 50);
  assert.equal(await reportStuckWindDowns(), 1, "停在同一步超过阈值:写一条提示");
  assert.equal(await reportStuckWindDowns(), 0, "同一步只报一次");
  const notes = await db.select().from(taskNotices).where(eq(taskNotices.taskId, taskId));
  const stuck = notes.find((row) => row.action === "回合收尾卡住");
  assert.ok(stuck, "提示要落库(刷新页面后还在)");
  assert.match(stuck.reason, /收尾停在「写执行记录与会话收尾\(closeExecution \/ recordTurnSpan\)」已经约/);
  assert.match(stuck.reason, /出路是重启 ash/);
  assert.match(stuck.reason, /不提供手动放开/);
  {
    const response = await api.request(`/tasks/${taskId}/notices`);
    const body = await response.json() as { notices: { reason?: string; text?: string }[]; remedy: string | null };
    assert.equal(body.remedy, null, "这类锁不给放开开关");
    assert.ok(JSON.stringify(body.notices).includes("回合收尾卡住"), "详情页读得到这条提示");
  }
  assert.ok(!suspectTurns().some((suspect) => suspect.taskId === taskId), "不进可放开的名单");
  const late = turnReclaimStatus(taskId);
  assert.equal(late.kind, "blocked", "人工放开照样拒绝");
  assert.match(late.kind === "blocked" ? late.reason : "", /收尾停在「写执行记录与会话收尾.*出路是重启 ash/,
    "拒绝的话里带同样的说明");
  assert.equal(turnIdentity(taskId)?.seq, turn.seq, "锁原样在原回合手上");

  // 卡住的那一步走动了:收尾自己走完,出口放锁。
  resumeHang();
  await within("收尾链(卡住后恢复)", 10_000, consumed);
  restore();
  releaseTurn(taskId, turn);
  assert.equal(isTurnClaimed(taskId), false);
}

// ── ③ 占锁之后的出路都还锁 ───────────────────────────────────────────────────
{
  // /retry 带 expectedFailure:占锁后复核读库抛错。
  await createTasks([{ ...baseTask, id: "t-retry", title: "retry read fails", status: "failed" }]);
  let fired = 0;
  const restore = interceptSql(
    (sql) => /^\s*select\b/i.test(sql) && /from "tasks"/i.test(sql) && isTurnClaimed("t-retry"),
    () => { fired += 1; return Promise.reject(new Error("injected read failure")); },
  );
  try {
    const response = await api.request("/tasks/t-retry/retry", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedFailure: "v1" }),
    });
    assert.equal(response.status, 500);
  } finally {
    restore();
  }
  assert.equal(fired, 1, "注入点命中的是占锁之后那一读");
  assert.equal(isTurnClaimed("t-retry"), false, "/retry 占锁后读库抛错要把锁还回去");
}
{
  // 归档清理:占住工作区之后复核归档态那一读抛错。
  const taskId = "t-archived";
  await createTasks([{ ...baseTask, id: taskId, title: "archived", status: "done" }]);
  await db.update(tasks).set({ archived: true }).where(eq(tasks.id, taskId));
  git("branch", worktreeBranchName(taskId));
  let fired = 0;
  const restore = interceptSql(
    (sql) => /^\s*select "archived" from "tasks"/i.test(sql) && isTurnClaimed(taskId),
    () => { fired += 1; return Promise.reject(new Error("injected read failure")); },
  );
  try {
    const outcome = await cleanupArchivedWorkspaces(repo, [{ id: taskId, title: "archived" }]).then(() => null, (error: unknown) => error);
    assert.ok(outcome instanceof Error);
  } finally {
    restore();
  }
  assert.equal(fired, 1, "注入点命中的是占住工作区之后那一读");
  assert.equal(isTurnClaimed(taskId), false, "归档清理复核读库抛错要把工作区锁还回去");
}
{
  // 待发送交接:已有投递在途,这次启动「由它开回合」—— 入口交来的锁得还给它。
  await createTasks([{ ...baseTask, id: "t-inflight", title: "delivery in flight", status: "paused" }]);
  const turn = claimOwnTurn("t-inflight")!;
  const releaseInFlight = holdInFlight("t-inflight");
  try {
    await within("待发送交接", 5_000, resumeOrRunTask("t-inflight", { reason: "queue", turnHeld: turn }));
  } finally {
    releaseInFlight();
  }
  assert.equal(isTurnClaimed("t-inflight"), false, "交给在途投递之后,入口占的锁要还回去");
}
{
  // 检查点续跑:认领凭证之后复查归属失败(问不出来)→ 这一趟不起跑,入口交来的锁要还。
  const taskId = "t-checkpoint";
  await createTasks([{ ...baseTask, id: taskId, title: "checkpoint", status: "paused" }]);
  await db.update(tasks).set({ resumePrompt: "接着做第二步" }).where(eq(tasks.id, taskId));
  let fired = 0;
  const restore = interceptSql(
    (sql) => /^\s*update "scheduled_messages" set "delivering_since"/i.test(sql) && /"checkpoint_taken"/i.test(sql),
    () => { fired += 1; return Promise.reject(new Error("injected ownership check failure")); },
  );
  const turn = claimOwnTurn(taskId)!;
  try {
    await within("检查点续跑", 5_000, resumeOrRunTask(taskId, { reason: "queue", turnHeld: turn }));
  } finally {
    restore();
  }
  assert.equal(fired, 1, "注入点命中的是凭证归属复查");
  assert.equal(isTurnClaimed(taskId), false, "检查点续跑失权不起跑,入口占的锁要还回去");
}
{
  // fresh run:起跑前读任务头抛错(还没走到它自己的 try)。
  const taskId = "t-fresh";
  await createTasks([{ ...baseTask, id: taskId, title: "fresh", status: "backlog" }]);
  let fired = 0;
  const restore = interceptSql(
    (sql) => /^\s*select "mode", "handoff" from "tasks"/i.test(sql) && isTurnClaimed(taskId),
    () => { fired += 1; return Promise.reject(new Error("injected read failure")); },
  );
  const turn = claimOwnTurn(taskId)!;
  try {
    const outcome = await runTask(taskId, { turnHeld: turn }).then(() => null, (error: unknown) => error);
    assert.ok(outcome instanceof Error);
  } finally {
    restore();
  }
  assert.equal(fired, 1, "注入点命中的是起跑前那一读");
  assert.equal(isTurnClaimed(taskId), false, "fresh run 起跑前读库抛错要把入口交来的锁还回去");
}

assert.ok(!existsSync(join(repo, ".worktrees")), "测试没有在仓库里留下 worktree");
console.log("test-turn-wind-down: ok");
process.exit(0);
