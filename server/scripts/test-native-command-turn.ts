// `/compact` 这类 CLI 原生命令回合的边界:它**只是让 CLI 把上下文压一压**,没有模型
// 输出、没有产出、也没有结论。所以任何「这一轮跑完了」的记账都不该由它触发。
//
// 两条都是第 1 轮审查抓出来的真实回归:
//   ① CLI 还没起来就抛错(执行器解析失败、worktree 建不出来…)时走的是 continueTask
//      的 catch,而清 nativeTurn / 跳过结算钩子原先只写在 single-run.ts 的正常路径上
//      —— 于是一次压缩把正在跑的那轮就地验证收掉了(verifyRound 清空、verifyRounds
//      +1,却给不出 verified/verify_failed),标记还漏给下一轮。
//   ② markFreeReviewReworking() 排在原生命令归类之前,`/compact` 会把一次「耗尽」的
//      审查运行翻回 reworking 并清掉 finishedAt —— 任务明明还是 done + 审查未通过,
//      自由工作流那栏却声称正在返工。
//
// 跑法:
//   npx tsx server/scripts/test-native-command-turn.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "harness-native-turn-"));
process.env.HARNESS_DB = join(root, "harness.db");
process.env.HARNESS_RUNS_DIR = join(root, "runs");

try {
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { agents, freeReviewRuns, projects, tasks } = await import("../src/db/schema.js");
  const { continueTask } = await import("../src/orchestrator.js");
  const { eq } = await import("drizzle-orm");
  await ensureSchema();

  const at = "2026-08-12T00:00:00.000Z";
  await db.insert(projects).values({ id: "project", name: "native-turn", repoPath: root, createdAt: at });
  // 这个 profile 一定解析不出执行器(模型不支持这个智能水平)——「CLI 还没起来就抛错」
  // 的最短现场,而且抛在 resolveExecutorFor 里,跟真实故障是同一条路径。
  await db.insert(agents).values({
    id: "claude-broken",
    name: "claude@broken",
    type: "claude",
    target: JSON.stringify({ kind: "local" }),
    extraArgs: "[]",
    model: "claude-opus-5",
    reasoningEffort: "根本没有这一档",
    configOverrides: "{}",
    isDefault: true,
  });
  await db.insert(tasks).values({
    id: "task",
    projectId: "project",
    title: "被验中的任务",
    body: "做点什么",
    mode: "single",
    status: "done",
    // 一轮就地验证正在进行 —— 压缩绝不能替它收口。
    verifyRound: 2,
    verifyRounds: 1,
    labels: "[]",
    dependsOn: "[]",
    resumeDependsOn: "[]",
    agentType: "claude",
    executorId: "claude-broken",
    autoTitle: false,
    createdAt: at,
    updatedAt: at,
  });
  // 审查已经耗尽重试停在那儿(报告已出、finishedAt 已落)。
  await db.insert(freeReviewRuns).values({
    id: "run-1",
    taskId: "task",
    reviewerName: "claude@reviewer",
    agentType: "claude",
    checkMode: "logic",
    retryLimit: 1,
    currentRound: 2,
    status: "exhausted",
    createdAt: at,
    updatedAt: at,
    finishedAt: at,
  });

  const took = await continueTask("task", "/compact");
  assert.equal(took, true, "这一回合确实由本次调用接管了(错误落在时间线上,不是「没送出去」)");

  const row = (await db.select().from(tasks).where(eq(tasks.id, "task"))).at(0)!;
  assert.equal(row.status, "done", "续聊回合出岔子不该把任务状态打差");
  assert.equal(row.nativeTurn, false, "标记只在本回合内有效,漏给下一轮会让真实结算被整段跳过");
  assert.equal(row.followUpFrom, null, "续聊标记同样得清掉");
  assert.equal(row.verifyRound, 2, "那轮就地验证还在跑,压缩不许替它收口");
  assert.equal(row.verifyRounds, 1, "更不许凭空记一轮验证账");

  const run = (await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.id, "run-1"))).at(0)!;
  assert.equal(run.status, "exhausted", "压缩不是返工:一个字都没改,审查结论不该被翻回 reworking");
  assert.equal(run.finishedAt, at, "finishedAt 也不该被清掉");

  // ── ③ 自由工作流时间线上不许多出一条凭空的「任务执行」(第 2 轮审查 finding 7)──────
  // 上面两条走的是「CLI 还没起来就抛错」那条路。CLI 真起来了的话,记账在 consumeSingleRun
  // 开头:它照旧会开一条 task_execution 事件,那一轮明明只是让 CLI 把上下文压一压,时间线
  // 上却多出一条「任务执行 · 已完成」—— 用户按它去找改了什么,什么都找不到。
  const { sessions, freeWorkflowEvents } = await import("../src/db/schema.js");
  const { consumeSingleRun } = await import("../src/single-run.js");
  const { createWriteStream } = await import("node:fs");

  const runTurn = async (taskId: string, nativeTurn: boolean) => {
    await db.insert(tasks).values({
      id: taskId, projectId: "project", title: taskId, body: "做点什么",
      mode: "single", status: "running", workflowMode: "free", nativeTurn,
      labels: "[]", dependsOn: "[]", resumeDependsOn: "[]",
      agentType: "claude", autoTitle: false, createdAt: at, updatedAt: at,
    });
    await db.insert(sessions).values({
      id: `${taskId}-sess`, taskId, role: "single", agentType: "claude",
      executor: "claude", target: "local", cwd: root, startedAt: at,
    });
    const out = createWriteStream(join(root, `${taskId}.md`));
    await consumeSingleRun({
      taskId,
      sessId: `${taskId}-sess`,
      agentType: "claude",
      // consumeSingleRun 只从执行器上读这三样,没必要为了记账测试真起一个 CLI。
      ex: { model: null, reasoningEffort: null, resumeCommand: () => "" } as unknown as Parameters<typeof consumeSingleRun>[0]["ex"],
      cwd: root,
      handle: {
        sessionId: `${taskId}-sess`,
        commandLine: "fake",
        events: (async function* () { yield { kind: "done", exitStatus: 0 } as const; })(),
        kill: () => {},
      },
      out,
      turnStart: at,
      cliSessionId: "cli-1",
      autoTitle: false,
    });
    // .md 是异步开的:不等它落完就 rmSync 掉临时目录,进程会死在一个 ENOENT 上
    // (断言全过了、退出码却非 0)。
    if (!out.closed) await new Promise((resolve) => out.once("close", resolve));
    return (await db.select().from(freeWorkflowEvents).where(eq(freeWorkflowEvents.taskId, taskId)))
      .filter((event) => event.kind === "task_execution");
  };

  assert.equal((await runTurn("native-free-task", true)).length, 0, "原生命令回合不该在自由工作流时间线上留下「任务执行」");
  // 对照组:同样是自由工作流任务、同样一轮跑完,只是这次不是原生命令 —— 必须照记,
  // 否则上面那条断言用「记账整个坏掉了」也能过。
  assert.equal((await runTurn("normal-free-task", false)).length, 1, "普通回合照旧要记一条任务执行");

  console.log("test:native-turn ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
