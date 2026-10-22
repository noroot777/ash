// 方向世代的**两个真实起跑入口**，以及完成票的**另一半**（内存那条快路）。
//
// 这一条单独成文件，因为 `test-task-steer-rollback.ts` 里那些用例都在存储层边界上打转：它们
// 直接调清场/回滚，起跑那一笔用的是 `turnDirectionStart()` 本身。于是两件事它看不见：
//
//  ① **生产起跑入口漏接 helper**。把 `task-run.ts` / `orchestrator.ts` 那一笔展开回「只写三列
//     身份」的样子，世代就此不再前进 —— 而那套用例照样全绿（第 1 轮审查 N2 实测）。结构锁现在
//     能按文本拦住它，但文本检查拦不住「调了 helper 却没落到库里」这一类，所以这里真跑一遍。
//  ② **内存那张完成票**。同一张票有 DB 和内存两个有效来源，settle 任一命中即算确认。DB 那一列
//     由每一次起跑清零，内存这条原来只按 taskId 存，没有任何东西把它绑在某一轮上：改派失败后
//     的回滚把它合法地还回来（那一刻没有新回合，还得对），任务接着又跑完一轮新工作 —— 这张旧
//     票被新一轮的结算吃掉，一轮从没交卷的工作显示「已完成」（第 1 轮审查 F1 实测
//     `sequential-direction-restore-then-fresh-run`，**不需要任何并发**）。
//
// 所以这里不设 `ASH_LAX_DONE`：严格完成协议下「没交卷 = failed」，一轮假 CLI 从头到尾不调
// complete_task，结果只要是 done 就说明有一张不属于它的票被消费了。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { eq } from "drizzle-orm";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-direction-epoch-entries-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_TEST_LEAD_LOG = join(root, "fake-input.jsonl");
// 这个用例就是要验证真实起跑/落盘/结算整条链，所以显式放行真进程（executors/spawn.ts）。
process.env.ASH_ALLOW_REAL_AGENT = "1";
delete process.env.ASH_LAX_DONE; // 台子前提：严格完成协议，没交卷就是 failed
requireTmpDb("task-direction-epoch-entries");

const { installFakeClaude } = await import("./scheduled-messages-fixture.js");
process.env.PATH = `${installFakeClaude(root)}${delimiter}${process.env.PATH ?? ""}`;

const [{ db, ensureSchema }, schema, tickets, directionState, { setTaskStatus }, { runTask }, { continueTask }] =
  await Promise.all([
    import("../src/db/index.js"),
    import("../src/db/schema.js"),
    import("../src/task-confirmation.js"),
    import("../src/task-steer-direction-state.js"),
    import("../src/status.js"),
    import("../src/task-run.js"),
    import("../src/orchestrator.js"),
  ]);
const { projects, tasks } = schema;
await ensureSchema();

const at = new Date().toISOString();
await db.insert(projects).values({ id: "p", name: "direction-epoch", repoPath: root, createdAt: at });

const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;
const epochOf = async (id: string): Promise<number> => (await row(id)).directionEpoch;

/** 一条正在跑、手里既有落库完成确认、也有内存那张票的任务。 */
async function seed(id: string, opts: { question?: string | null } = {}): Promise<void> {
  await db.insert(tasks).values({
    id, projectId: "p", title: id, body: "输出一行结果", mode: "single", status: "running",
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "claude", autoTitle: false,
    useWorktree: false, workflowMode: "free", createdAt: at, updatedAt: at,
    activeTurnToken: `${id}-turn`, activeDirectionToken: `${id}-dir`, activeDirectionVersion: 1,
    completeConfirmedAt: "2026-10-20T08:00:00.000Z",
    question: opts.question === undefined ? "旧方向留下的问题" : opts.question,
  });
  tickets.confirmDone(id, await epochOf(id));
}

