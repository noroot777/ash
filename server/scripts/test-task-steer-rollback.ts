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

const [{ db, ensureSchema }, schema, runs, steer] = await Promise.all([
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

/**
 * 一条**正在跑、而且三样都挂着**的任务：那段检查点、一个待答的问题、一张已经确认的完成票。
 * 引导要先把这三样收起来；送不出去时它们必须回来。
 */
async function seed(id: string, opts: { generation: number } = { generation: 3 }): Promise<void> {
  await db.insert(tasks).values({
    id, projectId: "p", title: id, body: "test", mode: "single", status: "running",
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", createdAt: at, updatedAt: at,
    activeTurnToken: `${id}-turn`, activeDirectionToken: `${id}-dir`, activeDirectionVersion: 1,
    completeConfirmedAt: "2026-10-20T08:00:00.000Z",
    resumePrompt: "主动暂停：保留待续工作", resumePromptAuto: false,
    resumePromptGeneration: opts.generation,
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

  // ── ③ 清场那一步**什么都没清**时不许动代次（上面两条靠它才分得开）─────────────────
  {
    const id = "clear-nothing-no-bump";
    await seed(id, { generation: 5 });
    await db.update(tasks).set({ resumePrompt: null, resumePromptAuto: false }).where(eq(tasks.id, id));
    assert.equal(runs.claimTurn(id, "single"), true);
    const handle = {
      kill: () => {},
      steer: async (_text: unknown, beforeSend?: () => void | Promise<void>) => { await beforeSend?.(); },
    };
    runs.trackRun(id, handle);
    runs.bindNativeSteer(id, handle, { agentType: "claude", record: () => {} });
    assert.equal((await steer.steerQueuedMessage(`m-${id}`)).ok, true);
    assert.equal(
      (await taskRow(id)).resumePromptGeneration, 5,
      "一前一后两次清场都没东西可清 ⇒ 代次一个字都不许动（代次是「有过几次占用」，不是「被清过几次」）",
    );
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

  console.log(
    "✓ 原生引导发送失败后的回滚：ACK 后清场不挡自己的回滚（检查点/提问/完成票三样都回来）"
    + " / 期间真有新占用时只有检查点过期 / 没清掉东西就不推代次 / 作废迟到那一段之后照样回得去",
  );
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
