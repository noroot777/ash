// 完成闸的**检查点归属**那一半：那段续跑指令是系统写的还是 agent 自己写的（第 2 轮审查
// R2-2），以及「先落检查点、再撤确认」这个顺序在写失败时兜住了什么（R2-1 点出的半状态）。
//
// 为什么跟 `test-monitor-complete-gate.ts` 分开：那份钉的是「什么情况下拦得住」，这份钉的是
// 「拦下来之后写在任务行上的那段话归谁、什么时候失效」。两份共用同一套台子
// （`monitor-complete-gate-harness.ts`），由那份脚本按顺序驱动 —— 合在一个文件里是 706 行，
// 超过单文件 700 行的约定（全局约定；`monitor-checkpoint-edges.ts` 也是这条理由）。
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  clearAutoCheckpoint, complete, confirmedAt, db, insertMonitorRow, makeTask, monitorStatus,
  monitorWakeCheckpoint, now, restoreResumePrompt, scheduledMessages, sessionWithTurn,
  settleTaskStatus, startMonitor, stopMonitor, takeResumePrompt, tasks, taskRow, transcriptOf,
  uniq, writeResumePrompt,
} from "./monitor-complete-gate-harness.js";

export async function checkpointGroups(): Promise<void> {
  // ── ㉖ F2：那段话的来源在「取走 → 退回」一趟里不许丢 ─────────────────────────────
  //
  // 上一版的口径是「凡是写 resume_prompt 的地方都同时写来源」，靠自觉在十来个点上带对一个
  // 布尔；第 1 轮审查（PUfD6pQBJUri）F2 从三个点走穿了它（持久重投只存了文字、普通运行冲突
  // 的退回漏了来源、跨机接力载荷里压根没这一列）。现在换成「取走/退回一个字都不碰来源列」
  // —— 于是**调用方连传错的机会都没有**（`restoreResumePrompt` 没有这个参数）。
  for (const auto of [true, false]) {
    const taskId = await makeTask();
    const text = auto ? "系统替它写下的等待" : "继续：先把那份报表取回来";
    assert.ok(await writeResumePrompt(taskId, text, auto), "写入新文本要声明来源");
    assert.equal((await taskRow(taskId)).resumePromptAuto, auto);

    assert.ok(await takeResumePrompt(taskId, text), "取走");
    const away = await taskRow(taskId);
    assert.equal(away.resumePrompt, null, "文字确实被带走了");
    assert.equal(
      away.resumePromptAuto, auto,
      "来源那一格休眠着、不许归零：归零之后退回来就成了「agent 自己写的」（F2）",
    );
    // 文字不在手上时「作废这段等待」是空操作：动它就等于把一段正在路上的文字的来源改掉。
    assert.equal(await clearAutoCheckpoint(taskId), false, "没有文字 = 没有等待可作废");

    assert.ok(await restoreResumePrompt(taskId, text), "原样退回");
    const back = await taskRow(taskId);
    assert.equal(back.resumePrompt, text);
    assert.equal(back.resumePromptAuto, auto, "往返一趟,来源必须还是原来那个（F2）");
    // 来源还在 ⇒ 两种等待的有效期才分得开：系统那段作废得掉，agent 自己那段谁也不许抹。
    assert.equal(await clearAutoCheckpoint(taskId), auto, "有效期按来源判");
    assert.equal((await taskRow(taskId)).resumePrompt, auto ? null : text);
  }

  // ── ㉗ F2 实测走穿的那条：**持久重投**（首次调用的内存闭包早没了，只剩账本列）─────────
  //
  // `F2_DURABLE_CHECKPOINT_SOURCE {"afterTake":{"auto":false},"afterRestore":{"auto":false},
  // "settlement":"paused"}` —— 上一版在重投分支里硬写 `false`，于是一段系统等待经一次「进程
  // 在这儿没了、靠账本重投」就被洗成 agent 自己写的，此后永不自动清理，任务停在 paused 等
  // 一个再也不会来的唤醒。
  {
    const taskId = await makeTask({ status: "done" });
    const wait = "继续：等那条哨兵的结果到了再收工";
    assert.ok(await writeResumePrompt(taskId, wait, true));
    const monitorId = await insertMonitorRow(taskId, { status: "exited" });
    const msgId = uniq("msg");
    await db.insert(scheduledMessages).values({
      id: msgId, taskId, text: "【哨兵】RESULT_READY", attachments: "[]",
      origin: `monitor:${monitorId}`, mode: "queued", status: "pending",
      sendAt: now(), createdAt: now(),
    });
    const msgRow = async () =>
      (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, msgId))).at(0)!;

    const first = await monitorWakeCheckpoint(await msgRow());
    assert.ok(first, "任务行上挂着交代就该带上");
    assert.equal(
      (await taskRow(taskId)).resumePromptAuto, true,
      "取走那一笔不许动来源列 —— 这正是重投能认回来源的前提",
    );
    // **把 first.restore 丢掉**：模拟「进程在这儿没了」。下一次只剩账本列。
    const again = await monitorWakeCheckpoint(await msgRow());
    assert.ok(again, "重投只认账本列,不再从任务行上取第二次");
    await again.restore();

    const back = await taskRow(taskId);
    assert.equal(back.resumePrompt, wait, "退回原位");
    assert.equal(
      back.resumePromptAuto, true,
      "持久重投退回来仍然是「系统写的」（F2 走穿的就是这一笔）—— 否则它再也不会被自动清掉",
    );
    assert.equal(await clearAutoCheckpoint(taskId), true, "来源在 ⇒ 不等它了之后这段话作废得掉");
    assert.equal(await monitorStatus(monitorId), "exited");
  }

  // ── ⑳ R2-2：系统写下的那段等待有有效期 —— 不等它了、重新交卷就该清掉 ─────────────
  //
  // 实测过的死局：complete 200 → 挂哨兵（撤确认 + 写等待）→ 自己又 stop 掉它 → 再 complete 200，
  // 而结算仍得到 paused、等待还在（`NEW_STALE_AUTOMATIC_CHECKPOINT`）。这时候既没有在盯的哨兵、
  // 也没有排着的结果会再来叫醒它，预约的审查被这段话一直挡着。
  {
    const taskId = await makeTask();
    const sessionId = await sessionWithTurn(taskId, new Date(Date.now() - 60_000).toISOString());
    assert.equal((await complete(taskId)).status, 200);

    const started = await startMonitor({ taskId, command: "sleep 45", description: "再想想" });
    assert.ok(started.ok, "先挂上一条，把那份确认撤掉");
    const monitorId = started.ok ? started.monitor.id : "";
    const held = await taskRow(taskId);
    assert.ok(held.resumePrompt, "撤确认的同时写下了系统等待");
    assert.equal(held.resumePromptAuto, true, "来源要记下来（R2-2 靠它分「谁写的」）");

    assert.ok(await stopMonitor(monitorId, "不等它了"), "决定不等它了");
    const res = await complete(taskId);
    assert.equal(res.status, 200, "阻塞物没了 ⇒ 完成该放行");
    assert.equal(
      (await taskRow(taskId)).resumePrompt, null,
      "放行就要把那段已经失效的系统等待清掉（R2-2）",
    );
    assert.equal(((await res.json()) as { willSettleAs: string }).willSettleAs, "done", "落位预告也要跟着对");

    const settled = await settleTaskStatus(taskId, 0, null);
    assert.equal(settled.status, "done", "实际落位就是 done，不是停在一个没人会来叫醒的 paused");
    assert.equal(settled.confirmedDone, true);
    assert.match(transcriptOf(sessionId, taskId), /不等它了/, "撤的理由仍然留在时间线上");
  }

  // ── ⑳b 撤确认时 agent 已经自己写过一段检查点：只填空位，但确认照样要撤 ─────────────
  //
  // 这两笔的顺序是**半写安全**的：先落检查点、再撤确认。反过来的话，撤成功 + 检查点写失败会
  // 留下「既没确认也没等待」，那一轮按没交卷落 failed，哨兵跟着被收走（第 2 轮审查 R2-1 点出
  // 的半状态）。这一节走的是同一段里「空位已经被占」那一支：写不进去也绝不许盖掉它自己那段。
  {
    const taskId = await makeTask();
    await sessionWithTurn(taskId, new Date(Date.now() - 60_000).toISOString());
    assert.equal((await complete(taskId)).status, 200);
    const mine = "继续：等那份报表回来再接着写结论";
    await db.update(tasks).set({ resumePrompt: mine, resumePromptAuto: false }).where(eq(tasks.id, taskId));

    const started = await startMonitor({ taskId, command: "sleep 45", description: "又挂一条" });
    assert.ok(started.ok, `挂哨兵本身要成功：${started.ok ? "" : started.error}`);
    assert.equal(await confirmedAt(taskId), null, "那份确认必须撤掉 —— 新哨兵会被 done 连坐");
    assert.equal(
      (await taskRow(taskId)).resumePrompt, mine,
      "它自己那段比系统这段更知道它想干什么，只填空位（不许盖掉）",
    );

    const settled = await settleTaskStatus(taskId, 0, null);
    assert.equal(settled.status, "paused", "这一轮落检查点暂停");
    assert.equal(
      await monitorStatus(started.ok ? started.monitor.id : ""), "running",
      "哨兵必须活着 —— 这整段就是为了它",
    );
  }

  // ── ⑳c 半写：检查点落不下去时，绝不许把那份确认也撤掉 ─────────────────────────────
  //
  // 两笔写入的顺序就是为这一刻排的：**先落检查点、再撤确认**。反过来（撤成功 + 检查点写失败）
  // 留下的是「既没确认也没等待」—— 那一轮按没交卷落 failed，而 failed 同样是终态，哨兵跟着
  // 被收走（第 2 轮审查 R2-1 点出的半状态）。这里用一个 ABORT 触发器真的让那一笔写失败。
  {
    const taskId = await makeTask();
    await sessionWithTurn(taskId, new Date(Date.now() - 60_000).toISOString());
    assert.equal((await complete(taskId)).status, 200);
    await db.run(
      "CREATE TRIGGER block_resume BEFORE UPDATE OF resume_prompt ON tasks"
      + " BEGIN SELECT RAISE(ABORT, '注入:检查点写不进去'); END" as never,
    );
    let monitorId = "";
    try {
      const started = await startMonitor({ taskId, command: "sleep 45", description: "半写现场" });
      assert.ok(started.ok, `创建本身不该被这件事带崩：${started.ok ? "" : started.error}`);
      monitorId = started.ok ? started.monitor.id : "";
      assert.equal(started.ok ? started.notice ?? null : null, null, "没改成暂停就别跟它说改成暂停了");
      assert.notEqual(
        await confirmedAt(taskId), null,
        "检查点没落下 ⇒ 那份确认必须原样留着（撤了就只剩「没交卷」一条路，哨兵跟着被收走）",
      );
    } finally {
      await db.run("DROP TRIGGER block_resume" as never);
    }
    // 最后一关兜住它：带着那份确认进结算，照样被拦成暂停，哨兵活着。
    const settled = await settleTaskStatus(taskId, 0, null);
    assert.equal(settled.status, "paused", "半写之后仍然不许落 done");
    assert.equal(await monitorStatus(monitorId), "running");
    assert.ok((await taskRow(taskId)).resumePrompt, "这一次（库已经正常）要留下续跑指令");
  }

  // ── ㉑ R2-2 的另一半：agent 自己 `pause_task` 写的那段，谁也不许抹 ────────────────
  {
    const taskId = await makeTask();
    await sessionWithTurn(taskId, new Date(Date.now() - 60_000).toISOString());
    const mine = "继续：先去把那份报表取回来，再接着写结论";
    await db.update(tasks).set({ resumePrompt: mine, resumePromptAuto: false }).where(eq(tasks.id, taskId));

    const res = await complete(taskId);
    assert.equal(res.status, 200, "名下没有哨兵，确认照旧放行");
    assert.equal((await taskRow(taskId)).resumePrompt, mine, "它自己写的检查点一个字都不许动（R2-2）");
    const body = await res.json() as { willSettleAs: string; note?: string };
    assert.equal(body.willSettleAs, "paused", "结算把检查点排在完成之前，预告必须照实说（R2-2）");
    assert.match(body.note ?? "", /续跑指令/, "还要告诉它为什么不是 done");

    const settled = await settleTaskStatus(taskId, 0, null);
    assert.equal(settled.status, "paused", "实际落位与预告一致");
  }
}
