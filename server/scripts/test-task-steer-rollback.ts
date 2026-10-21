// 原生引导**发送失败那一程**：旧方向的三张票各自回得去吗。
//
// 这一条单独成文件，因为它要的现场是 `test-task-steer-hardening.ts` 里那几个句柄覆盖不到的
// 一支：那边的失败句柄在 `beforeSend` **之前**就抛错（ACK 都没拿到），于是整套通过也证不了
// 「ACK 拿到了、清场也跑了、偏偏新正文没写进去」这一支 —— 而那正是第 3 轮审查 F1-C 实测到的
// 回归：新工作一个字都没送出去，用户原来的问题、agent 的完成确认和那段待续工作三样同时消失。
//
// 根因是两件事挤在一个判据上：清场自己把占用代次推走了，紧接着回滚又拿「代次 = 我进门时读到
// 的那一代」当资格，于是自己把自己挡死；而检查点、提问、完成票当时又共用同一笔 UPDATE，一处
// 不符就整组放弃。现在清场只在真的清掉了东西时才推代次、并把结果记回快照，三张票也各判资格。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-task-steer-rollback-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

const [{ db, dbClient, ensureSchema }, schema, runs, steer, directionState, epoch, status, util] =
  await Promise.all([
    import("../src/db/index.js"),
    import("../src/db/schema.js"),
    import("../src/runs.js"),
    import("../src/task-steer.js"),
    import("../src/task-steer-direction-state.js"),
    import("../src/task-direction-epoch.js"),
    import("../src/status.js"),
    import("../src/util.js"),
  ]);
const { projects, scheduledMessages, tasks } = schema;
await ensureSchema();

const at = new Date().toISOString();
await db.insert(projects).values({ id: "p", name: "steer-rollback", repoPath: root, createdAt: at });

const taskRow = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;
const msgRow = async (id: string) =>
  (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, `m-${id}`))).at(0)!;

/**
 * 一条**正在跑、而且三样都挂着**的任务：那段检查点、一个待答的问题、一张已经确认的完成票。
 * 引导要先把这三样收起来；送不出去时它们必须回来。
 */
async function seed(
  id: string,
  opts: { generation?: number; auto?: boolean; resumePrompt?: string | null } = {},
): Promise<void> {
  await db.insert(tasks).values({
    id, projectId: "p", title: id, body: "test", mode: "single", status: "running",
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", createdAt: at, updatedAt: at,
    activeTurnToken: `${id}-turn`, activeDirectionToken: `${id}-dir`, activeDirectionVersion: 1,
    completeConfirmedAt: "2026-10-20T08:00:00.000Z",
    // `null` = 这一轮压根没挂检查点（只验提问/完成票那两张票时用），跟「缺省」区分开。
    resumePrompt: opts.resumePrompt === undefined ? "主动暂停：保留待续工作" : opts.resumePrompt,
    resumePromptAuto: opts.auto ?? false,
    resumePromptGeneration: opts.generation ?? 3,
    question: "保留旧问题", questionOptions: JSON.stringify(["甲", "乙"]),
  });
  await db.insert(scheduledMessages).values({
    id: `m-${id}`, taskId: id, text: `新方向：${id}`, attachments: "[]", mode: "queued",
    sendAt: at, status: "pending", createdAt: at,
  });
}

