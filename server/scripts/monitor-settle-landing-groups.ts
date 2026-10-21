// 完成闸的**结算落位**那一半：一回合跑完时，`settleTaskStatus` 的每一支在落位之前该不该问
// 那道闸。判据只有一条，而且不是「交了卷没有」——**我这一笔会不会收走哨兵**
// （`monitorSweepingStatus`，跟终态清理、唤醒闸同源）。于是下面每一幕各钉一支：
//
//  · ⑱ 原生命令回合（`/compact`）正常收尾也是 done ⇒ 问（R2-1）；
//  · ⑲ 续聊回合里**没交卷**那一支要恢复的原状态本身是终态 ⇒ 问（R2-1）；
//  · ⑲b 恢复的原状态不是终态 ⇒ 不许问（问了只会白写一段系统等待）；
//  · ㉜ 新跑的回合没交卷就 exit 0 ⇒ 问（用户 2026-10-21 拍板：failed 跟 done 一样收走哨兵）；
//  · ㉜b 同一支、名下没有哨兵 ⇒ 照旧落 failed（闸不许顺手改掉正常路径）。
//
// ㉜ 还顺带钉住**掐断那条路**：落 paused 之后任务头上没有「停止」按钮（那个只给 running），
// 所以用户唯一的出路是哨兵卡片上那个停止键 —— 它落到服务端的那一层不许去看任务状态。
//
// 为什么跟 `test-monitor-complete-gate.ts` 分开：那份钉的是「什么情况下拦得住」，这一族钉的是
// 「哪几支落位之前该去问」。两份共用同一套台子（`monitor-complete-gate-harness.ts`），由那份
// 脚本按顺序驱动 —— 合在一个文件里会顶到单文件 700 行的约定（全局约定；
// `monitor-complete-checkpoint-groups.ts` 也是这条理由）。
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  db, insertMonitorRow, makeTask, monitorsBlockingComplete, monitorStatus, sessionWithTurn,
  settleTaskStatus, stopMonitorChecked, tasks, taskRow,
} from "./monitor-complete-gate-harness.js";

