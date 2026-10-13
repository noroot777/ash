// 「checkpoint 追问经待发送路径投递」「手动起跑占位写入失败」「/fire 失败后不许偷换成
// 续聊」三组用例(第 ll7XKsu_ps0n 链第 1、2 轮拦验收)。从 gate-cases 独立成文件:
// 那份也顶近 700 行。
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

  // ── 手动起跑撞占位写入失败:回合锁不泄漏,也不许替用户换一种方式重试(第 1/2 轮)──
  // [vA(backlog, 单成员队列)]:外部连接持写锁耗尽 busy timeout,POST /run —— 第 1 轮
  // 修复前 claimQueueSeat 的 setTaskStatus 异常直接外抛,路由 500、claimTurn 的锁没人
  // 释放,此后一律 409「回合正在进行」。第 2 轮审查又指出:第 1 轮装的 renote 补偿会
  // 经 advanceQueue 的 resumeOrRunTask 自动续跑 —— 对 /fire 这就是把「全新一轮」偷换
  // 成续聊旧会话。现在的语义:409(话术如实说是写入失败)+ 锁释放 + **不自动重试**,
  // 遗留回收 repush:"never";用户按原入口重点一次就是干净的重试。
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
  const runBody = await runRes.json() as { error?: string };
  assert.match(runBody.error ?? "", /队列占位写入失败/, "写入失败的 409 必须说真话,不得谎报「同队有人在跑」");
  assert.equal(runs.isTurnClaimed(vA), false, "失败后手动起跑的回合锁必须释放(修复前永久 409)");
  ext.exec("ROLLBACK");
  ext.close();
  // 第 1 轮的 renote 补偿会在 ~2s 内自动把任务拉起来;等足窗口确认它不再发生。
  await new Promise((resolve) => setTimeout(resolve, 3_500));
  assert.equal(await taskStatusOf(vA), "backlog", "占位写失败后任务应留在原状态等用户重试,而不是被补偿自动启动");
  assert.equal(runs.isRunning(vA), false, "不许有进程被补偿自动拉起");
  // 用户按原入口重试:干净的 202 + 真实起跑。
  const retryRes = await api.request(`/tasks/${vA}/run`, { method: "POST" });
  assert.equal(retryRes.status, 202, `数据库恢复后手动重试应 202,实际 ${retryRes.status}`);
  await stopWhenLive(vA);
  console.log("✓ 手动起跑撞写入失败:409 如实报写入失败 + 回合锁释放,不自动重试,手动重试干净起跑");

  // ── /fire 撞占位写入失败:全新一轮的语义不得被补偿偷换成续聊(第 2 轮拦验收)────────
  // [wA(paused + resumePrompt + 旧会话, 单成员队列)]:/fire 的契约是永远 fresh、绝不
  // resume。第 2 轮审查实测:第 1 轮的 renote 补偿在 409 后经 advanceQueue 自动
  // resumeOrRunTask —— 执行器收到的是旧检查点指令、resumePrompt 被清空,与原请求完全
  // 不同的回合。修复后:409 之后什么都不自动发生(paused 原封、指令原封、无进程);
  // 用户重点 /fire 时送达的是全新任务正文,不是检查点。
  const wA = "scheduled-single-ckpt-wa";
  const wPrompt = "检查点:旧会话的继续指令(ckpt-fire-old)";
  await db.insert(tasks).values([
    {
      ...taskRow(wA, "claude", "paused"),
      mode: "single", team: null,
      body: "保持运行等待引导(ckpt-fire-fresh)",
      resumePrompt: wPrompt,
    },
  ]);
  await db.insert(sessions).values({
    id: "scheduled-ckpt-wa-prev", taskId: wA, role: "single", agentType: "claude",
    executor: "claude@test", cwd: root, cliSessionId: "scheduled-ckpt-wa-cli", startedAt: at,
  });
  await db.insert(queueItems).values([
    { queueId: "scheduled-ckpt-queue-w", taskId: wA, position: 0, createdAt: at },
  ]);
  const ext2 = new DatabaseSync(process.env.ASH_DB!);
  ext2.exec("BEGIN IMMEDIATE");
  const fireRes = await api.request(`/tasks/${wA}/fire`, { method: "POST" });
  assert.equal(fireRes.status, 409, `/fire 撞写入失败应 409,实际 ${fireRes.status}`);
  assert.equal(runs.isTurnClaimed(wA), false, "/fire 失败后回合锁必须释放");
  ext2.exec("ROLLBACK");
  ext2.close();
  await new Promise((resolve) => setTimeout(resolve, 3_500));
  const wRow = async () => (await db.select().from(tasks).where(eq(tasks.id, wA))).at(0)!;
  assert.equal(await taskStatusOf(wA), "paused", "/fire 失败后任务必须停在 paused 等用户,不得被补偿自动续跑");
  assert.equal((await wRow()).resumePrompt, wPrompt, "/fire 失败的补偿不得消费检查点指令");
  assert.equal(countIn(leadLog, "ckpt-fire-old"), 0, "旧检查点指令不得被自动送进会话(第 2 轮审查的事故形态)");
  assert.equal(runs.isRunning(wA), false, "409 之后不许有任何进程被自动拉起");
  // 用户重点「立即触发」:仍是全新一轮 —— 送任务正文,不碰旧会话与检查点。
  const refire = await api.request(`/tasks/${wA}/fire`, { method: "POST" });
  assert.equal(refire.status, 202, `恢复后重点 /fire 应 202,实际 ${refire.status}`);
  await waitFor(() => countIn(leadLog, "ckpt-fire-fresh") > 0, "/fire 重试没有送达全新任务正文");
  assert.equal(countIn(leadLog, "ckpt-fire-old"), 0, "/fire 重试不得续跑旧检查点");
  await stopWhenLive(wA);
  console.log("✓ /fire 撞写入失败:不自动续跑旧会话、检查点指令原封,重试仍是全新一轮");
}
