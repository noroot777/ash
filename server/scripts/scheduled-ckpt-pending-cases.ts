// 「checkpoint 追问经待发送路径投递」与「手动起跑占位写入失败」两组用例
// (第 ll7XKsu_ps0n 链第 1 轮两条拦验收)。从 gate-cases 独立成文件:那份也顶近 700 行。
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { HandoffCaseContext } from "./scheduled-handoff-cases.js";

export async function runCkptPendingCases(ctx: HandoffCaseContext): Promise<void> {
  const { at, root, leadLog, waitFor, countIn, taskRow, messageRow } = ctx;
  const [{ db }, schema, pending, runs, runRoutes, { Hono }] = await Promise.all([
    import("../src/db/index.js"),
    import("../src/db/schema.js"),
    import("../src/pending-messages.js"),
    import("../src/runs.js"),
    import("../src/task-run-routes.js"),
    import("hono"),
  ]);
  const { queueItems, scheduledMessages, sessions, tasks } = schema;
  const api = new Hono();
  runRoutes.mountTaskRunRoutes(api);
  const taskStatusOf = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!.status;
  const stopWhenLive = async (id: string) => {
    await waitFor(() => runs.isRunning(id), `${id} 的执行进程没有拉起`);
    assert.equal(runs.stopTask(id), true, `测试前提:${id} 的活进程应能被停掉`);
    await waitFor(async () => {
      const s = await taskStatusOf(id);
      return s !== "running" && s !== "queued";
    }, `${id} 停止后没有结算`);
  };

  // ── 待发送路径的 checkpoint 追问:定时发送 + 连续追问(第 1 轮拦验收 1)──────────
  // 组暂停隔离队列自身的自动续跑(审查同款 fixture):[uB(paused+resumePrompt 队首),
  // uC(backlog)]。两翼都是 execution=0 的普通追问,经 scanPendingMessages 投递:修复
  // 前扫描按 paused 认领占位,把 paused 翻成 queued,追问被当执行回合 —— 消费继续
  // 指令、结算 failed;修复后与直接回复同判据旁路直投,保状态保指令。
  const uB = "scheduled-single-ckpt-ub";
  const uC = "scheduled-single-ckpt-uc";
  const uGroup = "scheduled-ckpt-group-u";
  const uPrompt = "检查点:下一轮必须继续完成尚未执行的步骤(ckpt-pending)";
  const uBRow = { ...taskRow(uB, "claude", "paused"), mode: "single", team: null, groupId: uGroup, resumePrompt: uPrompt };
  await db.insert(schema.groups).values({
    id: uGroup, projectId: uBRow.projectId as string, name: "ckpt-pending", mode: "serial", paused: true, createdAt: at,
  });
  await db.insert(tasks).values([
    uBRow,
    { ...taskRow(uC, "claude", "idle"), mode: "single", team: null, groupId: uGroup, status: "backlog", body: "保持运行等待引导" },
  ]);
  await db.insert(sessions).values({
    id: "scheduled-ckpt-ub-prev", taskId: uB, role: "single", agentType: "claude",
    executor: "claude@test", cwd: root, cliSessionId: "scheduled-ckpt-ub-cli", startedAt: at,
  });
  await db.insert(queueItems).values([
    { queueId: "scheduled-ckpt-queue-u", taskId: uB, position: 0, createdAt: at },
    { queueId: "scheduled-ckpt-queue-u", taskId: uC, position: 1, createdAt: at },
  ]);
  const uBRowNow = async () => (await db.select().from(tasks).where(eq(tasks.id, uB))).at(0)!;
  const assertCheckpointSurvived = async (needle: string, label: string) => {
    await waitFor(() => countIn(leadLog, needle) > 0, `${label}:追问原文没有进会话`);
    await waitFor(async () => (await taskStatusOf(uB)) === "paused", `${label}:追问结束后必须恢复 paused,而不是 failed`);
    const row = await uBRowNow();
    assert.equal(row.resumePrompt, uPrompt, `${label}:普通追问不得吞掉继续指令`);
    assert.equal(await taskStatusOf(uC), "backlog", `${label}:后项不得被放行`);
  };
  // 翼一:定时追问(timed 消息到点,走真实扫描)。
  const uTimed = "现在进度怎么样？(ckpt-pending-timed)";
  await db.insert(scheduledMessages).values(messageRow("scheduled-ckpt-msg-timed", uB, uTimed, "timed"));
  await pending.deliverPendingMessages(uB);
  await assertCheckpointSurvived("ckpt-pending-timed", "定时追问");
  const timedRow = (await db.select().from(scheduledMessages)
    .where(eq(scheduledMessages.id, "scheduled-ckpt-msg-timed"))).at(0)!;
  assert.equal(timedRow.status, "sent", "定时追问应已送达");
  // 翼二:连续追问(第一句还在回答时自动排队的第二句 = queued 非执行消息)。
  // 同任务投递有 5s 冷却(pending-messages 的 FIRE_COOLDOWN),先等它过期。
  const uQueued = "再问一句进展？(ckpt-pending-queued)";
  await db.insert(scheduledMessages).values(messageRow("scheduled-ckpt-msg-queued", uB, uQueued, "queued"));
  await new Promise((resolve) => setTimeout(resolve, 5_200));
  await pending.deliverPendingMessages(uB);
  await assertCheckpointSurvived("ckpt-pending-queued", "连续追问");
  console.log("✓ 待发送路径的 checkpoint 追问:定时与连续两翼都保暂停保指令,后项不放行");

  // ── 手动起跑撞占位写入失败:回合锁不泄漏,恢复后自动续上(第 1 轮拦验收 2)─────────
  // [vA(backlog, 单成员队列)]:外部连接持写锁耗尽 busy timeout,POST /run —— 修复前
  // claimQueueSeat 的 setTaskStatus 异常直接外抛,路由 500、claimTurn 的锁没人释放,
  // 此后一律 409「回合正在进行」;修复后按认领失败收口(409 + 锁释放),可能的 queued
  // 遗留由守卫补偿按持久结果收拾,数据库恢复后自动重推续上。
  const vA = "scheduled-single-ckpt-va";
  await db.insert(tasks).values([
    { ...taskRow(vA, "claude", "idle"), mode: "single", team: null, status: "backlog", body: "保持运行等待引导" },
  ]);
  await db.insert(queueItems).values([
    { queueId: "scheduled-ckpt-queue-v", taskId: vA, position: 0, createdAt: at },
  ]);
  const { DatabaseSync } = await import("node:sqlite");
  const ext = new DatabaseSync(process.env.ASH_DB!);
  ext.exec("BEGIN IMMEDIATE");
  const runRes = await api.request(`/tasks/${vA}/run`, { method: "POST" });
  assert.equal(runRes.status, 409, `占位写入失败应按认领失败返回 409,实际 ${runRes.status}`);
  assert.equal(runs.isTurnClaimed(vA), false, "失败后手动起跑的回合锁必须释放(修复前永久 409)");
  ext.exec("ROLLBACK");
  ext.close();
  // 守卫补偿的延迟重推把这次启动续上(用户点过运行,交接不该蒸发)。
  await waitFor(async () => (await taskStatusOf(vA)) === "running", "数据库恢复后启动没有自动续上");
  await stopWhenLive(vA);
  console.log("✓ 手动起跑撞写入失败:409 + 回合锁释放,恢复可写后自动续上");
}
