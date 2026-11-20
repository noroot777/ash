// 「派完就算完成」欠下的那一下收尾（src/dispatch-suggestion-settle.ts）：
//  S1 结成完成的那一笔写不进去（库里触发器拒 done）：派出照样算数，欠账原样留着、时间线只报一次；修好后补办落 done、记一次完成、销账；
//  S2 完成落下之后结算后续没交付（预约的审查那一笔写不进去）：完成照样落下，欠账从 complete 换成 followUp 留着，不重记完成；
//     修好后补办开预约的审查、销账——「状态 done」不冒充「后续已交付」；
//  S3 本来就是已完成（完成之后的续聊里摆的单）：不再记一次完成，但清掉提问之后该开的预约照开；
//  S4 名下还有没收下的哨兵结果：跟 complete_task 同一道闸，不落 done、不作废那条结果，落成可恢复等待交回智能体，欠账作废；
//  S5 授权过期：用户手动改了状态、状态被别处改过、起过新回合（方向世代前进）、归档、接力出去，都不再替它收尾；
//  S6 开机首扫抛了（库一时读不了）：每分钟的兜底照样装上，之后接着还；
//  S7 接力过来的问答记录不带欠账；会话里认派出回执靠记录标记，用户贴一段回执原文的普通答复不被吞掉。
// 跑：npm -w server run test:dispatch-suggestion-settle
import { at, db, freeWorkflowStates, project, request, row, setup, tasks, teardown, until, arm } from "./prerequisite-fixture.js";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { appendMonitorWake } from "@navi/shared/monitor-wake";
import { dispatchLaunchOf } from "@navi/shared/dispatch-suggestion";
import type { QuestionRecord } from "@navi/shared/questions";

const { dbClient } = await import("../src/db/index.js");
const { monitors, scheduledMessages, sessions } = await import("../src/db/schema.js");
const { sessionTranscriptPath } = await import("../src/transcript.js");
const { enqueueMessage } = await import("../src/pending-messages.js");
const settle = await import("../src/dispatch-suggestion-settle.js");

const slot = async (taskId: string) => (await db.select().from(freeWorkflowStates).where(eq(freeWorkflowStates.taskId, taskId))).at(0) ?? null;
const historyOf = async (taskId: string) => JSON.parse((await row(taskId)).questionHistory ?? "[]") as QuestionRecord[];
const debtOf = async (taskId: string) => (await historyOf(taskId)).find((record) => record.settleOwed)?.settleOwed ?? null;
/** 时间线写在这条任务的会话正文里：给它一条会话，数那一行出现了几次。 */
const withSession = (taskId: string) => db.insert(sessions).values({
  id: `${taskId}-s`, taskId, role: "single", agentType: "claude", executor: "claude@test", cwd: "/", cliSessionId: `${taskId}-cli`, startedAt: at,
});
const alerts = (taskId: string) => {
  const path = sessionTranscriptPath(taskId, `${taskId}-s`);
  return existsSync(path) ? readFileSync(path, "utf8").split("还没能按约定收尾").length - 1 : 0;
};
/** 处理完那一下留在问答记录上的样子（dispatch-suggestion-resolve.ts）：清单待补交、欠一下收尾。 */
const owe = async (taskId: string) => {
  const task = await row(taskId);
  const record: QuestionRecord = {
    id: `${taskId}-rec`, answeredAt: at, question: "派出这 1 个任务", answer: "派出这 1 个任务\n一个接一个",
    reply: "用户按了「派出去」：Navi 已照你上次摆的那一批此刻的样子建好下面 1 个任务",
    dispatchLaunch: [{ id: `${taskId}-kid`, title: "收尾那一条", agent: "claude" }],
    undelivered: true, settleOwed: settle.launchDebtFor(task),
  };
  await db.update(tasks).set({ questionHistory: JSON.stringify([record]) }).where(eq(tasks.id, taskId));
};
const trigger = (name: string, body: string) => dbClient.execute(`CREATE TRIGGER ${name} ${body}`);
const drop = (name: string) => dbClient.execute(`DROP TRIGGER ${name}`);

