// 完成闸的**结果交接**那一半：一份「还没交到执行者手上」的责任在三类之间转移时，闸不能从
// 指缝里把它漏掉（第 2 轮审查 F1），而这份责任一旦暂时送不出去，必须有人继续负责送
// （F3），送的时候不许把同一条通知送成两条（N1），统计也不许把失败算成成功（N2）。
//
// 为什么跟 `test-monitor-complete-gate.ts` 分开：那份钉的是「什么情况下拦得住」，这一份钉的
// 是「责任在路上的每一刻都有人认」。三份共用同一套台子（`monitor-complete-gate-harness.ts`），
// 由那份脚本按顺序驱动 —— 合一个文件早就过了单文件 700 行的约定。
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  complete, db, dbClient, deliverResultHandoff, insertMonitorRow, makeTask, monitors,
  monitorsBlockingComplete, now, pendingOf, scheduledMessages, sessionWithTurn, sleep, tasks,
  uniq, until,
} from "./monitor-complete-gate-harness.js";

const { handoffToken } = await import("@ash/shared/monitor");
const {
  outstandingResultHandoffs, startResultHandoffSweeper, stopResultHandoffSweeper, sweepResultHandoffs,
} = await import("../src/monitor-handoff-retry.js");

/** 闸跑一趟期间，底层到底对哪几条语句开了口。 */
async function sqlDuringGate(taskId: string): Promise<{ gate: string | null; reads: string[] }> {
  const seen: string[] = [];
  const target = dbClient as unknown as { execute: (stmt: unknown) => unknown };
  const original = target.execute.bind(dbClient);
  target.execute = (stmt: unknown) => {
    const text = typeof stmt === "string" ? stmt : String((stmt as { sql?: string }).sql ?? "");
    seen.push(text);
    return original(stmt);
  };
  try {
    const gate = await monitorsBlockingComplete(taskId);
    return {
      gate,
      reads: seen.filter((t) => /^\s*select/i.test(t) && /"(monitors|scheduled_messages)"/.test(t)),
    };
  } finally {
    target.execute = original;
  }
}

/** 一条「结局已写定、通知还没入队」的哨兵：终态 + 凭证，跟生产里收尾那一笔落下的样子一致。 */
async function handoffPending(taskId: string, text = "【哨兵结束】静默退出，退出码 0。"): Promise<string> {
  const id = await insertMonitorRow(taskId, { status: "exited" });
  await db.update(monitors).set({
    endedAt: now(), endedReason: "命令自己跑完了", endedBy: "system",
    resultHandoffAt: now(), resultHandoffText: text,
  }).where(eq(monitors.id, id));
  return id;
}