export async function settleLandingGroups(): Promise<void> {
  // ── ⑱ R2-1：原生命令回合（`/compact`）正常收尾也会收走哨兵 ⇒ 一样过闸 ────────────
  {
    const taskId = await makeTask();
    await sessionWithTurn(taskId, new Date(Date.now() - 60_000).toISOString());
    const monitorId = await insertMonitorRow(taskId, { command: "tail -F deploy.log" });
    await db.update(tasks).set({ nativeTurn: true }).where(eq(tasks.id, taskId));

    const settled = await settleTaskStatus(taskId, 0, null);
    assert.equal(settled.status, "paused", "压缩一次上下文不该顺手把哨兵停掉（R2-1）");
    assert.equal(settled.nativeTurn, true, "它仍然是原生回合：结算钩子照旧整段跳过");
    assert.equal(await monitorStatus(monitorId), "running");
  }

  // ── ⑲ R2-1：续聊回合**没交卷**那一支也过闸（恢复终态跟落终态是同一件事）──────────
  {
    const taskId = await makeTask();
    await sessionWithTurn(taskId, new Date(Date.now() - 60_000).toISOString());
    const monitorId = await insertMonitorRow(taskId, { command: "tail -F deploy.log" });
    await db.update(tasks).set({ followUpFrom: "done" }).where(eq(tasks.id, taskId));

    const settled = await settleTaskStatus(taskId, 0, null);
    assert.equal(settled.status, "paused", "恢复 done 会连坐停掉这一轮新挂的哨兵（R2-1）");
    assert.equal(await monitorStatus(monitorId), "running");
    assert.equal((await taskRow(taskId)).followUpFrom, null, "旁路身份要一起清掉");
  }

  // ── ⑲b 对称面：恢复的原状态**不是**终态时不许问闸（问了只会白写一段系统等待）────
  {
    const taskId = await makeTask();
    await sessionWithTurn(taskId, new Date(Date.now() - 60_000).toISOString());
    const monitorId = await insertMonitorRow(taskId, { command: "tail -F deploy.log" });
    await db.update(tasks).set({ followUpFrom: "paused" }).where(eq(tasks.id, taskId));

    const settled = await settleTaskStatus(taskId, 0, null);
    assert.equal(settled.status, "paused", "原样恢复它本来的 paused");
    assert.equal(
      (await taskRow(taskId)).resumePrompt, null,
      "这一笔不碰哨兵，所以不该留下任何系统等待",
    );
    assert.equal(await monitorStatus(monitorId), "running");
  }

  // ── ㉜ 新跑的回合**没交卷**就 exit 0 ⇒ 一样过闸（用户 2026-10-21 拍板）─────────────
  //
  // 上一版这一支压根不问闸：没交卷 → 直接 failed。而 failed 跟 done 对哨兵是同一件事（两个
  // 都在 `monitorSweepingStatus` 里）—— 哨兵被停掉、排着没送到的结果被作废。偏偏这正是最该
  // 留着它们的场合：人得靠那条结果判断要不要重试，agent 续跑也还在等它。
  {
    const taskId = await makeTask();
    await sessionWithTurn(taskId, new Date(Date.now() - 60_000).toISOString());
    const monitorId = await insertMonitorRow(taskId, { command: "tail -F deploy.log" });

    const settled = await settleTaskStatus(taskId, 0, null);
    assert.equal(settled.status, "paused", "没交卷也不许落 failed —— failed 照样收走哨兵");
    assert.equal(await monitorStatus(monitorId), "running", "那条哨兵必须活着");
    assert.ok((await taskRow(taskId)).resumePrompt, "要留下一段可恢复的等待，否则没人叫得醒它");
    assert.equal(settled.confirmedDone, false, "它确实没交卷，这一点不许被粉饰");
    // 这句话得同时交代「没交卷」和「不想等了点哪里」：少了前半句，这个 paused 会被读成
    // 「它干完了，只是在等哨兵」。
    assert.match(settled.note ?? "", /没有交卷/, "必须明说这一轮没交卷");
    assert.match(settled.note ?? "", /哨兵/, "必须说清是什么把终态拦下来的");
    assert.match(settled.note ?? "", /停掉/, "必须给出「不想等了」那条出路");

    // **那条出路必须真的走得通**（用户 2026-10-21 的验收条件）：这个落位不是 running，所以
    // 任务头上那个「停止」按钮此刻不在（它只给 running），能掐断的就只剩哨兵卡片上的那个。
    // 它落到服务端是 `stopMonitorChecked` —— 这一节钉住它**不看任务状态**：哪天有人在那边
    // 加一道「只有 running 才让停」，这个 paused 就会变成一个掐不断的等待。
    const stopped = await stopMonitorChecked(monitorId, "不等这个结果了");
    assert.equal(stopped.ok, true, `paused 的任务也必须停得掉它的哨兵：${stopped.ok ? "" : stopped.error}`);
    assert.equal(await monitorStatus(monitorId), "stopped");
    assert.equal(
      await monitorsBlockingComplete(taskId), null,
      "停掉之后这道闸就不该再拦着了 —— 用户这才能把任务收成他要的那个状态",
    );
  }

  // ── ㉜b 对称面：名下没有哨兵时，没交卷照旧落 failed（闸不许顺手改掉正常路径）────────
  {
    const taskId = await makeTask();
    await sessionWithTurn(taskId, new Date(Date.now() - 60_000).toISOString());

    const settled = await settleTaskStatus(taskId, 0, null);
    assert.equal(settled.status, "failed", "没有哨兵要护 ⇒ 没交卷仍然记未完成");
    assert.match(settled.note ?? "", /没有交卷/);
    assert.equal((await taskRow(taskId)).resumePrompt, null, "这一笔不碰哨兵，不许白写系统等待");
  }
}