try {
  // ── ① ACK 拿到了、清场跑过了，新正文没写进去 ⇒ 三样原样回来 ──────────────────────
  {
    const id = "ack-then-write-fails";
    await seed(id);
    assert.equal(runs.claimTurn(id, "single"), true);
    let beforeSendRan = false;
    const handle = {
      kill: () => {},
      // 生产形状：`executors/claude.ts` 先跑 `beforeSend`（清掉旧方向迟到的那几样），再写
      // 新的 user 正文；写失败就带着错误回到上层（那时新工作一个字都没出去）。
      steer: async (_text: unknown, beforeSend?: () => void | Promise<void>) => {
        await beforeSend?.();
        beforeSendRan = true;
        throw new Error("注入：interrupt ACK 之后 stdin 写不进去");
      },
    };
    runs.trackRun(id, handle);
    runs.bindNativeSteer(id, handle, { agentType: "claude", record: () => {} });
    const result = await steer.steerQueuedMessage(`m-${id}`);
    assert.equal(result.ok, false, "新正文没送出去，这一趟就是失败");
    assert.equal(beforeSendRan, true, "台子前提：真的跑过清场那一步（否则测的是另一支）");

    const after = await taskRow(id);
    assert.equal(
      after.resumePrompt, "主动暂停：保留待续工作",
      "那段待续工作必须回来 —— 清场推走的代次是**自己**推的，不是别人写了新意图（F1-C）",
    );
    assert.equal(after.resumePromptAuto, false, "来源跟着文字一起回来，不许被洗成系统写的等待");
    assert.equal(after.question, "保留旧问题", "用户的问题也必须回来");
    assert.deepEqual(JSON.parse(after.questionOptions ?? "null"), ["甲", "乙"], "候选一起回来");
    assert.equal(
      after.completeConfirmedAt, "2026-10-20T08:00:00.000Z",
      "完成票的恢复资格跟检查点无关：一处不符不许连它一起放弃（F1-C）",
    );
    runs.untrackRun(id, handle);
    runs.releaseTurn(id);
    await db.update(scheduledMessages).set({ status: "canceled" }).where(eq(scheduledMessages.taskId, id));
  }

  // ── ② 别人**真的**写了新意图：那一段就此过期，而提问和完成票照样回得去 ───────────
  //
  // 这是上一条的反面，也是代次这道闸存在的理由：它只该挡「这中间有过新占用」，不该挡
  // 「代次是我自己清场推走的」。两条用例必须同时成立，否则修法就是把闸整条拆掉。
  {
    const id = "someone-else-wrote";
    await seed(id);
    assert.equal(runs.claimTurn(id, "single"), true);
    const handle = {
      kill: () => {},
      steer: async (_text: unknown, beforeSend?: () => void | Promise<void>) => {
        await beforeSend?.();
        // ACK 之后、回滚之前，另一路写下一段**新的**检查点并把它取走（代次因此真的变了）。
        const { takeResumePrompt, writeResumePrompt } = await import("../src/task-resume-prompt.js");
        assert.ok(await writeResumePrompt(id, "新方向自己挂的检查点", false), "槽空着 ⇒ 写得进去");
        assert.ok(await takeResumePrompt(id, "新方向自己挂的检查点"), "随后它也被取走 ⇒ 槽又空了");
        throw new Error("注入：新正文同样没写进去");
      },
    };
    runs.trackRun(id, handle);
    runs.bindNativeSteer(id, handle, { agentType: "claude", record: () => {} });
    assert.equal((await steer.steerQueuedMessage(`m-${id}`)).ok, false);

    const after = await taskRow(id);
    assert.equal(
      after.resumePrompt, null,
      "这中间真有过一次新占用 ⇒ 旧那段就此过期，不许凭一个空槽复活（第 2 轮审查 F2）",
    );
    assert.equal(after.question, "保留旧问题", "但提问不受检查点那一侧的影响（F1-C）");
    assert.equal(after.completeConfirmedAt, "2026-10-20T08:00:00.000Z", "完成票同上");
    runs.untrackRun(id, handle);
    runs.releaseTurn(id);
    await db.update(scheduledMessages).set({ status: "canceled" }).where(eq(scheduledMessages.taskId, id));
  }

  // ── ③ 改派作废旧方向的检查点意图时，**在路上的那一段也不许回来**（F1 的 Codex 那一支）──
  //
  // 这一格为空还有一种原因：那段文字早被消息账本取走、正在投递途中。清场只看行上有没有文字
  // 的话，Codex 这条成功路径（它没有第二次清场）之后，账本那一侧投递失败仍能把**旧方向**的
  // 检查点填到新方向头上。所以作废就是作废：代次一律前进，在途的凭证全部过期。
  {
    const id = "codex-inflight-receipt";
    await seed(id, { generation: 4 });
    const { takeResumePrompt, restoreResumePrompt } = await import("../src/task-resume-prompt.js");
    const inflight = await takeResumePrompt(id, "主动暂停：保留待续工作");
    assert.ok(inflight, "台子前提：那段检查点已经被取走，一张凭证在投递途中");
    assert.equal(runs.claimTurn(id, "single"), true);
    // Codex 的句柄没有 beforeSend 那一跳 —— 成功送达之后不会再清一次（那是有意的：ACK 之后
    // 旧工作仍可能合法写入这几列，无条件再清会误删）。
    const handle = { kill: () => {}, steer: async () => {} };
    runs.trackRun(id, handle);
    runs.bindNativeSteer(id, handle, { agentType: "codex", record: () => {} });
    assert.equal((await steer.steerQueuedMessage(`m-${id}`)).ok, true, "新方向照常送达");

    assert.equal(
      await restoreResumePrompt(id, inflight), false,
      "改派作废了旧方向的检查点意图 ⇒ 在路上那一段填不回来（否则它会落到新方向头上）",
    );
    assert.equal((await taskRow(id)).resumePrompt, null, "新方向头上不许凭空多出一段旧交代");
    runs.untrackRun(id, handle);
    runs.releaseTurn(id);
  }

  // ── ④ 旧方向**真的**迟到写了一段，清场把它作废掉（代次因此真的被我们推走）───────────
  //
  // 这一支是 ③ 的另一面：代次确实变了，但推它的仍然是这条改派自己。所以清场每一步都把结果
  // 记回快照，回滚问的永远是「还是我离开时那一代吗」—— 否则这里又会把三样一起丢掉（F1-C）。
  {
    const id = "late-checkpoint-discarded";
    await seed(id, { generation: 2 });
    assert.equal(runs.claimTurn(id, "single"), true);
    const handle = {
      kill: () => {},
      steer: async (_text: unknown, beforeSend?: () => void | Promise<void>) => {
        // 旧方向那一边发出的 pause 这一刻才落库（清场已经跑过一遍，所以槽这会儿是空的）。
        await db.update(tasks)
          .set({ resumePrompt: "旧方向迟到写下的检查点", resumePromptAuto: false })
          .where(eq(tasks.id, id));
        await beforeSend?.(); // 清场把它作废掉：真的清了东西 ⇒ 代次 +1
        throw new Error("注入：新正文没写进去");
      },
    };
    runs.trackRun(id, handle);
    runs.bindNativeSteer(id, handle, { agentType: "claude", record: () => {} });
    assert.equal((await steer.steerQueuedMessage(`m-${id}`)).ok, false);

    const after = await taskRow(id);
    assert.equal(
      after.resumePrompt, "主动暂停：保留待续工作",
      "作废迟到那一段推走的代次是**我们自己**推的 ⇒ 原来那段待续工作照样回得来（F1-C）",
    );
    assert.equal(after.question, "保留旧问题");
    assert.equal(after.completeConfirmedAt, "2026-10-20T08:00:00.000Z");
    runs.untrackRun(id, handle);
    runs.releaseTurn(id);
  }

  // ── ⑤ **Codex 送达失败**：这条路上只有一次清场，所以首次清场推走的代次也必须记回快照 ────
  //
  // Claude 那条链在 ACK 之后还有第二次清场，它记回去的那一代会把第一次的疏漏盖过去 —— 于是
  // 「首次清场不记回」这个错在 Claude 路径上看不出来。Codex 没有那一跳，漏了就是整组丢失。
  {
    const id = "codex-send-fails";
    await seed(id, { generation: 7 });
    assert.equal(runs.claimTurn(id, "single"), true);
    const handle = {
      kill: () => {},
      steer: async () => { throw new Error("注入：Codex 这一程压根没送出去"); },
    };
    runs.trackRun(id, handle);
    runs.bindNativeSteer(id, handle, { agentType: "codex", record: () => {} });
    assert.equal((await steer.steerQueuedMessage(`m-${id}`)).ok, false);

    const after = await taskRow(id);
    assert.equal(after.resumePrompt, "主动暂停：保留待续工作", "那段待续工作必须回来");
    assert.equal(after.resumePromptAuto, false, "来源跟着文字一起回来");
    assert.equal(after.question, "保留旧问题");
    assert.equal(after.completeConfirmedAt, "2026-10-20T08:00:00.000Z");
    runs.untrackRun(id, handle);
    runs.releaseTurn(id);
  }

  // ── ⑥ 清场**取快照和落笔之间**，真人写下一段一模一样的主动暂停 ───────────────────────
  //
  // 第 4 轮审查 F1-A 实测（`F1_A_SAME_TEXT_NEW_OCCUPANCY_LOST`）：那一格原来挂着系统替它写下
  // 的等待，清场的 SELECT 读到了「这段文字 + 系统来源 + 第 1 次占用」；UPDATE 还没发出去，真人
  // 带着有效回合和方向身份走 `/pause` 原样写下同一句话（来源改成主动、代次 +1）。清场只比文字
  // 的话照样命中，于是快照带走的是**旧来源配新代次**：发送失败回滚把这段文字填回去、来源写成
  // 「系统等待」，紧接着完成闸放行时 `clearAutoCheckpoint` 就把真人刚留下的主动暂停删了。
  //
  // 修法是「清场也得证明自己拿到的是同一次占用」，所以这里正确的结果是**整笔改派被拒**：一个
  // 字都别动，让这一趟重来。
  {
    const id = "same-text-new-occupancy";
    const text = "继续：同一句交代";
    await seed(id, { generation: 1, auto: true, resumePrompt: text });
    assert.equal(runs.claimTurn(id, "single"), true);
    const { clearAutoCheckpoint, occupyResumePrompt } = await import("../src/task-resume-prompt.js");

    // 窗口切在生产代码的两步之间：清场读完那一格、那一笔 UPDATE 还没发出去。按语句形状认它，
    // 而且只拦一次 —— 注入自己也要走这个 client，所以先还原再写。
    const realExecute = dbClient.execute.bind(dbClient);
    let injected = false;
    (dbClient as { execute: unknown }).execute = async (stmt: never) => {
      const statement: string = typeof stmt === "string" ? stmt : (stmt as { sql: string }).sql;
      if (!injected && /update "tasks" set/i.test(statement) && /resume_prompt_generation/.test(statement)) {
        injected = true;
        (dbClient as { execute: unknown }).execute = realExecute;
        // 生产 `/pause` 走的就是这个 writer 和这组身份条件（task-run-routes.ts）。
        assert.ok(
          await occupyResumePrompt(id, text, false, [
            eq(tasks.status, "running"),
            eq(tasks.activeTurnToken, `${id}-turn`),
            eq(tasks.activeDirectionToken, `${id}-dir`),
          ]),
          "台子前提：这一刻真人的暂停是合法的（回合、方向身份都还对得上）",
        );
      }
      return realExecute(stmt);
    };
    const handle = { kill: () => {}, steer: async () => { throw new Error("注入：不该走到这一步"); } };
    runs.trackRun(id, handle);
    runs.bindNativeSteer(id, handle, { agentType: "codex", record: () => {} });
    const result = await steer.steerQueuedMessage(`m-${id}`);
    (dbClient as { execute: unknown }).execute = realExecute;
    assert.equal(injected, true, "台子前提：真的切在清场的读与写之间");
    assert.equal(result.ok, false, "那一格已经换了一次占用 ⇒ 这一趟改派必须被拒，而不是带走错配的凭证");

    const after = await taskRow(id);
    assert.equal(after.resumePrompt, text, "真人刚写下的那一段必须还在");
    assert.equal(after.resumePromptAuto, false, "而且还是**主动**暂停 —— 上一版会把它洗成系统等待");
    assert.equal(after.resumePromptGeneration, 2, "代次停在真人那一次占用上（清场一行都没改）");
    assert.equal(after.question, "保留旧问题", "清场落空 ⇒ 提问和完成票一个字都没动");
    assert.equal(after.completeConfirmedAt, "2026-10-20T08:00:00.000Z");
    assert.equal(
      await clearAutoCheckpoint(id), false,
      "来源没被洗掉 ⇒ 完成闸放行时这段主动暂停不会被当成系统等待删掉（F1-A 的实际伤害）",
    );
    assert.equal((await taskRow(id)).resumePrompt, text, "删不掉，原文还在");
    assert.equal((await msgRow(id)).status, "pending", "改派被拒 ⇒ 那条消息退回队列继续排着，不是悄悄丢掉");
    runs.untrackRun(id, handle);
    runs.releaseTurn(id);
  }

  // ── 旧改派的**迟到回滚**：它分得清「我离开时那一轮」和「后来又跑完的另一轮」吗 ──────────
  //
  // 第 4 轮审查 F1-B。两条备用回滚分支（`restorePreviousDirectionState` 精确 CAS 落空后的那一
  // 支、`restorePreviousCompletionState`）原来只问「非 running/queued + 活动回合为空 + 提问和
  // 完成确认为空」。而 `status.ts` 一离开运行态**本来就会**把 token 置 null、方向版本归零 ——
  // 于是「现在空着」同时对应两个世界：我清掉的那一轮刚结束（回滚该落地），和那之后又完整跑完
  // 了一轮新工作（回滚是迟到者）。实测后者被当成前者，旧提问和旧完成确认被写回一个早已交完新
  // 工作的任务（`F1_B_LATE_ROLLBACK_AFTER_NEW_DIRECTION_DONE` /
  // `F1_B_COMPLETION_FALLBACK_SAME_CLASS`）。
  //
  // 现在任务行上多一列永不归零的方向世代（`tasks.direction_epoch`）：回合起跑和方向轮换各 +1，
  // 任何状态落位都不许碰它。回滚问的是「还是我离开时那一代吗」。

  /** 一个**完整跑完的新回合**：起跑写下自己的方向身份（世代 +1），跑完落终态（三列身份清空）。 */
  const runFreshTurn = async (taskId: string): Promise<void> => {
    // 起跑那一笔跟 task-run.ts / orchestrator.ts 是同一个 patch（`turnDirectionStart`）——
    // 世代这一列的写入口只有那一个，所以这里不是在仿造一个形状，而是在跑同一段代码。
    // 新回合同样把上一轮残留的完成确认清掉（生产那两处也在同一笔里做这件事）。
    await db
      .update(tasks)
      .set({
        completeConfirmedAt: null,
        ...epoch.turnDirectionStart(util.id(), util.id()),
        updatedAt: util.now(),
      })
      .where(eq(tasks.id, taskId));
    await status.setTaskStatus(taskId, "running");
    await status.setTaskStatus(taskId, "done");
  };

  // ── ⑦ 正向控制：回合结束了，但**没有**新回合插进来 ⇒ 两条备用分支照旧恢复 ───────────────
  //
  // 这一条和下面两条必须同时成立，否则修法就是把备用分支整条拆掉：改派正常失败时回滚本来就
  // 可能撞上「旧回合已经按停止/自然结束结算完」，那时三列身份全是空的，只能靠世代放行。
  {
    const id = "ended-turn-no-new-work";
    await seed(id);
    await db.update(scheduledMessages).set({ status: "canceled" }).where(eq(scheduledMessages.taskId, id));
    const previous = await directionState.clearPreviousDirectionState(id, false);
    await status.setTaskStatus(id, "done"); // 旧回合按自然结束结算：token 清空、版本归零
    assert.equal(
      await directionState.restorePreviousDirectionState(id, previous), true,
      "没有新方向开过工 ⇒ 备用分支照旧放行（闸不能收得连自己都回不去）",
    );
    const after = await taskRow(id);
    assert.equal(after.question, "保留旧问题", "用户的问题回得来");
    assert.deepEqual(JSON.parse(after.questionOptions ?? "null"), ["甲", "乙"]);
    assert.equal(after.completeConfirmedAt, "2026-10-20T08:00:00.000Z", "完成确认回得来");
    assert.equal(after.resumePrompt, "主动暂停：保留待续工作", "那段待续工作也回得来");
  }
  /**
   * `restorePreviousCompletionState` 的生产前置（`finishStoppedSteer`）：先把方向状态放回去，
   * 结算再把那张完成票消费掉 —— 它补的就是结算消费之后留下的那个空。单独调它而不摆出这个
   * 前置的话，整笔会被「旧提问对不上」挡在门外，验不到世代那一条。
   */
  const settleConsumesCompletion = async (taskId: string): Promise<void> => {
    await db
      .update(tasks)
      .set({ completeConfirmedAt: null, updatedAt: util.now() })
      .where(eq(tasks.id, taskId));
  };

  {
    // `restorePreviousCompletionState` 的正向控制（停止抢在引导前面落地那一支：结算已经跑完，
    // 只剩这一张票要补）。不挂检查点，把它和检查点那张票的判据分开看。
    const id = "ended-turn-completion-back";
    await seed(id, { resumePrompt: null });
    await db.update(scheduledMessages).set({ status: "canceled" }).where(eq(scheduledMessages.taskId, id));
    const previous = await directionState.clearPreviousDirectionState(id, false);
    await status.setTaskStatus(id, "done");
    await directionState.restorePreviousDirectionState(id, previous);
    await settleConsumesCompletion(id);
    await directionState.restorePreviousCompletionState(id, previous);
    assert.equal(
      (await taskRow(id)).completeConfirmedAt, "2026-10-20T08:00:00.000Z",
      "没有新回合插进来 ⇒ 那张完成票补得回去",
    );
  }

  // ── ⑧ 迟到回滚撞上一个**已经跑完并结束**的新回合 ⇒ 旧提问不许回来（F1-B）────────────────
  //
  // 只验提问那张票：检查点有它自己的代次闸（真实链路上由结算的 `resumePromptVoidPatch` 作废），
  // 三张票各判资格是第 3 轮 F1-C 的结论，这里不把它们重新搅在一起。
  {
    const id = "late-rollback-after-new-turn";
    await seed(id, { resumePrompt: null });
    await db.update(scheduledMessages).set({ status: "canceled" }).where(eq(scheduledMessages.taskId, id));
    const previous = await directionState.clearPreviousDirectionState(id, false);
    await status.setTaskStatus(id, "done"); // 旧回合结束：三列身份被清空
    await runFreshTurn(id);                 // 这中间任务又完整跑完了一轮新工作
    const before = await taskRow(id);
    assert.deepEqual(
      [before.question, before.completeConfirmedAt, before.activeTurnToken], [null, null, null],
      "台子前提：新回合跑完之后，这几列跟「我刚清掉、还没人动过」长得一模一样",
    );

    await directionState.restorePreviousDirectionState(id, previous);
    const after = await taskRow(id);
    assert.equal(
      after.question, null,
      "新工作都交完了，旧方向的问题不许凭一个空位冒出来 —— 用户会对着一个早就过去的问题作答（F1-B）",
    );
    assert.equal(after.questionOptions, null, "候选同上");
    assert.equal(
      after.completeConfirmedAt, null,
      "同一笔里的完成票也一样：它会被下一次结算当成这一轮交了卷",
    );
  }

  // ── ⑨ 同一时序下的 `restorePreviousCompletionState` ⇒ 旧完成确认不许回来（F1-B）──────────
  //
  // 它天生只有备用分支那一种形态（回合已经结束，token 必然是 null），所以世代是它**唯一**的
  // 归属判据 —— 比空活动回合和旧正文/提问，一个跑完新回合的任务照样全都对得上。
  {
    const id = "late-completion-after-new-turn";
    await seed(id, { resumePrompt: null });
    await db.update(scheduledMessages).set({ status: "canceled" }).where(eq(scheduledMessages.taskId, id));
    const previous = await directionState.clearPreviousDirectionState(id, false);
    await status.setTaskStatus(id, "done");
    await directionState.restorePreviousDirectionState(id, previous);
    await settleConsumesCompletion(id);
    await runFreshTurn(id); // 这中间任务又完整跑完了一轮新工作
    const before = await taskRow(id);
    assert.deepEqual(
      [before.activeTurnToken, before.completeConfirmedAt, before.question],
      [null, null, "保留旧问题"],
      "台子前提：除了世代，这一笔的每一条资格（空活动回合、空完成确认、旧提问原样）都对得上",
    );

    await directionState.restorePreviousCompletionState(id, previous);
    assert.equal(
      (await taskRow(id)).completeConfirmedAt, null,
      "迟到的那张完成票落不进来 —— 否则这个任务会凭一轮早就结束的工作被记成已交卷（F1-B）",
    );
  }

  // ── ⑩ 结构锁：**方向身份这四列的写入口只有 task-direction-epoch.ts** ──────────────────────
  //
  // 上面三条钉得住现在这几个调用点，而这道闸能被绕开的方式有两种：某处自己 `.set` 世代那一列
  // 或把它置回某个值（`status.ts` 清身份时就差点连它一起清），以及 —— 更隐蔽的那种 —— 某处把
  // `turnDirectionStart(…)` **展开回「只写三列身份」的样子**，世代就此不再前进。后者只盯
  // `directionEpoch` 的检查一个字都发现不了：实测把两处生产起跑各自展开，上面那些用例照样
  // 全绿（第 1 轮审查 N2）。所以锁的是整组身份 —— 装新方向 / 清身份 / 回滚放回，三种写法都
  // 在那一个文件里，谁在自己那边拼这四列中的任何一列就红。
  //
  // 这正是 `task-resume-prompt.ts` 那一列学过三次的同一课（第 3 轮审查 F1：代次只有在所有
  // writer 都维护它时才是归属凭证）。已知边界：`const patch = {…}` 先攒好再 `.set(patch)` 的
  // 写法两条规则都看不见 —— 现有代码里没有这种形状，真要加也该先问问为什么不走 writer。
  {
    // 取本机路径只能走 `fileURLToPath`：`URL.pathname` 是百分号编码的 URL 路径，仓库目录名里
    // 有空格时它给的是 `%20`，结构锁会在那种检出上「悄悄通不了」（第 4 轮审查 N2）。
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
      if (file.endsWith("task-direction-epoch.ts")) continue; // 存储层本身
      const src = readFileSync(file, "utf8");
      // (a) `update(tasks)` 的 `.set({…})` 字面量里直写这四列中的任何一列
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
        if (/\b(directionEpoch|activeTurnToken|activeDirectionToken|activeDirectionVersion)\s*:/.test(block)) {
          offenders.push(`${file.slice(srcDir.length)}：${block.replace(/\s+/g, " ").slice(0, 90)}`);
        }
      }
      // (b) 先攒 patch 对象再 `.set(patch)` 的那种写法（`status.ts` 原来就是这个形状）——
      //     归零一次就等于把这道闸整条废掉，而它不会出现在任何 `.set({…})` 字面量里。
      for (const m of src.matchAll(
        /\.(directionEpoch|activeTurnToken|activeDirectionToken|activeDirectionVersion)\s*=[^=]/g,
      )) {
        offenders.push(`${file.slice(srcDir.length)}：${src.slice(m.index, m.index + 60).split("\n")[0]}`);
      }
    }
    assert.deepEqual(
      offenders, [],
      "方向身份这四列只许由 task-direction-epoch.ts 写（用它导出的三个 patch）——自己拼一组"
      + "身份就会漏掉世代那一笔，迟到的回滚于是又分不清「我那一轮」和「后来那一轮」了："
      + `\n${offenders.join("\n")}`,
    );
  }

  console.log(
    "✓ 原生引导发送失败后的回滚：ACK 后清场不挡自己的回滚（检查点/提问/完成票三样都回来）"
    + " / 期间真有新占用时只有检查点过期 / 在路上的旧交代填不回新方向 / 作废迟到那一段之后照样回得去"
    + " / Codex 那条只有一次清场的链同样回得去 / 取快照和落笔之间换了占用时整笔改派被拒（真人的主动暂停不被洗成系统等待）"
    + " / 回合结束但没有新工作插进来时两条备用分支照旧放行"
    + " / 这中间又完整跑完一轮新回合时迟到的旧提问和旧完成确认都落不进来（方向世代，写入口上了结构锁）",
  );
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