let failure: unknown = null;
try {
  await setup();
  const p = await project();

  // ── S1 结成完成那一笔写不进去 ──
  {
    const id = await p.task("s1", { status: "paused" });
    await withSession(id);
    await owe(id);
    assert.deepEqual(await debtOf(id), { stage: "complete", epoch: (await row(id)).directionEpoch, from: "paused" }, "欠账记着派出那一刻的世代与状态");
    await trigger("s1_fail_done", `BEFORE UPDATE OF status ON tasks WHEN NEW.id = '${id}' AND NEW.status = 'done' BEGIN SELECT RAISE(ABORT, 'simulated done write failure'); END`);
    await settle.settleLaunchDebt(id);
    await settle.settleLaunchDebt(id);
    assert.equal((await row(id)).status, "paused");
    assert.equal((await debtOf(id))?.stage, "complete", "没还上：欠账原样留着");
    assert.equal(alerts(id), 1, "时间线说一次，不是每试一次多一行");
    await drop("s1_fail_done");
    await settle.sweepLaunchDebts();
    const after = await row(id);
    assert.equal(after.status, "done", "修好后补办落 done");
    assert.equal(after.doneSeq, 1, "记的是一次完成");
    assert.equal(await debtOf(id), null, "还清了就销账");
    assert.equal((await historyOf(id))[0]!.undelivered, true, "清单照旧留到下一回合开头补交");
  }
  console.log("✓ S1 结成完成写不进去：欠账留着、只报一次；补办落 done、记一次完成、销账");

  // ── S2 完成落下之后结算后续没交付 ──
  {
    const id = await p.task("s2", { status: "paused" });
    await arm(id, true);
    await owe(id);
    await trigger("s2_fail_review", `BEFORE UPDATE ON free_workflow_states WHEN NEW.task_id = '${id}' BEGIN SELECT RAISE(ABORT, 'simulated follow-up failure'); END`);
    await settle.settleLaunchDebt(id);
    assert.equal((await row(id)).status, "done", "完成照样落下");
    assert.equal((await row(id)).doneSeq, 1);
    assert.equal((await debtOf(id))?.stage, "followUp", "结算后续没交付：欠账换成 followUp 留着");
    assert.equal((await slot(id))?.reviewArmed, true, "预约还挂着");
    await drop("s2_fail_review");
    await settle.sweepLaunchDebts();
    assert.equal((await slot(id))?.reviewArmed, false, "补办时把预约开了（这位审查者没配，按预约规则当场消费掉）");
    assert.equal(await debtOf(id), null, "后续交付了才销账");
    assert.equal((await row(id)).doneSeq, 1, "补办后续不再记一次完成");
  }
  console.log("✓ S2 后续没交付：完成落下、欠账留在 followUp；补办开预约、销账、不重记完成");

  // ── S3 本来就是已完成 ──
  {
    const id = await p.task("s3", { status: "done" });
    await arm(id, true);
    await owe(id);
    assert.equal((await debtOf(id))?.stage, "followUp", "本来已完成的直接欠结算后续");
    await settle.settleLaunchDebt(id);
    assert.equal((await row(id)).doneSeq, 0, "不再记一次完成");
    assert.equal((await slot(id))?.reviewArmed, false, "清掉提问之后预约照开");
    assert.equal(await debtOf(id), null);
  }
  console.log("✓ S3 本来已完成：不重记完成，预约照开");

  // ── S4 名下还有没收下的哨兵结果 ──
  {
    const id = await p.task("s4", { status: "paused" });
    await owe(id);
    const monitorId = `${id}-mon`;
    await db.insert(monitors).values({
      id: monitorId, taskId: id, command: "settle fixture", cwd: p.repo, logPath: `${p.repo}/${monitorId}.log`, sourceRole: "single",
      status: "exited", exitCode: 0, startedAt: at, endedAt: at, expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    // 送达时刻放在以后：稳住「结果到了、还没送到手上」这一刻，不真把智能体叫起来。
    const message = await enqueueMessage({
      taskId: id, text: "RESULT_S4", origin: `monitor:${monitorId}`, turnSource: { role: "single" },
      sendAt: new Date(Date.now() + 600_000), monitorWake: appendMonitorWake(null, { kind: "ended", monitorId, source: "RESULT_S4", body: "RESULT_S4" }),
    });
    await settle.settleLaunchDebt(id);
    const after = await row(id);
    assert.equal(after.status, "paused", "不落 done");
    assert.ok(after.resumePrompt, "落成可恢复等待：结果送到时叫醒智能体，由它看过再确认");
    assert.equal((await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, message.id))).at(0)?.status, "pending", "那条结果没被作废");
    assert.equal(await debtOf(id), null, "交回给智能体自己收尾：欠账作废");
    assert.equal((await historyOf(id))[0]!.undelivered, true, "清单随它醒来那一回合补交");
  }
  console.log("✓ S4 有没收下的哨兵结果：不落 done、不作废结果，落可恢复等待交回智能体");

  // ── S5 授权过期 ──
  {
    const patched = await p.task("s5-user", { status: "paused" });
    await owe(patched);
    await trigger("s5_fail_done", `BEFORE UPDATE OF status ON tasks WHEN NEW.id = '${patched}' AND NEW.status = 'done' BEGIN SELECT RAISE(ABORT, 'simulated done write failure'); END`);
    await settle.settleLaunchDebt(patched);
    await drop("s5_fail_done");
    assert.equal((await request("PATCH", `/tasks/${patched}`, { status: "backlog" })).status, 200);
    assert.equal(await debtOf(patched), null, "用户亲手定了状态：那一下就作废旧授权（之后再被改回原状态也不复活）");
    await settle.sweepLaunchDebts();
    assert.equal((await row(patched)).status, "backlog", "补办不越过用户后来的决定");

    const elsewhere = await p.task("s5-status", { status: "paused" });
    await owe(elsewhere);
    await db.update(tasks).set({ status: "failed" }).where(eq(tasks.id, elsewhere));
    await settle.sweepLaunchDebts();
    assert.equal((await row(elsewhere)).status, "failed", "状态被别处改过：不再是派出那一刻的局面");
    assert.equal(await debtOf(elsewhere), null);

    const moved = await p.task("s5-epoch", { status: "paused" });
    await owe(moved);
    // 起过新回合（起跑那一笔推进世代，task-direction-epoch.ts），又落回同一个状态。
    await db.update(tasks).set({ directionEpoch: sql`${tasks.directionEpoch} + 1` }).where(eq(tasks.id, moved));
    await settle.settleLaunchDebt(moved);
    assert.equal((await row(moved)).status, "paused", "起过新回合：那一回合自己结算，不替它收尾");
    assert.equal(await debtOf(moved), null);

    const archived = await p.task("s5-archived", { status: "paused" });
    await owe(archived);
    await db.update(tasks).set({ archived: true }).where(eq(tasks.id, archived));
    const handedOut = await p.task("s5-handoff", { status: "paused" });
    await owe(handedOut);
    await db.update(tasks).set({ handoff: JSON.stringify({ direction: "out", peerName: "别处" }) }).where(eq(tasks.id, handedOut));
    await settle.sweepLaunchDebts();
    for (const id of [archived, handedOut]) {
      assert.equal((await row(id)).status, "paused", `${id}：归档 / 接力出去的不替它收尾`);
      assert.equal(await debtOf(id), null);
    }
  }
  console.log("✓ S5 授权过期（用户改状态、状态被别处改过、起过新回合、归档、接力出去）：不替它收尾、欠账作废");

  // ── S6 开机首扫抛了 ──
  {
    const id = await p.task("s6", { status: "paused" });
    await owe(id);
    await dbClient.execute("ALTER TABLE tasks RENAME TO tasks_offline");
    await assert.rejects(settle.startLaunchDebtSweeps(40), "首扫读不了库");
    await dbClient.execute("ALTER TABLE tasks_offline RENAME TO tasks");
    await until("首扫抛了之后兜底扫描接着还", async () => (await row(id)).status === "done", 5_000);
    assert.equal(await debtOf(id), null);
  }
  console.log("✓ S6 开机首扫抛了：兜底扫描照样装上，之后接着还");

  // ── S7 接力不带欠账；认派出回执靠记录标记 ──
  {
    const raw = JSON.stringify([{ id: "r", answeredAt: at, answer: "a", reply: "b", undelivered: true, settleOwed: { stage: "complete", epoch: 3, from: "paused" } }]);
    const carried = JSON.parse(settle.questionHistoryWithoutDebt(raw)!) as QuestionRecord[];
    assert.deepEqual([carried[0]!.settleOwed, carried[0]!.undelivered], [undefined, true], "接力过来的不带欠账，待补交的清单照带");
    assert.equal(settle.questionHistoryWithoutDebt(null), null);
    const launched = [{ id: "kid-1", title: "收尾那一条", agent: "codex · gpt-5.6" }];
    const marked: QuestionRecord = { id: "m", answeredAt: at, answer: "派出这 1 个任务\n一个接一个", reply: "用户按了「派出去」：…", dispatchLaunch: launched };
    assert.deepEqual(dispatchLaunchOf(marked), launched, "认服务端写下的那一列");
    assert.equal(dispatchLaunchOf({ ...marked, deleted: true }), null, "删掉的派出记录不再认");
    // 合一之前的派活单记下的老记录：没有那一列，按完整形状认，清单照样读得出来。
    const legacy: QuestionRecord = {
      id: "l", answeredAt: at, answer: "派出这 1 个任务\n同时",
      reply: "【答复】\n用户按了「派出去」：Navi 已照派活单此刻的样子建好下面 1 个任务（同时），挂在本任务名下。\n1. kid-1「收尾那一条」→ codex · gpt-5.6",
    };
    assert.deepEqual(dispatchLaunchOf(legacy), launched, "老的派出记录按完整形状认");
    assert.equal(dispatchLaunchOf({ ...legacy, reply: legacy.reply.split("\n").slice(0, 2).join("\n") }), null, "清单行数对不上不算");
    const typed = "用户按了「派出去」：但没有反应，请继续排查。";
    assert.equal(dispatchLaunchOf({ id: "t", answeredAt: at, answer: typed, reply: `【答复】\n${typed}` }), null, "普通答复撞上回执开头不算派出记录");
    assert.equal(dispatchLaunchOf({ ...legacy, answer: typed }), null, "答的那一句不是「派出这 N 个任务」不算");
  }
  console.log("✓ S7 接力不带欠账；认派出记录靠服务端写下的清单（老记录按完整形状），普通答复贴回执不被吞");
} catch (error) {
  failure = error;
  console.error(error);
} finally {
  await teardown();
  // S4 那条以后才送达的哨兵结果挂着送达定时器，S6 装着兜底扫描：不显式退出的话进程会一直等着它们。
  process.exit(failure ? 1 : 0);
}
