import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-free-workflow-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * 「把时间线那一笔堵住」用的 FIFO（重跑交错那一段）。
 *
 * 读者要**一直守着**：没有读者的写入会一路挂着，进程就卡在那儿不退出——回归退化时本该
 * 看得见的那句断言会变成「测试跑不完」。而且不能只读一次：第一个写者关掉时读端就 EOF 了，
 * 后面那个写者（退化时那次「预览已打开」）又会重新堵住，所以 end 之后要接着开下一个。
 * 收尾时 stopDrainingFifo 把它拆掉，否则一个永远开着的读端自己就会吊住事件循环。
 */
let stopDrainingFifo: (() => void) | null = null;
function drainFifo(path: string): void {
  let on = true;
  let current: ReturnType<typeof createReadStream> | null = null;
  const open = () => {
    if (!on || !existsSync(path)) return;
    const reader = createReadStream(path);
    current = reader;
    reader.resume();
    reader.on("end", () => { reader.close(); open(); });
    reader.on("error", () => { /* 拆掉读端时会来一发，忽略 */ });
  };
  stopDrainingFifo = () => { on = false; current?.destroy(); stopDrainingFifo = null; };
  open();
}

/**
 * 收尾时把还活着的预览进程收掉。回归退化时那一路会真的把服务起起来，断言炸在它前面，
 * 于是既漏一个监听着端口的孤儿进程，又把事件循环吊住（同上：断言打印了，进程不退）。
 */
function killLeftoverPreviews(runsRoot: string): void {
  if (!existsSync(runsRoot)) return;
  for (const dir of readdirSync(runsRoot)) {
    const file = join(runsRoot, dir, "preview.json");
    if (!existsSync(file)) continue;
    try {
      const { pid } = JSON.parse(readFileSync(file, "utf8")) as { pid: number };
      if (pid > 0) process.kill(-pid, "SIGKILL");
    } catch { /* 已经走了 */ }
  }
}

/** 等一个条件成真（用在真实路由 + 真实仓库锁那一段：时序靠等，不靠猜固定毫秒）。 */
async function waitFor(check: () => boolean | Promise<boolean>, message: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  assert.fail(message);
}

