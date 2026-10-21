// 完成闸的**检查点归属**那一半：那段续跑指令是系统写的还是 agent 自己写的（第 2 轮审查
// R2-2），以及「先落检查点、再撤确认」这个顺序在写失败时兜住了什么（R2-1 点出的半状态）。
//
// 为什么跟 `test-monitor-complete-gate.ts` 分开：那份钉的是「什么情况下拦得住」，这份钉的是
// 「拦下来之后写在任务行上的那段话归谁、什么时候失效」。两份共用同一套台子
// （`monitor-complete-gate-harness.ts`），由那份脚本按顺序驱动 —— 合在一个文件里是 706 行，
// 超过单文件 700 行的约定（全局约定；`monitor-checkpoint-edges.ts` 也是这条理由）。
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import {
  clearAutoCheckpoint, complete, confirmedAt, db, insertMonitorRow, makeTask, monitorStatus,
  monitorWakeCheckpoint, now, pause, restoreResumePrompt, scheduledMessages, sessionWithTurn,
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

    const receipt = await takeResumePrompt(taskId, text);
    assert.ok(receipt, "取走");
    assert.deepEqual(
      receipt, { text, auto, generation: 1 },
      "取走拿到的是**整张凭证**:文字、来源、这一格被占用的第几次（第 2 轮审查 F2）",
    );
    const away = await taskRow(taskId);
    assert.equal(away.resumePrompt, null, "文字确实被带走了");
    assert.equal(away.resumePromptGeneration, 1, "取走不是一次新的占用 —— 代次不许动");
    // 文字不在手上时「作废这段等待」是空操作：动它就等于把一段正在路上的文字的来源改掉。
    assert.equal(await clearAutoCheckpoint(taskId), false, "没有文字 = 没有等待可作废");

    assert.ok(await restoreResumePrompt(taskId, receipt), "原样退回");
    const back = await taskRow(taskId);
    assert.equal(back.resumePrompt, text);
    assert.equal(back.resumePromptAuto, auto, "往返一趟,来源必须还是原来那个（F2）");
    assert.equal((await taskRow(taskId)).resumePromptGeneration, 1, "原样退回也不是新占用");
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
    const ledger = await msgRow();
    assert.equal(ledger.checkpointTaken, wait, "账本上记着是哪一段");
    assert.equal(
      ledger.checkpointAuto, true,
      "**来源跟文字同一笔落账**（第 2 轮审查 F2）—— 重投那一趟不许靠任务行上那个可能已经改过的布尔猜",
    );
    assert.equal(ledger.checkpointGeneration, 1, "取走时的占用代次也要落账:它是退回时的归属凭证");
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

  // ── ㉗b F2 第 2 轮走穿的那条：**跨代往返** —— 一个空槽证明不了「来源还是我的」────────
  //
  // 上一轮的口径是「取走/退回一个字都不碰来源列，那一格休眠着等文字回来」。它只在**中间没有
  // 别的写入**时成立：槽可以被另一段文字占用、再被取走，于是又空了 —— 这时在途的旧退回填回来，
  // 就继承到不属于它的来源。审查两个方向都实测到：
  //
  //   `F2_DORMANT_SCALAR_IS_NOT_PROVENANCE originalAuto=true, restoredAuto=false,
  //    settlement=paused`（系统等待被洗成主动暂停 ⇒ 再没人清得掉它，任务卡死在 paused）
  //   `F2_DORMANT_SCALAR_IS_NOT_PROVENANCE originalAuto=false, restoredAuto=true,
  //    settlement=done`（agent 自己写的主动指令被当成系统等待，自动清掉）
  //
  // 现在凭证随身、代次是归属本体：代次变了 ⇒ 这张凭证过期，那段文字**压根填不回去**（它也
  // 确实不该回来 —— 后写的那一段才是最新意图）。所以断言不是「来源对不对」，而是「它根本不许
  // 复活」。
  for (const firstAuto of [true, false]) {
    const taskId = await makeTask();
    const older = firstAuto ? "系统等待：收齐结果以后再确认完成" : "继续：先把那份报表取回来";
    const newer = firstAuto ? "继续：我自己决定在这儿停一下" : "系统等待：收齐结果以后再确认完成";
    assert.ok(await writeResumePrompt(taskId, older, firstAuto));
    const stale = await takeResumePrompt(taskId, older);
    assert.ok(stale, "第一段被取走（它的退回从此在途）");

    // 另一段、**相反来源**的新检查点：写入（代次 +1）→ 又被取走（槽再次空着）。
    assert.ok(await writeResumePrompt(taskId, newer, !firstAuto), "槽空着 ⇒ 新的一段写得进去");
    assert.equal((await taskRow(taskId)).resumePromptGeneration, 2, "写入新文本 = 一次新的占用");
    assert.ok(await takeResumePrompt(taskId, newer), "新的一段也被取走 —— 槽又空了");

    // 旧凭证这时候退回来：**不许落地**。
    assert.equal(
      await restoreResumePrompt(taskId, stale), false,
      "代次已经不是它那一次 ⇒ 这张凭证过期,一个字都不许填回去（上一版会填回去并继承新来源）",
    );
    const after = await taskRow(taskId);
    assert.equal(after.resumePrompt, null, "槽仍然空着 —— 过期的文字没被复活");
    assert.equal(after.resumePromptGeneration, 2, "被挡住的退回不许动代次");
  }

  // 同一条不变量的另一半：**作废**（`clearAutoCheckpoint`）也让代次前进，所以一段已经作废的
  // 等待不许被在途的旧凭证凭一个空槽复活。
  {
    const taskId = await makeTask();
    const wait = "系统等待：收齐结果以后再确认完成";
    assert.ok(await writeResumePrompt(taskId, wait, true));
    assert.equal(await clearAutoCheckpoint(taskId), true, "台子前提：这段等待作废掉了");
    // 伪造一张「作废之前取走的」凭证（代次还是 1）：现实里它来自账本重投或改派回滚。
    assert.equal(
      await restoreResumePrompt(taskId, { text: wait, auto: true, generation: 1 }), false,
      "作废让代次 +1 ⇒ 作废之前取走的凭证全部过期,填不回来",
    );
    assert.equal((await taskRow(taskId)).resumePrompt, null, "作废了就是作废了");
  }

  // 同一条不变量走**生产路径**：账本重投 + 跨代。审查实测的那条正是这一条（持久账本里的旧
  // 文字 + 任务行上另一段文字留下的来源）。
  {
    const taskId = await makeTask({ status: "done" });
    const sessionId = await sessionWithTurn(taskId, new Date(Date.now() - 60_000).toISOString());
    const older = "继续：等那条哨兵的结果到了再收工"; // 系统等待
    assert.ok(await writeResumePrompt(taskId, older, true));
    const monitorId = await insertMonitorRow(taskId, { status: "exited" });
    const msgId = uniq("msg-cross");
    await db.insert(scheduledMessages).values({
      id: msgId, taskId, text: "【哨兵】RESULT_READY", attachments: "[]",
      origin: `monitor:${monitorId}`, mode: "queued", status: "pending",
      sendAt: now(), createdAt: now(),
    });
    const msgRow = async () =>
      (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, msgId))).at(0)!;

    const taken = await monitorWakeCheckpoint(await msgRow());
    assert.ok(taken, "台子前提：交代被这条消息接走了");
    // 进程换过一次（闭包丢掉），同时另一段**主动**暂停占用过那一格又被取走。
    const newer = "继续：我自己决定在这儿停一下";
    assert.ok(await writeResumePrompt(taskId, newer, false), "槽空着 ⇒ 新的一段写得进去");
    assert.ok(await takeResumePrompt(taskId, newer), "新的一段也被取走");

    const replay = await monitorWakeCheckpoint(await msgRow());
    assert.ok(replay, "重投认得出账本上那一段");
    await replay.restore();
    const after = await taskRow(taskId);
    assert.equal(
      after.resumePrompt, null,
      "过期的那一段不许复活 —— 上一版会把它填回去,并继承「agent 自己写的」那个来源(F2)",
    );
    assert.equal((await msgRow()).checkpointTaken, null, "账本要清掉,否则这一段会被无限重投");
    assert.match(
      transcriptOf(sessionId, taskId), /没有放回任务行/,
      "**不许静默作废**:那段交代就这么没了,刷新页面后要看得出发生过这件事",
    );
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

  // ── ㉗c F1-A：**真人暂停走的是生产路由**，它也得记一次占用 ──────────────────────────
  //
  // 代次只有在所有 writer 都维护它时才是归属凭证。这条路由原来自己 `db.update` 直写两列、
  // 不动代次，于是「数值相等」压根证明不了「还是同一次占用」：实测写下一段新的主动暂停后代次
  // 仍是 1，一个在途的旧凭证于是合法地填回去、占住位置，真正新的那一段再也退不回来
  // （`F2_HTTP_PAUSE_GENERATION_BYPASS`）。
  {
    const taskId = await makeTask();
    const older = "旧的自动等待";
    assert.ok(await writeResumePrompt(taskId, older, true));
    const stale = await takeResumePrompt(taskId, older);
    assert.ok(stale, "台子前提：旧那段已被取走，一张凭证在途");

    const newer = "新的主动暂停：继续取报表";
    assert.equal((await pause(taskId, newer)).status, 200, "生产路由本身照常放行");
    const after = await taskRow(taskId);
    assert.equal(after.resumePrompt, newer);
    assert.equal(after.resumePromptAuto, false, "路由写的是「agent 自己写的」");
    assert.equal(
      after.resumePromptGeneration, stale.generation + 1,
      "这是一次新占用 ⇒ 代次必须 +1（绕过记账的直写就是 F1-A 走穿的那一处）",
    );
    // 新的这一段也被取走（它那一轮起跑没完成），于是两张凭证同时在途、槽空着。
    const fresh = await takeResumePrompt(taskId, newer);
    assert.ok(fresh);
    assert.equal(
      await restoreResumePrompt(taskId, stale), false,
      "旧凭证不许占住这一格 —— 它那次占用早就过去了",
    );
    assert.ok(await restoreResumePrompt(taskId, fresh), "真正新的那一段退得回来");
    const back = await taskRow(taskId);
    assert.equal(back.resumePrompt, newer, "最后留在任务行上的必须是新的那一段");
    assert.equal(back.resumePromptAuto, false, "来源也得是它自己的");
  }

  // ── ㉗d F1-A 的结构锁：**写这三列的入口只有存储层那一个** ───────────────────────────
  //
  // 上面那条只钉得住 HTTP 这一个入口，而同形的直写当时还有一处（断线补录的 `pause_task`）。
  // 「以后记得走 writer」是靠自觉，所以这里按**语句**扫一遍：`server/src` 里每一条
  // `update(tasks)` 的 `.set({…})` 都不许出现这三列的键名 —— 要写就从 task-resume-prompt.ts
  // 取 patch（那边的 `occupyPatch` 保证代次跟着动）。
  {
    // 取本机路径只能走 `fileURLToPath`：`URL.pathname` 是百分号编码的 URL 路径，仓库目录
    // 名里有空格时它给的是 `%20`，`readdirSync` 对着这个名字报 ENOENT（Windows 的盘符
    // pathname 还多一个前导斜杠）—— 结构锁于是在那种检出上「悄悄通不了」（第 4 轮审查 N2）。
    const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name));
        else if (entry.name.endsWith(".ts")) files.push(join(dir, entry.name));
      }
    };
    walk(srcDir);
    assert.ok(files.length > 50, `台子前提：扫到的源文件太少（${files.length}），路径多半不对`);
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith("task-resume-prompt.ts")) continue; // 存储层本身
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/update\(\s*tasks\s*\)/g)) {
        const setAt = src.indexOf(".set(", m.index);
        if (setAt < 0) continue;
        let depth = 0;
        let end = setAt + 4;
        for (; end < src.length; end += 1) {
          if (src[end] === "(") depth += 1;
          else if (src[end] === ")") { depth -= 1; if (depth === 0) break; }
        }
        const block = src.slice(setAt, end + 1);
        if (/\bresumePrompt(Auto|Generation)?\s*:/.test(block)) {
          offenders.push(`${file.slice(srcDir.length)}：${block.replace(/\s+/g, " ").slice(0, 90)}`);
        }
      }
    }
    assert.deepEqual(
      offenders, [],
      "这三列只许由 task-resume-prompt.ts 写（用它导出的 patch/条件助手）——"
      + `自己 \`.set\` 就会漏掉代次，而那正是 F1-A：\n${offenders.join("\n")}`,
    );
  }

  // ── ㉗e F1-B：转手的归属判据是「文字 + 代次」，只比文字会把新占用记成旧凭证 ──────────
  //
  // 实测现场（`F2_SAME_TEXT_ABA_WRONG_RECEIPT`）：读到那一段之后、转手那一批跑到之前，另一路
  // 把它取走、又原样写成一段**新的主动暂停**（文字一模一样、代次变了）。只比文字的话转手照样
  // 命中，于是清掉的是新那一段、账本记的却是旧的来源和代次；随后投递失败回填被代次挡住、账本
  // 也清了 —— 新暂停两边都没了。
  {
    const taskId = await makeTask();
    const text = "继续：同一句交代";
    assert.ok(await writeResumePrompt(taskId, text, true), "台子前提：先挂一段系统等待");
    const monitorId = await insertMonitorRow(taskId, { status: "exited" });
    const msgId = uniq("msg-aba");
    await db.insert(scheduledMessages).values({
      id: msgId, taskId, text: "【哨兵】RESULT_READY", attachments: "[]",
      origin: `monitor:${monitorId}`, mode: "queued", status: "pending",
      sendAt: now(), createdAt: now(),
    });
    const msgRow = async () =>
      (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, msgId))).at(0)!;

    // 窗口切在生产代码的两步之间：读完那一格、还没跑转手那一批。`db.batch` 只拦这一次。
    const realBatch = db.batch.bind(db);
    let interleaved = false;
    (db as { batch: unknown }).batch = async (stmts: never) => {
      (db as { batch: unknown }).batch = realBatch;
      assert.ok(await takeResumePrompt(taskId, text), "ABA 第一步：另一路把它取走");
      assert.ok(await writeResumePrompt(taskId, text, false), "ABA 第二步：同样的文字、新的一次占用");
      interleaved = true;
      return realBatch(stmts as never);
    };
    const carried = await monitorWakeCheckpoint(await msgRow());
    (db as { batch: unknown }).batch = realBatch;
    assert.equal(interleaved, true, "台子前提：真的切在那两步之间");
    assert.equal(carried, null, "那一格已经换了一次占用 ⇒ 这一趟一个字都不许转手");
    const after = await taskRow(taskId);
    assert.equal(after.resumePrompt, text, "新占用的那一段必须还在任务行上（上一版会把它清掉）");
    assert.equal(after.resumePromptAuto, false, "它的来源也不许被洗成旧那一段的");
    assert.equal((await msgRow()).checkpointTaken, null, "账本一个字都没认（没有半状态）");
  }

  // ── ㉗f F1 同类：**存量账本行**（代次 NULL）只对升级后还没被占用过的那一格有效 ─────────
  //
  // 「代次未知」不等于「对任意新代次都有效」：那种行写下时这一列还不存在，任务行的代次只能是
  // 迁移缺省 0。按「只认空槽」处理的话，升级后明明有过新占用，旧账本仍能把它那一段填回去，
  // 来源还会借用新占用留下的值。
  for (const occupiedSinceUpgrade of [false, true]) {
    const taskId = await makeTask();
    const monitorId = await insertMonitorRow(taskId, { status: "exited" });
    const legacy = "继续：旧库那条消息接走的交代";
    const msgId = uniq("msg-legacy");
    await db.insert(scheduledMessages).values({
      id: msgId, taskId, text: "【哨兵】旧账本", attachments: "[]",
      origin: `monitor:${monitorId}`, mode: "queued", status: "pending",
      sendAt: now(), createdAt: now(),
    });
    // 老账本的样子：只记了文字，来源和代次这两列压根没有。
    await db.update(scheduledMessages)
      .set({ checkpointTaken: legacy, checkpointAuto: null, checkpointGeneration: null })
      .where(eq(scheduledMessages.id, msgId));
    if (occupiedSinceUpgrade) {
      assert.ok(await writeResumePrompt(taskId, "升级后另挂的一段", false));
      assert.ok(await takeResumePrompt(taskId, "升级后另挂的一段"), "它也被取走 ⇒ 槽又空了");
    }
    const replay = await monitorWakeCheckpoint(
      (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, msgId))).at(0)!,
    );
    assert.ok(replay, "重投认得出账本上那一段");
    await replay.restore();
    assert.equal(
      (await taskRow(taskId)).resumePrompt, occupiedSinceUpgrade ? null : legacy,
      occupiedSinceUpgrade
        ? "升级后有过新占用 ⇒ 这张旧凭证就此过期（未知代次不是通配符）"
        : "没人占用过 ⇒ 旧账本那一段照样填得回去（兼容不许反过来丢掉它）",
    );
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