try {
  // ── ① 台子前提：严格完成协议真的开着（这个假 CLI 从不交卷）────────────────────────────
  {
    const id = "strict-control";
    await seed(id, { question: null });
    tickets.revokeConfirmed(id); // 对照组手里不留任何票
    await db.update(tasks).set({ completeConfirmedAt: null }).where(eq(tasks.id, id));
    await setTaskStatus(id, "done");
    await runTask(id);
    assert.equal(
      (await row(id)).status, "failed",
      "台子前提：没交卷就该 failed —— 这一条不成立的话，下面几条「不许变 done」全是空的",
    );
  }

  // ── ② 两个**真实**起跑入口都把世代推上去（第 1 轮审查 N2）──────────────────────────────
  //
  // 结构锁按文本拦「自己拼一组身份」，这里按行为拦「跑完一轮之后世代到底动没动」。两处入口
  // 各一条：Claude 那条链上 fresh 与续跑走的是两段不同的代码，漏接一处另一处发现不了。
  for (const entry of ["fresh", "continue"] as const) {
    const id = `real-entry-${entry}`;
    await seed(id, { question: null });
    tickets.revokeConfirmed(id);
    await setTaskStatus(id, "done");
    const before = await epochOf(id);
    if (entry === "fresh") await runTask(id);
    else assert.equal(await continueTask(id, "再输出一行结果"), true, "台子前提：续跑真的起来了");
    const after = await row(id);
    assert.equal(after.activeTurnToken, null, "台子前提：这一轮真的跑完并结算了");
    assert.equal(
      after.directionEpoch, before + 1,
      `${entry} 起跑必须把方向世代推上去 —— 漏了的话，迟到的回滚就看不出这中间跑过一轮（N2）`,
    );
  }

  // ── ③ 合法回滚还回来的那张内存票，**不许被下一轮吃掉**（第 1 轮审查 F1）──────────────────
  //
  // 时序里没有任何并发：回滚发生时确实还没有新回合，所以它该成功；问题出在那之后 —— 新回合
  // 起跑只清掉 DB 那一列，内存这张票原来没人管，于是下一轮白捡一张完成确认。
  for (const via of ["direction", "completion"] as const) {
    const id = `stale-memory-${via}`;
    // 不挂提问：带着问题的任务结算会落 paused，那就验不到「交没交卷」这一格了。这一条要分的
    // 是 failed / done，所以现场里只留完成票这一张。
    await seed(id, { question: null });
    const previous = await directionState.clearPreviousDirectionState(id, false);
    assert.equal(
      tickets.revokeConfirmed(id), false,
      "台子前提：清场把内存那张票收进了快照（这一格此刻是空的）",
    );
    assert.equal(previous.memoryConfirmed, true, "台子前提：快照里记着那张票");
    await setTaskStatus(id, "done"); // 旧回合按自然结束结算

    if (via === "direction") await directionState.restorePreviousDirectionState(id, previous);
    else await directionState.restorePreviousCompletionState(id, previous);
    assert.equal(
      (await row(id)).completeConfirmedAt, "2026-10-20T08:00:00.000Z",
      "台子前提：这一刻还没有新回合，回滚本来就该成功（闸不能收得连自己都回不去）",
    );

    // 现在才开新一轮。假 CLI 全程不调 complete_task。
    await runTask(id);
    assert.equal(
      (await row(id)).status, "failed",
      "新一轮从没交卷 ⇒ 必须 failed。变成 done 就说明旧方向那张内存完成票串到了这一轮："
        + "界面上会显示「已完成」，而这一轮什么都没确认（F1）",
    );
    assert.equal(
      tickets.revokeConfirmed(id), false,
      "那张旧票也不许留在内存里等下一轮 —— 结算一律清空这一格，只是不认别代的",
    );
  }

  // ── ④ 反面：同一轮内还回来的票**照旧作数**（别把闸收得连自己都回不去）────────────────────
  {
    const id = "same-turn-memory-ticket";
    await seed(id, { question: null });
    const previous = await directionState.clearPreviousDirectionState(id, false);
    await directionState.restorePreviousDirectionState(id, previous);
    assert.equal(
      tickets.takeConfirmed(id, await epochOf(id)), true,
      "同一轮内（没有新回合插进来）还回来的那张票，对当下这一代仍然有效",
    );
  }

  console.log(
    "✓ 方向世代的真实入口与内存完成票：fresh/续跑两处生产起跑都把世代推上去；"
      + "合法回滚还回来的旧内存完成票不会被下一轮结算吃掉（严格协议下仍记 failed）；"
      + "同一轮内还回来的那张票照旧作数",
  );
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