export async function resultHandoffGroups(): Promise<void> {
  // ── ㉘ F1：三类必须在**一条语句**里读齐 ─────────────────────────────────────────
  //
  // 第 2 轮审查（PUfD6pQBJUri）走穿的那条缝不在任何一类里，而在**类与类之间**：上一版三类
  // 各发一条 SELECT，而一份责任恰恰是从第三类移进第二类的（收尾的交接 = 「入队」+「销凭
  // 证」两条语句）。于是读完第二类（还没入队，空）→ 交接整件做完 → 读第三类（凭证已销，
  // 空）⇒ 三个读数全空、放行、落 done、刚入队的那条通知被终态清理作废（实测
  // `F1_NONATOMIC_GATE_HTTP` / `F1_NONATOMIC_GATE_FINAL`）。
  //
  // 行为断言（下面第二段）证不出这件事：它能证明某几个**静止状态**拦得住，而缝是动态的。
  // 所以这一段直接钉**结构**：闸对这两张来源表只许开一次口。谁把它拆回多条 SELECT，这里就
  // 红——不管那几条语句各自多正确。
  {
    const taskId = await makeTask();
    const monitorId = await handoffPending(taskId);
    const { gate, reads } = await sqlDuringGate(taskId);
    assert.match(gate ?? "", /正在送/, "台子前提：这一刻确实有一笔在途的交接");
    assert.equal(
      reads.length, 1,
      `闸对 monitors / scheduled_messages 只许开一次口（一条语句 = 一份快照 = 类与类之间没有缝），`
      + `这一趟开了 ${reads.length} 次：\n${reads.join("\n---\n")}`,
    );
    assert.match(reads[0], /'live'/, "那一条语句要自己覆盖第一类");
    assert.match(reads[0], /'unread'/, "……第二类");
    assert.match(reads[0], /'handoff'/, "……和第三类");
    await db.delete(monitors).where(eq(monitors.id, monitorId));
  }

  // 同一条责任在转移途中的**每一个瞬间**都得有人认。顺序由生产代码定死（先入队、后销凭
  // 证），所以中间那个瞬间是「两类同时看得见」，而不是「两类都看不见」。
  {
    const taskId = await makeTask();
    const monitorId = await handoffPending(taskId);
    assert.match(await monitorsBlockingComplete(taskId) ?? "", /正在送/, "① 入队之前：凭证拦着");

    // ② 两条语句之间：消息已经进托盘、凭证还没销。
    await db.insert(scheduledMessages).values({
      id: uniq("msg-mid"), taskId, text: "【哨兵结束】静默退出，退出码 0。",
      origin: `monitor:${monitorId}`, mode: "queued", sendAt: now(), status: "pending",
      createdAt: now(), checkpointTaken: null,
    });
    const mid = await monitorsBlockingComplete(taskId);
    assert.match(mid ?? "", /排在待发送/, "② 两条语句之间：第二类看得见它");
    assert.match(mid ?? "", /正在送/, "……第三类也还看得见（凭证没销）—— 两类同时认，不是都不认");

    // ③ 销凭证之后：只剩第二类，照样拦得住。
    await db.update(monitors).set({ resultHandoffAt: null, resultHandoffText: null })
      .where(eq(monitors.id, monitorId));
    const after = await monitorsBlockingComplete(taskId);
    assert.match(after ?? "", /排在待发送/, "③ 销凭证之后：第二类接着拦");
    assert.doesNotMatch(after ?? "", /正在送/, "凭证确实销了，不能再说「正在送」");
    await db.delete(scheduledMessages).where(eq(scheduledMessages.taskId, taskId));
  }

  // 走真实的 `deliverResultHandoff`（而不是手工摆状态）：做完整件交接之后，完成仍被第二类
  // 拦着 —— 这是上一版放行的那个现场。
  {
    const taskId = await makeTask();
    await sessionWithTurn(taskId, new Date(Date.now() - 60_000).toISOString());
    const monitorId = await handoffPending(taskId, "【哨兵结束】RESULT_READY。");
    await deliverResultHandoff(monitorId);
    assert.equal((await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!.resultHandoffAt, null,
      "台子前提：这一趟真的把交接做完了（凭证已销）");
    assert.match((await pendingOf(taskId)).map((m) => m.text).join(""), /RESULT_READY/, "结果真的进了托盘");
    assert.equal((await complete(taskId)).status, 409, "交接刚做完 ⇒ 换第二类拦，中间没有空档");
    await db.delete(scheduledMessages).where(eq(scheduledMessages.taskId, taskId));
  }

  // 哨兵行**已经没了**、消息还排着：照样算（消息本身就是结果）。这是 LEFT JOIN 那一支，
  // 内连接会把它整条漏掉。
  {
    const taskId = await makeTask();
    const gone = uniq("mon-gone");
    await db.insert(scheduledMessages).values({
      id: uniq("msg-orphan"), taskId, text: "【哨兵结束】孤儿事件。",
      origin: `monitor:${gone}`, mode: "queued", sendAt: now(), status: "pending",
      createdAt: now(), checkpointTaken: null,
    });
    const gate = await monitorsBlockingComplete(taskId);
    assert.match(gate ?? "", /排在待发送/, "哨兵行没了也要拦 —— 那条消息仍会被终态清理作废");
    assert.match(gate ?? "", new RegExp(gone), "名字只能退回 origin 里的 id，不许显示空串");
    await db.delete(scheduledMessages).where(eq(scheduledMessages.taskId, taskId));
  }

  // ── ㉙ F3：这笔交接送不出去时，**必须有人继续负责送** ──────────────────────────────
  //
  // 第 2 轮审查实测（`F3_NO_LIVE_RESULT_RETRY`）：入队那一笔被注入失败之后，凭证留着、闸一直
  // 拦着、agent 反复 complete 只拿到 409「等一下再调一次就行」—— 而进程里压根没有第二个人会
  // 去送：唯一的补发入口在开机那一趟。故障撤掉后手工调一次开机用的补偿函数，立刻就入队了，
  // 说明缺的是**调度**，不是数据或权限。
  //
  // 台子：真实触发器让 INSERT 失败一次（走的是生产的失败分支），然后撤掉触发器、**不重启任何
  // 东西**，只把常驻巡检的周期调快，看它自己把这笔送出去。
  {
    const taskId = await makeTask();
    await sessionWithTurn(taskId, new Date(Date.now() - 60_000).toISOString());
    const monitorId = await handoffPending(taskId, "【哨兵结束】F3 的结果。");
    await db.run(
      "CREATE TRIGGER block_handoff_enqueue BEFORE INSERT ON scheduled_messages"
      + " BEGIN SELECT RAISE(ABORT, '注入:结束通知入不了队'); END" as never,
    );
    let outcome = "";
    try {
      outcome = await deliverResultHandoff(monitorId);
      assert.equal(outcome, "failed", "送不出去就得照实说 failed —— 不许用「没抛异常」冒充送达（N2）");
      assert.deepEqual(await outstandingResultHandoffs(), [monitorId], "凭证必须留着（闸还得靠它拦）");
      assert.match(await monitorsBlockingComplete(taskId) ?? "", /正在送/, "拦着的理由仍然成立");
      // 失败这一趟里巡检也救不了（触发器还在）：**照实记成 failed，不是 delivered**。
      assert.deepEqual(await sweepResultHandoffs(), { delivered: 0, dropped: 0, failed: 1 },
        "巡检的统计要分项：失败绝不能混进「已补发」（N2）");
    } finally {
      await db.run("DROP TRIGGER block_handoff_enqueue" as never);
    }
    // 故障撤掉，谁都不重启、也不开巡检：**失败那一趟自己排下的退避重试**把它送出去。
    await until(
      "失败的那一趟自己排了重试，并且真的自己送出去了（上一版要等到下次重启）",
      async () => (await outstandingResultHandoffs()).length === 0,
      8_000,
    );
    assert.match((await pendingOf(taskId)).map((m) => m.text).join(""), /F3 的结果/, "结果真的到了任务头上");
    await db.delete(scheduledMessages).where(eq(scheduledMessages.taskId, taskId));
  }

  // 兜底巡检那一条腿单独钉住：**一笔从没人碰过的凭证**。退避重试只存在于「有人送过一次并且
  // 失败了」之后的内存里 —— 收尾在「写时间线」那一笔就抛了（压根没走到投递入口）、或者进程
  // 换过一次（阶梯跟着没了），都属于这一类。只有巡检救得了它。
  {
    const taskId = await makeTask();
    await sessionWithTurn(taskId, new Date(Date.now() - 60_000).toISOString());
    const monitorId = await handoffPending(taskId, "【哨兵结束】没人替它排过重试。");
    await sleep(400);
    assert.deepEqual(
      await outstandingResultHandoffs(), [monitorId],
      "台子前提：没开巡检之前它就一直挂在那儿（没有任何内存里的重试计划指着它）",
    );
    startResultHandoffSweeper(150);
    try {
      await until(
        "常驻巡检把这一笔认领下来并送出去",
        async () => (await outstandingResultHandoffs()).length === 0,
        8_000,
      );
    } finally {
      stopResultHandoffSweeper();
    }
    assert.match(
      (await pendingOf(taskId)).map((m) => m.text).join(""), /没人替它排过重试/,
      "巡检是第二条腿：少了它，这一类凭证要等到下次重启才有人管",
    );
    await db.delete(scheduledMessages).where(eq(scheduledMessages.taskId, taskId));
  }

  // ── ㉚ N1：同一笔交接**不许送成两条**（入队成功、销凭证失败的那种残留）───────────────
  //
  // 入队和销凭证是两条语句。第二条失败（或进程死在中间）之后凭证还在，下一趟重投会再送一次
  // —— 而上一条可能已经 `sent`，合并窗口对它不适用，于是 agent 被同一条通知叫醒两次。
  {
    const taskId = await makeTask();
    await sessionWithTurn(taskId, new Date(Date.now() - 60_000).toISOString());
    const monitorId = await handoffPending(taskId, "【哨兵结束】只许来一次。");
    const credential = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!.resultHandoffAt!;
    assert.equal(await deliverResultHandoff(monitorId), "delivered");
    const first = await pendingOf(taskId);
    assert.equal(first.length, 1, "台子前提：先送出去一条");
    assert.equal(first[0].handoffToken, handoffToken(monitorId, credential),
      "承载这一笔的那条消息要带着身份 —— 否则「送过没有」这一问没有原子答案（N1）");

    // 模拟「销凭证那一笔失败」的残留：凭证按原值写回去，再让上一条消息变成已送达（合并窗口
    // 关上）。这正是重启补发会遇到的库状态。
    await db.update(monitors).set({ resultHandoffAt: credential, resultHandoffText: "【哨兵结束】只许来一次。" })
      .where(eq(monitors.id, monitorId));
    await db.update(scheduledMessages).set({ status: "sent", sentAt: now() })
      .where(eq(scheduledMessages.taskId, taskId));

    assert.equal(await deliverResultHandoff(monitorId), "already",
      "身份已经在库里 ⇒ 这一趟只补销凭证，不再入队");
    assert.equal((await pendingOf(taskId)).length, 0, "一条新消息都不许多出来（上一版会再叫醒一次）");
    assert.deepEqual(await outstandingResultHandoffs(), [], "残留的凭证顺手销掉，别永久拦着完成");
    await db.delete(scheduledMessages).where(eq(scheduledMessages.taskId, taskId));
  }

  // ── ㉚b N1：**库上的唯一性**才是「一笔交接只对应一条消息」的保证 ────────────────────
  //
  // 去重原来是「先查有没有同口令的消息，没有就入队」。两位发送者（在线收尾、离线收尾、退避
  // 重试、每分钟巡检）可以同时读到「没有」，然后各建一条 —— 实测 `Promise.all` 两次投递得到
  // 两条正文和口令都一模一样的待发消息，agent 被同一个结果叫醒两轮。单实例不等于单一在途
  // 调用，所以这件事只能由库给：先查那一步留着只是省掉一次必然失败的写。
  {
    const taskId = await makeTask();
    const token = handoffToken("mon-unique", "2026-10-21T00:00:00.000Z");
    const insert = (id: string) => db.insert(scheduledMessages).values({
      id: uniq(id), taskId, text: "【哨兵结束】只许一条。", attachments: "[]",
      origin: "monitor:mon-unique", mode: "queued", status: "pending",
      sendAt: now(), createdAt: now(), handoffToken: token,
    });
    await insert("msg-first");
    await assert.rejects(
      () => insert("msg-second"),
      /unique/i,
      "同一笔交接不许在托盘里出现两条 —— 这一条由库上的唯一索引挡住，不靠两次读之间什么都没发生",
    );
    // 普通事件这一列是 NULL，而 SQLite 认为 NULL 彼此不等 —— 它们一条都不受影响。
    for (const id of ["msg-plain-a", "msg-plain-b"]) {
      await db.insert(scheduledMessages).values({
        id: uniq(id), taskId, text: "【哨兵】普通事件", attachments: "[]",
        origin: "monitor:mon-unique", mode: "queued", status: "pending",
        sendAt: now(), createdAt: now(),
      });
    }
    assert.equal((await pendingOf(taskId)).length, 3, "没有口令的普通事件照旧想排几条排几条");
    await db.delete(scheduledMessages).where(eq(scheduledMessages.taskId, taskId));
  }

  // 同一笔交接**真的并发送两次**：托盘里只许留一条，而且两位发送者都不许报失败（N1）。
  {
    const taskId = await makeTask();
    await sessionWithTurn(taskId, new Date(Date.now() - 60_000).toISOString());
    const monitorId = await handoffPending(taskId, "【哨兵结束】并发也只叫醒一次。");
    const outcomes = await Promise.all([deliverResultHandoff(monitorId), deliverResultHandoff(monitorId)]);
    const queued = await pendingOf(taskId);
    assert.equal(queued.length, 1, "两位发送者撞上同一笔 ⇒ 托盘里只许有一条（上一版实测是两条）");
    assert.match(queued[0]!.text, /并发也只叫醒一次/);
    assert.ok(
      outcomes.every((o) => o === "delivered" || o === "already"),
      `谁都不该报失败（撞上唯一索引 = 别人送过了，不是出错）：${outcomes.join(",")}`,
    );
    assert.ok(outcomes.includes("delivered"), "至少有一位是真的把它送进去的");
    assert.deepEqual(await outstandingResultHandoffs(), [], "凭证销掉，不许继续拦着完成");
    await db.delete(scheduledMessages).where(eq(scheduledMessages.taskId, taskId));
  }

  // ── ㉛ 任务已经终态 ⇒ 这条通知**无人可收**：销凭证、照实报 dropped，不许算成已补发 ────
  {
    const taskId = await makeTask();
    await handoffPending(taskId, "【哨兵结束】没人收得到。");
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, taskId));
    assert.deepEqual(await sweepResultHandoffs(), { delivered: 0, dropped: 1, failed: 0 },
      "无人可收是第三种结局，既不是送达也不是失败（N2）");
    assert.deepEqual(await outstandingResultHandoffs(), [], "销掉凭证，否则它永久拦着这个任务");
    assert.equal((await pendingOf(taskId)).length, 0, "终态任务头上不许排新消息");
  }
  await sleep(50);
}
