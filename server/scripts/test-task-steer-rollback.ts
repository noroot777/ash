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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-task-steer-rollback-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

const [{ db, dbClient, ensureSchema }, schema, runs, steer] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/runs.js"),
  import("../src/task-steer.js"),
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
  opts: { generation?: number; auto?: boolean; resumePrompt?: string } = {},
): Promise<void> {
  await db.insert(tasks).values({
    id, projectId: "p", title: id, body: "test", mode: "single", status: "running",
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", createdAt: at, updatedAt: at,
    activeTurnToken: `${id}-turn`, activeDirectionToken: `${id}-dir`, activeDirectionVersion: 1,
    completeConfirmedAt: "2026-10-20T08:00:00.000Z",
    resumePrompt: opts.resumePrompt ?? "主动暂停：保留待续工作", resumePromptAuto: opts.auto ?? false,
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

  console.log(
    "✓ 原生引导发送失败后的回滚：ACK 后清场不挡自己的回滚（检查点/提问/完成票三样都回来）"
    + " / 期间真有新占用时只有检查点过期 / 在路上的旧交代填不回新方向 / 作废迟到那一段之后照样回得去"
    + " / Codex 那条只有一次清场的链同样回得去 / 取快照和落笔之间换了占用时整笔改派被拒（真人的主动暂停不被洗成系统等待）",
  );
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