let failure: unknown = null;
try {
  const { ensureSchema, db, dbClient } = await import("../src/db/index.js");
  const { agents, freeReviewRounds, freeReviewRuns, freeWorkflowStates, projects, sessions, tasks } = await import("../src/db/schema.js");
  const { createTasks } = await import("../src/task-store.js");
  const {
    freeReviewOutcome,
    freeReviewPrompt,
    freeReviewReminder,
    freeRepairPrompt,
    freeManualRepairPrompt,
    freeReviewResumeOptions,
    handleFreeWorkflowSettlement,
    startManualFreeReviewRepair,
  } = await import("../src/free-workflow.js");
  const { mountFreeWorkflowRoutes } = await import("../src/free-workflow-routes.js");
  const { releaseFreeWorkflowAction, tryAcquireFreeWorkflowAction } = await import("../src/free-workflow-lock.js");
  const {
    createExecutionCloser,
    finishFreeTaskExecution,
    recordFreeTaskExecutionStartIfFree,
  } = await import("../src/free-workflow-events.js");
  const { claimTurn } = await import("../src/runs.js");
  const { prepareWorktree } = await import("../src/git.js");
  const { withRepoLock } = await import("../src/repo-lock.js");
  const { setTaskStatus } = await import("../src/status.js");
  const { mountReviewerProfileRoutes } = await import("../src/reviewer-profiles.js");
  const { mountTaskRoutes } = await import("../src/task-routes.js");
  const { mountTaskStageRoutes } = await import("../src/task-stage.js");
  const { acceptTask } = await import("../src/task-accept.js");
  const { sessionTranscriptPath } = await import("../src/transcript.js");
  const { ACCEPTANCE_REMINDER } = await import("../src/run-prompts.js");
  await ensureSchema();

  const freeAcceptanceReminder = ACCEPTANCE_REMINDER("free-task", false, false, true);
  assert.match(freeAcceptanceReminder, /任务完成后由用户从统一验收页验收/, "自由任务完成协议应指向统一验收页");
  assert.doesNotMatch(freeAcceptanceReminder, /合并.?清理/, "自由任务完成协议不得再指向已删除的合并快捷操作");

  await db.insert(projects).values({ id: "p", name: "test", repoPath: root, apiKeys: null, workflowId: null, createdAt: new Date().toISOString() });
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Ash Test");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-m", "base");
  await db.insert(projects).values({ id: "p-git", name: "git test", repoPath: repo, apiKeys: null, workflowId: null, createdAt: new Date().toISOString() });
  await db.insert(agents).values({
    id: "reviewer-executor", name: "codex@test", type: "codex",    model: "gpt-test", extraArgs: "[]", reasoningEffort: "high", speed: null, providerId: null, isDefault: true,
  });

  const [task] = await createTasks([{
    id: "free-task", projectId: "p", groupId: null, parentId: null,
    title: "free", body: "test", mode: "single", status: "backlog",
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
    executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
    duet: null, team: null, reportBack: false, scheduleId: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    useWorktree: false, worktreeBase: null, originTaskId: null, workflowMode: "free",
  }]);
  assert.equal(task?.workflowMode, "free");
  assert.equal(task?.workflow, null, "自由任务不能被 createTasks 偷偷补上默认起手式");

  const directiveAt = "2026-08-09T07:23:33.985Z";
  await db.insert(sessions).values({
    id: "skill-directive-session", taskId: "free-task", role: "lead", agentType: "codex",
    executor: "codex@test", startedAt: directiveAt,
  });
  const directivePath = sessionTranscriptPath("free-task", "skill-directive-session");
  mkdirSync(dirname(directivePath), { recursive: true });
  writeFileSync(directivePath, `\x1e${JSON.stringify({
    t: "user", agent: "codex", text: "把排队需求也一起做完\n/grill-me", at: directiveAt,
  })}\n`);
  const promptTask = (await db.select().from(tasks).where(eq(tasks.id, "free-task"))).at(0)!;
  const promptRun: Parameters<typeof freeReviewPrompt>[1] = {
    id: "skill-review", taskId: "free-task", reviewerId: "reviewer", reviewerName: "Codex logic",
    agentType: "codex", executorId: "reviewer-executor", model: null, reasoningEffort: "high",
    checkMode: "logic", note: "重点检查 Enter 快捷键", retryLimit: 1, currentRound: 1, status: "reviewing",
    createdAt: directiveAt, updatedAt: directiveAt, finishedAt: null,
  };
  const skillPrompt = await freeReviewPrompt({
    ...promptTask,
    title: "标题也可能点名 /grill-me",
    body: "原始正文要求运行 /grill-me",
  }, promptRun, 1, root);
  assert.doesNotMatch(skillPrompt, /grill-me|把排队需求也一起做完/, "自由审查 prompt 不得原样夹带技能名或用户追问");
  assert.match(skillPrompt, /request-context\.md/, "自由审查应改为引用需求文件");
  assert.match(skillPrompt, /用户附言[\s\S]*重点检查 Enter 快捷键/, "派审附言必须进入审查提示");
  const assertBrowserPolicy = (text: string, source: string) => {
    const groupedBrowser = text.indexOf("扩展具名分组后台标签");
    const headlessBrowser = text.indexOf("独立无头浏览器");
    const headedBrowser = text.indexOf("独立有头浏览器");
    assert.ok(
      groupedBrowser >= 0 && groupedBrowser < headlessBrowser && headlessBrowser < headedBrowser,
      `${source} 必须保留三级浏览器降级顺序`,
    );
    assert.match(text, /不得操作用户普通 Chrome 标签|不得接管、复用或直连用户的普通标签/, `${source} 不得操作用户普通 Chrome 标签`);
    assert.match(text, /Playwright.*headless/i, `${source} 的 Playwright 必须默认无头`);
  };
  assertBrowserPolicy(skillPrompt, "自由审查 prompt");
  const skillContext = readFileSync(join(root, "runs", "free-task", "free-review", "skill-review", "round-1", "request-context.md"), "utf8");
  assert.match(skillContext, /标题也可能点名 \/grill-me/);
  assert.match(skillContext, /原始正文要求运行 \/grill-me/);
  assert.match(skillContext, /把排队需求也一起做完[\s\S]*\/grill-me/, "需求文件仍须完整保留后续追问");
  const repair = freeRepairPrompt("free-task", promptRun);
  assert.match(repair, /\[report\.md\]\([^\n]+report\.md\)/, "修复交接应引用唯一的 report.md");
  assert.doesNotMatch(repair, /shot\.png|截图：/, "截图已收进报告，不应在修复交接里重复列出");
  assert.doesNotMatch(repair, /审查报告：\n#/, "修复交接不得复制报告正文");

  await createTasks([{
    id: "free-accept-task", projectId: "p", groupId: null, parentId: null,
    title: "free accept", body: "test", mode: "single", status: "done",
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
    executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
    duet: null, team: null, reportBack: false, scheduleId: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    useWorktree: false, worktreeBase: null, originTaskId: null, workflowMode: "free",
  }]);

  const [worktreeTask] = await createTasks([{
    id: "free-worktree-task", projectId: "p-git", groupId: null, parentId: null,
    title: "free worktree accept", body: "test", mode: "single", status: "done",
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
    executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
    duet: null, team: null, reportBack: false, scheduleId: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    useWorktree: true, worktreeBase: "main", originTaskId: null, workflowMode: "free",
  }]);
  assert.equal(worktreeTask?.useWorktree, true);
  const worktree = await prepareWorktree(repo, "free-worktree-task", "main");
  writeFileSync(join(worktree.path, "accepted.txt"), "accepted\n");
  git(worktree.path, "add", "accepted.txt");
  git(worktree.path, "commit", "-m", "free worktree result");
  const mainBeforeAcceptance = git(repo, "rev-parse", "main");

  await createTasks([{
    id: "free-exhausted-task", projectId: "p-git", groupId: null, parentId: null,
    title: "free exhausted", body: "test", mode: "single", status: "done",
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
    executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
    duet: null, team: null, reportBack: false, scheduleId: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    useWorktree: false, worktreeBase: null, originTaskId: null, workflowMode: "free",
  }]);

  await createTasks([{
    id: "free-rework-task", projectId: "p", groupId: null, parentId: null,
    title: "free rework", body: "test", mode: "single", status: "done",
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
    executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
    duet: null, team: null, reportBack: false, scheduleId: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    useWorktree: false, worktreeBase: null, originTaskId: null, workflowMode: "free",
  }]);

  await createTasks([{
    id: "free-reservation-task", projectId: "p", groupId: null, parentId: null,
    title: "free reservation", body: "test", mode: "single", status: "running",
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
    executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
    duet: null, team: null, reportBack: false, scheduleId: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    useWorktree: false, worktreeBase: null, originTaskId: null, workflowMode: "free",
  }]);

  assert.equal(freeReviewOutcome({ turnOk: true, conclusion: "verify_failed", currentRound: 1, retryLimit: 1 }), "repair");
  assert.equal(freeReviewOutcome({ turnOk: true, conclusion: "verify_failed", currentRound: 2, retryLimit: 1 }), "exhausted");
  assert.equal(freeReviewOutcome({ turnOk: true, conclusion: "verified", currentRound: 1, retryLimit: 1 }), "passed");
  assert.equal(freeReviewOutcome({ turnOk: false, conclusion: "verified", currentRound: 1, retryLimit: 1 }), "failed");

  const api = new Hono();
  mountReviewerProfileRoutes(api);
  mountFreeWorkflowRoutes(api);
  mountTaskStageRoutes(api);
  mountTaskRoutes(api);
  const created = await api.request("/reviewer-profiles", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Codex logic", agentType: "codex", executorId: "reviewer-executor", model: null, reasoningEffort: "high" }),
  });
  assert.equal(created.status, 201);
  const reviewer = await created.json() as { id: string };
  assert.ok(reviewer.id);

  const exhaustedAt = new Date().toISOString();
  const exhaustedRun = {
    id: "exhausted-review", taskId: "free-exhausted-task", reviewerId: reviewer.id, reviewerName: "Codex logic",
    agentType: "codex", executorId: "reviewer-executor", model: "gpt-review", reasoningEffort: "high",
    checkMode: "logic", note: null, retryLimit: 1, currentRound: 2, status: "stopped",
    createdAt: exhaustedAt, updatedAt: exhaustedAt, finishedAt: exhaustedAt,
  };
  await db.insert(freeReviewRuns).values(exhaustedRun);
  await db.insert(freeReviewRounds).values({
    id: "exhausted-review-round-2", runId: exhaustedRun.id, round: 2, status: "failed",
    conclusion: "verify_failed", reviewedCommit: git(repo, "rev-parse", "HEAD"),
    startedAt: exhaustedAt, endedAt: exhaustedAt,
  });
  const exhaustedEvidence = join(root, "runs", "free-exhausted-task", "free-review", exhaustedRun.id, "round-2");
  mkdirSync(exhaustedEvidence, { recursive: true });
  writeFileSync(join(exhaustedEvidence, "report.md"), "# 仍需修复\n\n按钮状态不对。\n");
  const manualRepair = freeManualRepairPrompt("free-exhausted-task", exhaustedRun);
  assert.match(manualRepair, /自动复审已停止/);
  assert.match(manualRepair, /不会擅自增加审查轮数/);
  assert.match(manualRepair, /预约了复审，完成后按预约开始/);
  assert.doesNotMatch(manualRepair, /随后会自动派同一位审查者复审/);

  // HTTP 修复入口与普通回合**原子互斥**（holdTurn 占位身份 dispatch）：普通回合已
  // claim、status 尚未落 running 的窗口里必须 409，不得把旧意见排到那个回合之后执行
  // （审查实测：窗口里 200 排队，投递时 freshness 早已过期）。
  assert.equal(claimTurn("free-exhausted-task"), true, "测试占住回合，模拟 claim→running 窗口");
  const blockedRepair = await api.request("/tasks/free-exhausted-task/free-workflow/review/repair", { method: "POST" });
  assert.equal(blockedRepair.status, 409, "回合已被占时修复入口必须拒绝");
  // 内部入口（结算侧，不 holdTurn）沿用排队语义：投递滞留在 whenTurnIdle（turn 一直
  // 占着），正好在不真正启动执行器的前提下验证「代发消息不翻转状态 + 在途去重」。
  const repairState = await startManualFreeReviewRepair("free-exhausted-task");
  assert.equal(repairState.reviews[0]?.status, "stopped",
    "一键修复只代发消息，不再翻转 run 状态（修复中由任务 running 推导）");
  await assert.rejects(startManualFreeReviewRepair("free-exhausted-task"), /在途/, "修复消息在途时不得重复发起");
  // 预约是**控制类**动作：turn 占着（回合跑着）也允许写入——语义是「下一次确认完成时
  // 消费」，不论那个回合何时开跑（free-workflow.ts reserveFreeReview 的注释）。
  const repairReservation = await api.request("/tasks/free-exhausted-task/free-workflow/review-reservation", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ reviewerId: reviewer.id, checkMode: "logic", retryLimit: 1, note: "复审时关注按钮状态" }),
  });
  assert.equal(repairReservation.status, 200, "stopped 状态下必须允许预约复审（修复顺序不限，回合进行中同样允许）");
  assert.equal((await repairReservation.json() as { reviewReservation: { armed: boolean } }).reviewReservation.armed, true);
  await handleFreeWorkflowSettlement("free-exhausted-task", "done", true, true);
  const afterRepair = await api.request("/tasks/free-exhausted-task/free-workflow").then((response) => response.json()) as {
    reviewReservation: { armed: boolean }; reviews: Array<{ id: string; status: string }>;
  };
  assert.equal(afterRepair.reviewReservation.armed, false, "预约复审启动后应清掉预约态");
  assert.equal(afterRepair.reviews.find((run) => run.id === exhaustedRun.id)?.status, "stopped", "旧链保持 stopped，结论新鲜度由 reviewedCommit 判断");
  assert.equal(afterRepair.reviews.filter((run) => run.status === "reviewing").length, 1, "确认完成后应按预约自动派出一轮新审查");

  // 自动续轮预约（runId）：修复确认完成后在同一条 run 上续下一轮，不开新 run。
  const reworkRun = { ...exhaustedRun, id: "chat-rework", taskId: "free-rework-task", reviewerId: reviewer.id, currentRound: 1 };
  await db.insert(freeReviewRuns).values(reworkRun);
  await db.insert(freeReviewRounds).values({
    id: "chat-rework-round-1", runId: reworkRun.id, round: 1, status: "failed",
    conclusion: "verify_failed", startedAt: exhaustedAt, endedAt: exhaustedAt,
  });
  let reworkState = await api.request("/tasks/free-rework-task/free-workflow").then((response) => response.json()) as { reviews: Array<{ status: string; currentRound: number }> };
  assert.equal(reworkState.reviews[0]?.status, "stopped", "未通过后 run 停在 stopped，没有叙事状态要翻转");
  // 无预约时确认完成：什么都不派，旧链保持 stopped。
  await handleFreeWorkflowSettlement("free-rework-task", "done", true, true);
  reworkState = await api.request("/tasks/free-rework-task/free-workflow").then((response) => response.json()) as typeof reworkState;
  assert.equal(reworkState.reviews.length, 1, "无预约时确认完成不得自动派审");
  assert.equal(reworkState.reviews[0]?.status, "stopped");
  // 挂续轮预约再确认完成：同一 run 续 round 2。
  await db.insert(freeWorkflowStates).values({
    taskId: "free-rework-task", selectedReviewerId: reviewer.id, reviewArmed: true,
    reviewCheckMode: "logic", reviewRetryLimit: 1, reviewNote: null, reviewRunId: reworkRun.id,
    updatedAt: new Date().toISOString(),
  }).onConflictDoUpdate({
    target: freeWorkflowStates.taskId,
    set: { reviewArmed: true, reviewRunId: reworkRun.id, updatedAt: new Date().toISOString() },
  });
  assert.equal(claimTurn("free-rework-task"), true);
  await handleFreeWorkflowSettlement("free-rework-task", "done", true, true);
  const continuedState = await api.request("/tasks/free-rework-task/free-workflow").then((response) => response.json()) as {
    reviewReservation: { armed: boolean; runId: string | null };
    reviews: Array<{ id: string; status: string; currentRound: number }>;
  };
  assert.equal(continuedState.reviews.length, 1, "续轮预约应在原 run 上续，不得开新 run");
  assert.equal(continuedState.reviews[0]?.status, "reviewing");
  assert.equal(continuedState.reviews[0]?.currentRound, 2, "确认完成后应续到第 2 轮");
  assert.equal(continuedState.reviewReservation.armed, false, "续轮开跑即消费预约槽");

  const reserveReview = async (checkMode: "logic" | "syntax", retryLimit: number, note: string | null = null) => api.request(
    "/tasks/free-reservation-task/free-workflow/review-reservation",
    { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ reviewerId: reviewer.id, checkMode, retryLimit, note }) },
  );
  assert.equal((await reserveReview("logic", 1, "x".repeat(2001))).status, 409, "附言必须有后端长度上限");
  let reserved = await reserveReview("logic", 1, " 重点检查窄屏布局 ");
  assert.equal(reserved.status, 200);
  let reservedState = await reserved.json() as { reviewReservation: { armed: boolean; checkMode: string | null; retryLimit: number | null; note: string | null } };
  assert.deepEqual(reservedState.reviewReservation, {
    armed: true, reviewerId: reviewer.id, checkMode: "logic", retryLimit: 1, note: "重点检查窄屏布局",
    override: null, runId: null,
  });

  reserved = await reserveReview("syntax", 2, "检查预约覆盖");
  assert.equal(reserved.status, 200);
  reservedState = await reserved.json() as typeof reservedState;
  assert.deepEqual(reservedState.reviewReservation, {
    armed: true, reviewerId: reviewer.id, checkMode: "syntax", retryLimit: 2, note: "检查预约覆盖",
    override: null, runId: null,
  }, "重复预约应覆盖同一份配置与附言");

  const canceledReservation = await api.request("/tasks/free-reservation-task/free-workflow/review-reservation", { method: "DELETE" });
  assert.equal(canceledReservation.status, 200);
  assert.equal((await canceledReservation.json() as { reviewReservation: { armed: boolean } }).reviewReservation.armed, false);

  await reserveReview("logic", 2, "重点检查 Enter 快捷键");
  await db.update(tasks).set({ status: "failed" }).where(eq(tasks.id, "free-reservation-task"));
  await handleFreeWorkflowSettlement("free-reservation-task", "failed", false, false);
  assert.equal((await api.request("/tasks/free-reservation-task/free-workflow").then((response) => response.json()) as { reviewReservation: { armed: boolean } }).reviewReservation.armed, true, "失败结算应保留预约");

  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, "free-reservation-task"));
  assert.equal(claimTurn("free-reservation-task"), true);
  await handleFreeWorkflowSettlement("free-reservation-task", "done", true, true);
  const triggered = await api.request("/tasks/free-reservation-task/free-workflow");
  const triggeredState = await triggered.json() as {
    reviewReservation: { armed: boolean };
    reviews: Array<{ status: string; checkMode: string; retryLimit: number; note: string | null }>;
  };
  assert.equal(triggeredState.reviewReservation.armed, false);
  assert.deepEqual(triggeredState.reviews.map(({ status, checkMode, retryLimit, note }) => ({ status, checkMode, retryLimit, note })), [
    { status: "reviewing", checkMode: "logic", retryLimit: 2, note: "重点检查 Enter 快捷键" },
  ], "confirmed done 应按预约配置与附言自动派出且只派一份审查");
  assertBrowserPolicy(await freeReviewReminder("free-reservation-task"), "自由审查续聊提醒");

  // 删除审查者时必须同步 disarm：否则 UI 仍显示已预约，结算因 reviewerId 为空静默不派审。
  await createTasks([{
    id: "free-deleted-reviewer-task", projectId: "p", groupId: null, parentId: null,
    title: "free deleted reviewer", body: "test", mode: "single", status: "running",
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
    executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
    duet: null, team: null, reportBack: false, scheduleId: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    useWorktree: false, worktreeBase: null, originTaskId: null, workflowMode: "free",
  }]);
  const disposableReviewerRes = await api.request("/reviewer-profiles", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Disposable", agentType: "codex", executorId: "reviewer-executor", model: null, reasoningEffort: "high" }),
  });
  assert.equal(disposableReviewerRes.status, 201);
  const disposableReviewer = await disposableReviewerRes.json() as { id: string };
  const reservedDisposable = await api.request(
    "/tasks/free-deleted-reviewer-task/free-workflow/review-reservation",
    { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ reviewerId: disposableReviewer.id, checkMode: "logic", retryLimit: 1 }) },
  );
  assert.equal(reservedDisposable.status, 200);
  assert.equal((await reservedDisposable.json() as { reviewReservation: { armed: boolean } }).reviewReservation.armed, true);

  const deletedReviewer = await api.request(`/reviewer-profiles/${disposableReviewer.id}`, { method: "DELETE" });
  assert.equal(deletedReviewer.status, 200);
  const afterDeleteState = await api.request("/tasks/free-deleted-reviewer-task/free-workflow").then((response) => response.json()) as {
    reviewReservation: { armed: boolean; reviewerId: string | null };
  };
  assert.deepEqual(afterDeleteState.reviewReservation, { armed: false, reviewerId: null, checkMode: null, retryLimit: null, note: null, override: null, runId: null },
    "删除审查者后预约必须取消，不能留下 armed 且 reviewerId 为空");

  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, "free-deleted-reviewer-task"));
  assert.equal(claimTurn("free-deleted-reviewer-task"), true);
  await handleFreeWorkflowSettlement("free-deleted-reviewer-task", "done", true, true);
  const afterDeleteSettle = await api.request("/tasks/free-deleted-reviewer-task/free-workflow").then((response) => response.json()) as {
    reviewReservation: { armed: boolean }; reviews: unknown[];
  };
  assert.equal(afterDeleteSettle.reviewReservation.armed, false);
  assert.deepEqual(afterDeleteSettle.reviews, [], "审查者已删除时 confirmed done 不得静默保留空预约，也不应派出审查");

  // 结算守底：历史脏数据 armed=true 且 reviewerId=null 时必须 disarm 并留痕，不能静默跳过。
  await createTasks([{
    id: "free-orphan-arm-task", projectId: "p", groupId: null, parentId: null,
    title: "free orphan arm", body: "test", mode: "single", status: "done",
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
    executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
    duet: null, team: null, reportBack: false, scheduleId: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    useWorktree: false, worktreeBase: null, originTaskId: null, workflowMode: "free",
  }]);
  await db.insert(freeWorkflowStates).values({
    taskId: "free-orphan-arm-task", selectedReviewerId: null, reviewArmed: true,
    reviewCheckMode: "logic", reviewRetryLimit: 1, reviewNote: "不应泄漏的脏附言",
    updatedAt: new Date().toISOString(),
  });
  assert.equal(
    (await api.request("/tasks/free-orphan-arm-task/free-workflow").then((response) => response.json()) as { reviewReservation: { armed: boolean } }).reviewReservation.armed,
    false,
    "读状态时 armed 且无 reviewerId 不得对外表现为已预约",
  );
  assert.equal(claimTurn("free-orphan-arm-task"), true);
  await handleFreeWorkflowSettlement("free-orphan-arm-task", "done", true, true);
  const orphanAfter = await api.request("/tasks/free-orphan-arm-task/free-workflow").then((response) => response.json()) as {
    reviewReservation: { armed: boolean }; reviews: unknown[];
  };
  assert.equal(orphanAfter.reviewReservation.armed, false);
  assert.deepEqual(orphanAfter.reviews, [], "脏预约结算后应 disarm 且不派审");
  const orphanRow = (await db.select().from(freeWorkflowStates).where(eq(freeWorkflowStates.taskId, "free-orphan-arm-task"))).at(0);
  assert.equal(orphanRow?.reviewArmed, false, "结算守底应把 DB 里的 reviewArmed 清掉");

  const state = await api.request("/tasks/free-task/free-workflow");
  assert.equal(state.status, 200);
  const initialState = await state.json() as { reviews: unknown[]; executions: Array<{ status: string }>; merge?: unknown };
  assert.deepEqual(initialState.reviews, []);
  assert.equal(initialState.executions.length, 1, "历史自由任务没有执行事件时仍应保留一条兼容记录");
  assert.equal("merge" in initialState, false, "自由工作流状态不应再暴露第二套合并状态");

  const firstExecution = await recordFreeTaskExecutionStartIfFree("free-task", "2026-08-08T09:00:00.000Z");
  assert.ok(firstExecution);
  assert.equal(
    await recordFreeTaskExecutionStartIfFree("free-task", "2026-08-08T09:00:00.000Z"),
    firstExecution,
    "服务重启接回同一回合时不得重复新增任务执行记录",
  );
  await finishFreeTaskExecution(firstExecution, "completed", "2026-08-08T09:10:00.000Z");
  const secondExecution = await recordFreeTaskExecutionStartIfFree("free-task", "2026-08-08T11:00:00.000Z");
  assert.ok(secondExecution);
  await finishFreeTaskExecution(secondExecution, "completed", "2026-08-08T11:04:00.000Z");
  const executionHistory = await api.request("/tasks/free-task/free-workflow").then((response) => response.json()) as {
    executions: Array<{ id: string; status: string; startedAt: string; endedAt: string | null }>;
  };
  assert.deepEqual(executionHistory.executions, [
    { id: firstExecution, status: "completed", startedAt: "2026-08-08T09:00:00.000Z", endedAt: "2026-08-08T09:10:00.000Z" },
    { id: secondExecution, status: "completed", startedAt: "2026-08-08T11:00:00.000Z", endedAt: "2026-08-08T11:04:00.000Z" },
  ], "每次任务执行必须独立保留起止时间，不能被后一次覆盖");

  // 结账人:终态只认第一次请求的那个。single-run 的 finally 上挂着一次固定传 "failed" 的
  // 兜底(给异常路径用),正常路径要是第一次写库瞬时失败,兜底就会拿 "failed" 重试并写成功
  // —— 一个 exit 0 的成功回合被永久记成失败。这里让 completed 那次更新真的失败一次。
  const thirdExecution = await recordFreeTaskExecutionStartIfFree("free-task", "2026-08-08T12:00:00.000Z");
  assert.ok(thirdExecution);
  dbClient.executeMultiple(
    "CREATE TRIGGER injected_completed_failure BEFORE UPDATE ON free_workflow_events"
    + " WHEN NEW.detail LIKE '%\"completed\"%'"
    + " BEGIN SELECT RAISE(ABORT, 'injected completed finish failure'); END;",
  );
  const close = createExecutionCloser(thirdExecution, "free-task");
  await close("completed", "2026-08-08T12:05:00.000Z"); // 真实结果,但这一次写不进去
  dbClient.executeMultiple("DROP TRIGGER IF EXISTS injected_completed_failure;");
  await close("failed", "2026-08-08T12:09:00.000Z"); // finally 的兜底:只准重试,不准改写
  const afterRetry = await api.request("/tasks/free-task/free-workflow").then((response) => response.json()) as {
    executions: Array<{ id: string; status: string; endedAt: string | null }>;
  };
  assert.deepEqual(
    afterRetry.executions.find((execution) => execution.id === thirdExecution),
    { id: thirdExecution, status: "completed", startedAt: "2026-08-08T12:00:00.000Z", endedAt: "2026-08-08T12:05:00.000Z" },
    "第一次落账失败后被兜底改写成了另一个终态 —— 一次成功的回合会永久记成失败",
  );

  // 打开/关闭预览不是工作流里的一步：状态只报「当下开没开」，不再攒开关历史。
  const previewShape = await api.request("/tasks/free-task/free-workflow")
    .then((response) => response.json()) as Record<string, unknown>;
  assert.equal("previewEvents" in previewShape, false, "自由工作流状态不应再暴露预览开关历史");
  assert.equal(
    typeof (previewShape.preview as { running?: unknown } | undefined)?.running,
    "boolean",
    "当下开没开仍要报，否则工具栏那颗按钮没法显示状态",
  );

  // 启动那一段（装依赖 6 分钟 + 等就绪 2 分钟）里，用户必须**从接口上就**关得掉预览。
  // 起预览是同步等到就绪才返回的，那把自由工作流锁会被 POST 一直握着；关闭如果也要这把
  // 锁，整个启动期只会拿到一句 409「当前已有自由工作流操作正在进行」——后端为取消做的那
  // 一整套（starting 记录 + 代号 + 杀装依赖的进程）就永远走不到，用户只能干等八分钟。
  {
    const runsDir = join(root, "runs", "free-task");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, "preview.json"), JSON.stringify({
      taskId: "free-task", cmd: "npm run dev", pid: 0, url: null, port: null, life: "task",
      startedAt: new Date().toISOString(), log: join(runsDir, "preview.log"), links: [],
      state: "starting", gen: "in-flight", installPid: null,
    }));
    writeFileSync(join(runsDir, "preview.log"), "$ npm run dev\n");
    // 刷新页面看到的也得是「有东西在跑、可以关掉」，而不是又一颗会撞锁的「打开预览」。
    const startingShape = await api.request("/tasks/free-task/free-workflow")
      .then((response) => response.json()) as { preview: { running: boolean; starting: boolean } };
    assert.equal(startingShape.preview.running, true, "正在启动也该算「在跑」，否则界面上没有任何一处给得出「关掉它」");
    assert.equal(startingShape.preview.starting, true, "得分得清「正在启动」和「已经起来了」：前者没有 url，还能被取消");

    assert.equal(tryAcquireFreeWorkflowAction("free-task"), true, "这一刻模拟的是 POST 还握着锁");
    const canceled = await api.request("/tasks/free-task/free-workflow/preview", { method: "DELETE" });
    releaseFreeWorkflowAction("free-task");
    assert.equal(canceled.status, 200, "启动请求还挂着的时候，关闭预览被锁挡回去了（用户点不到取消）");
    assert.deepEqual(await canceled.json(), { stopped: true }, "关闭应当真的把那条启动记录收掉");
    assert.equal(existsSync(join(runsDir, "preview.json")), false, "记录还在，说明只是嘴上说停了");
  }

  // 取消得从**路由的第一行**就管用。走到 startPreview 之前还有一长串 await：查任务、查
  // 项目、解析或新建工作区（第一次开预览要建 worktree，还可能在等同仓库的写锁）。代号
  // 如果等进了 startPreview 才注册，这一整段就是取消不掉的黑窗口 —— 用户点的取消什么也
  // 标不到，只收到一句「预览已经不在跑了」，然后这一趟照常建工作区、照常起服务、照常
  // 上线，而且此后没有任何一处会再去关它。
  //
  // 这里用真路由复现：仓库锁先被别人握着，POST 就定格在 prepareWorktree 上，取消落在这一段。
  {
    const marker = join(root, "preview-ran.txt");
    const script = join(root, "preview-server.mjs");
    writeFileSync(script, [
      'import { writeFileSync } from "node:fs";',
      'import http from "node:http";',
      `writeFileSync(${JSON.stringify(marker)}, "ran");`,
      'http.createServer((_q, res) => res.end("ok")).listen(Number(process.env.PORT));',
      "",
    ].join("\n"));
    await db.update(projects).set({ previewCommand: `node ${script}` }).where(eq(projects.id, "p-git"));
    await createTasks([{
      id: "pv-cancel-task", projectId: "p-git", groupId: null, parentId: null,
      title: "preview early cancel", body: "test", mode: "single", status: "done",
      labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
      executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
      duet: null, team: null, reportBack: false, scheduleId: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      useWorktree: true, worktreeBase: "main", originTaskId: null, workflowMode: "free",
    }]);

    let releaseRepo = () => {};
    let repoLocked = false;
    const repoHeld = withRepoLock(repo, () => new Promise<void>((resolve) => {
      repoLocked = true;
      releaseRepo = resolve;
    }));
    // 锁真的到手了再发 POST，否则它可能抢在前面自己拿到锁、根本不会停在工作区那一步。
    await waitFor(() => repoLocked, "仓库锁没拿到，这一段就不是「工作区准备中」了");
    const post = api.request("/tasks/pv-cancel-task/free-workflow/preview", { method: "POST" });
    // 界面在这一段就该看得到「正在启动、可以取消」——它读的正是这次登记下来的代号。
    await waitFor(async () => {
      const snapshot = await api.request("/tasks/pv-cancel-task/free-workflow")
        .then((response) => response.json()) as { preview: { starting: boolean } };
      return snapshot.preview.starting;
    }, "工作区还在准备时，快照里看不出「正在启动」——那一段就没有任何入口能取消");
    assert.equal(
      existsSync(join(root, "runs", "pv-cancel-task", "preview.json")), false,
      "这一刻盘上本来就还没有记录（正是老实现取消不掉的原因）",
    );

    const stop = await api.request("/tasks/pv-cancel-task/free-workflow/preview", { method: "DELETE" });
    assert.equal(stop.status, 200, "启动请求还卡在工作区准备时，关闭被挡回去了");
    assert.deepEqual(await stop.json(), { stopped: true }, "工作区还在准备时点的取消，接口却说没东西可停");

    // **取消要当场收口。** 打不断那次正卡在建 worktree 上的调用，可对外的那几句话不能跟着
    // 一起拖到它回来：仓库锁这时还握在别人手里，POST 一步都没动。
    {
      const stuck = await api.request("/tasks/pv-cancel-task/free-workflow")
        .then((response) => response.json()) as { preview: { running: boolean; starting: boolean } };
      assert.equal(stuck.preview.starting, false, "已经取消了，快照还说它正在启动（刷新后又变回「关闭预览」）");
      assert.equal(stuck.preview.running, false, "已经取消了，快照还说预览在跑");
      const again = await api.request("/tasks/pv-cancel-task/free-workflow/preview", { method: "DELETE" });
      assert.deepEqual(
        await again.json(), { stopped: false },
        "同一次启动被反复「停到」：每点一次就再记一条「预览启动已取消」",
      );
      // 那把自由工作流动作锁也得当场放掉，否则验收、派审要陪着这次作废的启动干等八分钟。
      assert.equal(
        tryAcquireFreeWorkflowAction("pv-cancel-task"), true,
        "取消之后动作锁还攥在那次启动手里，验收/派审全被 409 挡住",
      );
      releaseFreeWorkflowAction("pv-cancel-task");
    }

    releaseRepo();
    await repoHeld;
    const response = await post;
    assert.equal(response.status, 409, "取消之后这一趟还是把预览起起来了");
    assert.match(
      ((await response.json()) as { error: string }).error, /取消/,
      "起预览这一路失败了，却没说清是被取消的",
    );
    assert.equal(existsSync(marker), false, "取消之后预览命令还是跑起来了（没人再去关它）");
    assert.equal(
      existsSync(join(root, "runs", "pv-cancel-task", "preview.json")), false,
      "取消之后仍然写出了启动记录",
    );
    assert.equal(
      existsSync(join(root, "runs", "pv-cancel-task", "preview.log")), false,
      "取消之后仍然走进了 runPreview（日志头都写出来了）",
    );
  }

  // 「任务又开跑了」和「不许再起预览」必须是**同一道门**。收旧预览和把状态写成 running 是
  // 两步、中间隔着 await；起预览那一路只看库里那一行，在这条缝里读到的还是 done，于是一路
  // 放行——收预览那一下已经过去了，不会再来第二次。结果是任务正在改下一版代码，上一版的
  // 预览却在同一个工作区里跑着：用户对着旧页面验新改动，dev server 的产物还跟 agent 的写入
  // 撞在一起。
  {
    const rerunId = "rerun-race-task";
    const marker2 = join(root, "preview-ran.txt"); // 预览命令跑起来就会写它（见上一段那个脚本）
    await createTasks([{
      id: rerunId, projectId: "p-git", groupId: null, parentId: null,
      title: "preview rerun race", body: "test", mode: "single", status: "done",
      labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
      executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
      duet: null, team: null, reportBack: false, scheduleId: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      useWorktree: true, worktreeBase: "main", originTaskId: null, workflowMode: "free",
    }]);

    // ① 先钉住「POST 已经读过任务行（那时还是 done），随后任务开跑」这条时序：仓库锁把
    //    POST 定格在工作区准备上，中间跑完一次真实的 setTaskStatus(running)。
    let releaseRepo2 = () => {};
    let repoLocked2 = false;
    const repoHeld2 = withRepoLock(repo, () => new Promise<void>((resolve) => {
      repoLocked2 = true;
      releaseRepo2 = resolve;
    }));
    await waitFor(() => repoLocked2, "仓库锁没拿到");
    const racingPost = api.request(`/tasks/${rerunId}/free-workflow/preview`, { method: "POST" });
    await waitFor(async () => {
      const snapshot = await api.request(`/tasks/${rerunId}/free-workflow`)
        .then((response) => response.json()) as { preview: { starting: boolean } };
      return snapshot.preview.starting;
    }, "POST 还没走到工作区准备那一步");
    await setTaskStatus(rerunId, "running");
    releaseRepo2();
    await repoHeld2;
    const racing = await racingPost;
    assert.equal(racing.status, 409, "任务已经开跑了，那趟在途的启动还是把预览起了起来");
    assert.match(
      ((await racing.json()) as { error: string }).error, /取消/,
      "挡是挡住了，但不是因为「任务开跑收掉了这一趟」——别让别的错误替它交差",
    );
    assert.equal(
      existsSync(join(root, "runs", rerunId, "preview.json")), false,
      "任务开跑之后仍然留下了预览记录",
    );

    // ② 再钉住那条缝本身：旧预览已经收掉、状态还没落库时发起的新 POST 不能放行。
    //    用 FIFO 把回收里那次时间线写入卡住，窗口就成了确定的。
    const sessionId = "rerun-race-session";
    await db.insert(sessions).values({
      id: sessionId, taskId: rerunId, role: "lead", agentType: "codex",
      executor: "codex@test", startedAt: new Date().toISOString(),
    });
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, rerunId));
    const fifo = sessionTranscriptPath(rerunId, sessionId);
    mkdirSync(dirname(fifo), { recursive: true });
    rmSync(fifo, { force: true });
    execFileSync("mkfifo", [fifo]);
    const runsDir = join(root, "runs", rerunId);
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, "preview.json"), JSON.stringify({
      taskId: rerunId, cmd: "npm run dev", pid: 0, url: "http://localhost:1/", port: 1, life: "task",
      startedAt: new Date().toISOString(), log: join(runsDir, "preview.log"), links: [],
      state: "ready", gen: "old-gen", installPid: null,
    }));

    const flipping = setTaskStatus(rerunId, "running");
    // 记录已经被收掉、时间线那一笔还堵在 FIFO 上 —— 正是那条缝。
    await waitFor(() => !existsSync(join(runsDir, "preview.json")), "回收还没开始");
    const midway = (await db.select().from(tasks).where(eq(tasks.id, rerunId))).at(0);
    assert.equal(midway?.status, "done", "这一刻库里本来就还是旧状态（正是这条缝的成因）");

    // **同一条缝里，终局动作也不能放行。** 重跑取消在途预览时会顺手把动作锁放掉（那是对的，
    // 否则验收/派审要陪一次作废的启动干等八分钟），可这一刻库里还写着 done —— 空出来的锁加
    // 一行过期的状态，正好够验收挤进来，把一个下一秒就要开跑的任务点成 accepted。
    //
    // 这两发要**在窗口里当场跑完再收结果**：放到放开 FIFO 之后去 await，退化的那一路会读到
    // 已经落库的 running，被别的挡板顺手拦下，这条断言就永远报不出真问题（实测：退化版给出
    // 的是 task_in_flight）。也必须排在下面那发预览 POST **之前** —— 没有这道门的话，那发
    // POST 自己就把动作锁攥走了，验收会因为「已有操作正在进行」被拦下，同样是假通过。
    // 先把会话删掉，这两发各自那笔时间线就不会再堵在同一条 FIFO 上；回收那一笔早就把流开
    // 着卡在那儿了，窗口不受影响。
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    const midAccept = await acceptTask(rerunId).then(
      (result) => result,
      (err: unknown) => ({ accepted: false as const, reason: `threw: ${String(err)}` }),
    );
    assert.equal(midAccept.accepted, false, "任务正在切进 running，验收却成功了（accepted + running 就是这么来的）");
    if (!midAccept.accepted) {
      assert.equal(
        midAccept.reason, "free_workflow_action_in_progress",
        "验收是被挡住了，但不是因为这个任务正在开跑 —— 别让别的理由替它交差",
      );
    }
    const midReview = await api.request(`/tasks/${rerunId}/free-workflow/review`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewerId: reviewer.id, checkMode: "logic", retryLimit: 1 }),
    });
    assert.equal(midReview.status, 409, "任务正在切进 running，派审却放行了");

    // 这一发不 await：挡不住的话它会一路起到底，而那时它自己的时间线也要写进同一条 FIFO。
    const midPosting = api.request(`/tasks/${rerunId}/free-workflow/preview`, { method: "POST" });
    // 先守住 FIFO 再收结果：回收那一笔写完、状态落库，退化的那一路也走得完 —— 断言才有得报。
    drainFifo(fifo);
    await flipping;
    const midPost = await midPosting;
    assert.equal(midPost.status, 409, "任务正在切进 running，这一刻还能把预览起起来");
    assert.match(
      ((await midPost.json()) as { error: string }).error, /任务正在修改代码/,
      "挡是挡住了，但没说清是因为任务正在改代码",
    );
    stopDrainingFifo?.();
    const after = (await db.select().from(tasks).where(eq(tasks.id, rerunId))).at(0);
    assert.equal(after?.status, "running", "状态最终没落成 running");
    assert.notEqual(after?.stage, "accepted", "任务被点成了已验收，可它下一秒就开跑了（界面锁死操作，执行器还在改它）");
    assert.equal(
      existsSync(join(root, "runs", rerunId, "preview.json")), false,
      "那条缝里发起的预览最终还是起来了",
    );
    assert.equal(existsSync(marker2), false, "那条缝里发起的预览把命令跑起来了");
  }

  // 「起来了」不等于「还是你的」：`startPreview` 返回成功之后，路由还要写一笔时间线才应答，
  // 重跑回收完全可能落在这条缝里 —— 进程被杀、记录被删、任务已经 running，而这一趟手里攥
  // 着的还是那份旧 record。就那么回 200，前端拿 200 就通知「预览已打开」并 window.open，
  // 用户被弹到一个已经被收掉的地址上，比直接说没起来还糟。
  {
    const tailId = "tail-race-task";
    await createTasks([{
      id: tailId, projectId: "p-git", groupId: null, parentId: null,
      title: "preview tail race", body: "test", mode: "single", status: "done",
      labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
      executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
      duet: null, team: null, reportBack: false, scheduleId: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      useWorktree: false, worktreeBase: null, originTaskId: null, workflowMode: "free",
    }]);
    const tailSession = "tail-race-session";
    await db.insert(sessions).values({
      id: tailSession, taskId: tailId, role: "lead", agentType: "codex",
      executor: "codex@test", startedAt: new Date().toISOString(),
    });
    // 时间线那一笔写进 FIFO，这一趟就定格在成功尾段上 —— 窗口是确定的，不靠抢时序。
    const tailFifo = sessionTranscriptPath(tailId, tailSession);
    mkdirSync(dirname(tailFifo), { recursive: true });
    rmSync(tailFifo, { force: true });
    execFileSync("mkfifo", [tailFifo]);

    const tailRecord = join(root, "runs", tailId, "preview.json");
    const tailPosting = api.request(`/tasks/${tailId}/free-workflow/preview`, { method: "POST" });
    await waitFor(() => {
      if (!existsSync(tailRecord)) return false;
      return (JSON.parse(readFileSync(tailRecord, "utf8")) as { state: string }).state === "ready";
    }, "预览没能起来，这一段就不是「已就绪、只差应答」了", 90_000);
    const readyRecord = JSON.parse(readFileSync(tailRecord, "utf8")) as { pid: number };
    assert.ok(readyRecord.pid > 0, "就绪记录里没有进程号，后面没法验证进程有没有被收掉");

    // 会话删掉，重跑自己那笔回收时间线就不会跟着堵在同一条 FIFO 上（堵住的只剩这一趟）。
    await db.delete(sessions).where(eq(sessions.id, tailSession));
    await setTaskStatus(tailId, "running");
    assert.equal(existsSync(tailRecord), false, "重跑没把已就绪的预览记录收掉");

    drainFifo(tailFifo);
    const tailPost = await tailPosting;
    assert.notEqual(tailPost.status, 200, "预览已经被重跑收掉了，这一趟还是回了 200（前端照着它 window.open 一个死地址）");
    assert.equal(tailPost.status, 409);
    assert.match(
      ((await tailPost.json()) as { error: string }).error, /取消/,
      "挡是挡住了，但没说清这一趟的成果是被人收走了",
    );
    stopDrainingFifo?.();
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    await waitFor(() => !alive(readyRecord.pid), "预览进程还活着：记录没了、任务在跑，端口却还占着");
    const tailTask = (await db.select().from(tasks).where(eq(tasks.id, tailId))).at(0);
    assert.equal(tailTask?.status, "running", "状态最终没落成 running");
  }

  // 同一条尾巴上，**用户自己点的关闭**也得当场收干净。预览起来了、路由还在写那笔时间线，
  // 这一刻的关闭在盘上完全生效（进程杀掉、记录删掉、刷新后也确实没预览），可代号如果已经
  // 被内层交接时撤掉，挂在它上面的「提前放动作锁」就再也不会响：用户看到的是关闭成功，
  // 验收/派审却还被一个已经作废的请求的锁挡着，直到它自己从时间线那一步醒过来 —— 那一步
  // 是真的文件 I/O，磁盘或挂载出问题时可以拖到没边。
  {
    const cancelId = "tail-cancel-task";
    await createTasks([{
      id: cancelId, projectId: "p-git", groupId: null, parentId: null,
      title: "preview tail cancel", body: "test", mode: "single", status: "done",
      labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
      executorId: "reviewer-executor", model: null, reasoningEffort: null, autoTitle: false,
      duet: null, team: null, reportBack: false, scheduleId: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      useWorktree: false, worktreeBase: null, originTaskId: null, workflowMode: "free",
    }]);
    const cancelSession = "tail-cancel-session";
    await db.insert(sessions).values({
      id: cancelSession, taskId: cancelId, role: "lead", agentType: "codex",
      executor: "codex@test", startedAt: new Date().toISOString(),
    });
    const cancelFifo = sessionTranscriptPath(cancelId, cancelSession);
    mkdirSync(dirname(cancelFifo), { recursive: true });
    rmSync(cancelFifo, { force: true });
    execFileSync("mkfifo", [cancelFifo]);

    const cancelRecord = join(root, "runs", cancelId, "preview.json");
    const cancelPosting = api.request(`/tasks/${cancelId}/free-workflow/preview`, { method: "POST" });
    await waitFor(() => {
      if (!existsSync(cancelRecord)) return false;
      return (JSON.parse(readFileSync(cancelRecord, "utf8")) as { state: string }).state === "ready";
    }, "预览没能起来，这一段就不是「已就绪、只差应答」了", 90_000);
    const cancelPid = (JSON.parse(readFileSync(cancelRecord, "utf8")) as { pid: number }).pid;
    assert.ok(cancelPid > 0, "就绪记录里没有进程号，后面没法验证进程有没有被收掉");

    // 会话删掉，关闭自己那笔时间线就不会跟着堵在同一条 FIFO 上（堵住的只剩这一趟 POST）。
    await db.delete(sessions).where(eq(sessions.id, cancelSession));
    const closed = await api.request(`/tasks/${cancelId}/free-workflow/preview`, { method: "DELETE" });
    assert.equal(closed.status, 200, "预览已经起来了，关闭却被挡回去了");
    assert.deepEqual(await closed.json(), { stopped: true }, "关闭没真的把它收掉");
    const closedShape = await api.request(`/tasks/${cancelId}/free-workflow`)
      .then((response) => response.json()) as { preview: { running: boolean; starting: boolean } };
    assert.equal(closedShape.preview.running, false, "关掉了，快照还说预览在跑");
    assert.equal(closedShape.preview.starting, false, "关掉了，快照还说它正在启动");
    const closedAgain = await api.request(`/tasks/${cancelId}/free-workflow/preview`, { method: "DELETE" });
    assert.deepEqual(await closedAgain.json(), { stopped: false }, "同一次预览被反复「停到」");
    // 这条是本段的要害：关闭**当场**就得把动作锁放掉，不能让验收/派审陪那个已经作废的
    // 请求等到它写完时间线。
    assert.equal(
      tryAcquireFreeWorkflowAction(cancelId), true,
      "关闭已经生效、快照也说没在跑，动作锁却还攥在那次作废的启动手里（验收/派审全被 409 挡住）",
    );
    releaseFreeWorkflowAction(cancelId);

    drainFifo(cancelFifo);
    const cancelPost = await cancelPosting;
    assert.equal(cancelPost.status, 409, "关掉之后这一趟还是宣告「预览已打开」");
    assert.match(
      ((await cancelPost.json()) as { error: string }).error, /取消/,
      "挡是挡住了，但没说清这一趟是被关掉的",
    );
    stopDrainingFifo?.();
    const stillAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    await waitFor(() => !stillAlive(cancelPid), "关掉之后预览进程还活着，端口还占着");
  }

  const review = await api.request("/tasks/free-task/free-workflow/review", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ reviewerId: reviewer.id, checkMode: "logic", retryLimit: 1 }),
  });
  assert.equal(review.status, 409, "未运行的自由任务不能派审");

  const stage = await api.request("/tasks/free-task/stage", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ stage: "awaiting_acceptance" }),
  });
  assert.equal(stage.status, 409, "自由任务不能写入旧起手式 stage");

  const accepted = await acceptTask("free-task");
  assert.equal(accepted.accepted, false);
  if (!accepted.accepted) assert.equal(accepted.reason, "free_workflow_not_ready_for_acceptance");

  const derived = await api.request("/tasks", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "p", title: "derived", parentId: "free-task", workflowMode: "free" }),
  });
  assert.equal(derived.status, 409, "自由工作流不能用于派生任务");
  const mixed = await api.request("/tasks", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "p", title: "mixed", workflowMode: "free", workflowId: "standard" }),
  });
  assert.equal(mixed.status, 400, "自由工作流不能夹带起手式引用");

  const removedMerge = await api.request("/tasks/free-accept-task/free-workflow/merge", { method: "POST" });
  assert.equal(removedMerge.status, 404, "自由工作流专属合并接口应删除");
  const freeAccepted = await acceptTask("free-accept-task");
  assert.equal(freeAccepted.accepted, true, "已完成的自由任务应走统一验收路径");
  let acceptedTask = (await db.select().from(tasks).where(eq(tasks.id, "free-accept-task"))).at(0);
  assert.equal(acceptedTask?.stage, "accepted", "统一验收成功后应把自由任务标为已验收");
  const acceptedAgain = await acceptTask("free-accept-task");
  assert.equal(acceptedAgain.accepted, true, "自由任务重复验收应沿用统一幂等语义");
  acceptedTask = (await db.select().from(tasks).where(eq(tasks.id, "free-accept-task"))).at(0);
  assert.equal(acceptedTask?.stage, "accepted");
  assert.equal(tryAcquireFreeWorkflowAction("free-worktree-task"), true);
  try {
    const lockedAcceptance = await acceptTask("free-worktree-task");
    assert.equal(lockedAcceptance.accepted, false, "其它自由操作持锁时不得开始验收");
    if (!lockedAcceptance.accepted) assert.equal(lockedAcceptance.reason, "free_workflow_action_in_progress");
    const lockedReview = await api.request("/tasks/free-worktree-task/free-workflow/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewerId: reviewer.id, checkMode: "logic", retryLimit: 1 }),
    });
    assert.equal(lockedReview.status, 409, "统一验收与派审必须共用同一把自由操作锁");
    assert.equal(git(repo, "rev-parse", "main"), mainBeforeAcceptance, "自由操作互斥时不得推进目标分支");
    assert.equal(existsSync(worktree.path), true, "自由操作互斥时不得清理任务 worktree");
  } finally {
    releaseFreeWorkflowAction("free-worktree-task");
  }
  const blockingReviewAt = new Date().toISOString();
  await db.insert(freeReviewRuns).values({
    id: "blocking-review", taskId: "free-worktree-task", reviewerId: reviewer.id, reviewerName: "Codex logic",
    agentType: "codex", executorId: "reviewer-executor", model: "gpt-review", reasoningEffort: "high",
    checkMode: "logic", retryLimit: 1, currentRound: 1, status: "reviewing",
    createdAt: blockingReviewAt, updatedAt: blockingReviewAt, finishedAt: null,
  });
  let reviewBlocked = await acceptTask("free-worktree-task");
  assert.equal(reviewBlocked.accepted, false, "自由审查进行中不得验收");
  if (!reviewBlocked.accepted) assert.equal(reviewBlocked.reason, "free_review_in_progress");
  assert.equal(git(repo, "rev-parse", "main"), mainBeforeAcceptance, "审查中不得推进目标分支");
  assert.equal(existsSync(worktree.path), true, "审查中不得清理任务 worktree");
  // 修复进行中的保护由「任务本身 running」承担（结算后 run 不再有修复态可挡）。
  await db.update(freeReviewRuns).set({ status: "stopped", updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString() })
    .where(eq(freeReviewRuns.id, "blocking-review"));
  await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, "free-worktree-task"));
  reviewBlocked = await acceptTask("free-worktree-task");
  assert.equal(reviewBlocked.accepted, false, "任务运行中（修复中）不得验收");
  if (!reviewBlocked.accepted) assert.equal(reviewBlocked.reason, "free_workflow_not_ready_for_acceptance");
  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, "free-worktree-task"));
  // stopped（审查未通过后停住）不再挡验收：验收是用户主权，警示由验收页展示。
  const worktreeAccepted = await acceptTask("free-worktree-task");
  assert.equal(worktreeAccepted.accepted, true, "自由任务的独立 worktree 应复用统一安全合并与清理");
  assert.notEqual(git(repo, "rev-parse", "main"), mainBeforeAcceptance, "统一验收应推进目标分支");
  assert.equal(existsSync(worktree.path), false, "统一验收应清理自由任务 worktree");
  assert.equal(git(repo, "branch", "--list", "ash/free-worktree-task"), "", "统一验收应删除已合并任务分支");
  const acceptedRow = (await db.select().from(tasks).where(eq(tasks.id, "free-worktree-task"))).at(0);
  assert.equal(acceptedRow?.acceptedTargetBranch, "main", "验收应结构化记录目标分支");
  assert.equal(acceptedRow?.acceptedBaseCommit, mainBeforeAcceptance, "验收应记录合并前目标 commit");
  assert.equal(acceptedRow?.acceptedMergeCommit, git(repo, "rev-parse", "main"), "验收应记录合并后目标 commit");

  const reviewAt = new Date().toISOString();
  await db.insert(freeReviewRuns).values({
    id: "active-review", taskId: "free-task", reviewerId: reviewer.id, reviewerName: "Codex logic",
    agentType: "codex", executorId: "reviewer-executor", model: "gpt-review", reasoningEffort: "high",
    checkMode: "logic", retryLimit: 1, currentRound: 1, status: "reviewing",
    createdAt: reviewAt, updatedAt: reviewAt, finishedAt: null,
  });
  await db.insert(freeReviewRounds).values({
    id: "active-review-round-1", runId: "active-review", round: 1, status: "reviewing",
    conclusion: null, startedAt: reviewAt, endedAt: null,
  });
  assert.deepEqual(await freeReviewResumeOptions("free-task"), {
    agent: "codex", executorId: "reviewer-executor", model: "gpt-review", reasoningEffort: "high", sessionRole: "reviewer",
  });

  const evidence = join(root, "runs", "free-task", "free-review", "active-review", "round-1");
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, "report.md"), "# 审查报告\n\n内容可读。\n");
  writeFileSync(join(evidence, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const reportFile = await api.request("/tasks/free-task/free-workflow/review-file?run=active-review&round=1&name=report.md");
  assert.equal(reportFile.status, 200);
  assert.match(reportFile.headers.get("content-type") ?? "", /^text\/markdown; charset=utf-8/i);
  assert.equal(await reportFile.text(), "# 审查报告\n\n内容可读。\n");
  const screenshotFile = await api.request("/tasks/free-task/free-workflow/review-file?run=active-review&round=1&name=shot.png");
  assert.equal(screenshotFile.status, 200);
  assert.equal(screenshotFile.headers.get("content-type"), "image/png");

  console.log("✓ 自由任务不携带起手式快照");
  console.log("✓ 默认 1 次自动复审的轮数语义正确");
  console.log("✓ 修复只代发消息不翻状态；预约槽统一承载用户预约与自动续轮");
  console.log("✓ 审查者 CRUD 与自由工作流初始状态可用");
  console.log("✓ 运行中可预约、覆盖、取消，失败保留且 confirmed done 后只自动派出一次");
  console.log("✓ 派审附言会校验、持久化并进入即时与预约审查提示");
  console.log("✓ 删除审查者会取消预约；脏 armed 状态读路径与结算路径均不会静默失效");
  console.log("✓ 预览只报当下开没开，不进实际工作流记录");
  console.log("✓ 每次自由任务执行都独立保留起止时间与状态");
  console.log("✓ backlog 与旧 stage 路径仍被隔离，完成后可统一验收");
  console.log("✓ 派生任务与起手式引用不能混入自由工作流");
  console.log("✓ 自由合并接口已删除，共享操作锁、活跃审查门禁、统一验收与 worktree 清理可用");
  console.log("✓ 审查续跑保持独立 reviewer 会话与原模型配置");
  console.log("✓ 技能名与斜杠命令只进入需求参考文件，不进入自由审查 prompt");
  console.log("✓ 自由审查报告与截图接口返回正确内容类型");
} catch (error) {
  console.error(error);
  failure = error;
} finally {
  stopDrainingFifo?.();
  killLeftoverPreviews(join(root, "runs"));
  // 删舞台前先松开库文件,否则 Windows 上必然 EBUSY(理由见 tmp-db.ts 的 releaseTmpDb)。
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
  // 断言炸在窗口里的时候，还有写者堵在 FIFO 的 `open()` 上 —— 那是 libuv 线程池里的一根
  // 线程，**连 process.exit 都回不来**（实测：结论早就打印出来了，进程再也不退，看起来
  // 跟测试挂死一模一样）。结论已经在屏幕上了，剩下的只有退场，所以直接自杀。
  if (failure) process.kill(process.pid, "SIGKILL");
}
