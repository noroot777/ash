// 「上游停滞」那个**持久标记**的生命周期:置上、撤掉、按回合身份 CAS、以及开始边界的清理。
// 跑:npm -w server run test:stall-flag
//
// 判据与两档动手在 `src/turn-stall.ts`(纯状态机,由 test-turn-stall.ts 钉);这里钉的是另一半
// —— 那个结论落进库之后**活多久**。两件事都是第 1 轮审查实测出来的毛病:
//   ① **熔断掉的回合会在下一轮复活**:读侧的 EXISTS 本来靠 `ended_at IS NULL` 把陈旧值挡在
//      外面,可下一轮复用同一行时 `resumedTurnFields` 正好把 `ended_at` 清成 null —— 上一轮
//      留下的标记当场又亮起来。页面上一边是正常答完的新回合、一边亮着红色停滞环,刷新还在。
//   ② **写入没有回合身份 CAS**:换台/摘牌之后旧台那个计时器还可能醒一次(或者它的 UPDATE
//      还在飞),拿 sessionId 直接写就会把旧台的结论落在新台正在答的那一轮上。
//
// 库用临时文件(**绝不碰生产库**),所以 env 必须在 import 那些摸库的模块**之前**设好。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stage = mkdtempSync(join(tmpdir(), "ash-stall-flag-"));
process.env.ASH_DB = join(stage, "t.db");
process.env.HARNESS_DB = process.env.ASH_DB;

const { db, ensureSchema } = await import("../src/db/index.js");
await ensureSchema();
const { sessions, tasks } = await import("../src/db/schema.js");
const { eq } = await import("drizzle-orm");
const { clearSessionStalled, markSessionStalled } = await import("../src/session-stall-flag.js");
const { resumedTurnFields } = await import("../src/session-turns.js");
const { enrichTasks } = await import("../src/task-store.js");

const TASK = "task-stall-flag";
const SESS = "sess-stall-flag";
const T1 = "2026-10-30T07:36:21.000Z";
const T2 = "2026-10-30T08:10:00.000Z";
const SINCE = "2026-10-30T07:40:00.000Z";

await db.insert(tasks).values({
  id: TASK, projectId: "proj-stall-flag", title: "停滞标记", body: "", status: "running",
  createdAt: T1, updatedAt: T1,
});
await db.insert(sessions).values({
  id: SESS, taskId: TASK, role: "single", agentType: "codex", executor: "codex",
  startedAt: T1, turnStartedAt: T1,
});

/** 库里那一列此刻是什么。 */
const flag = async (): Promise<string | null> =>
  (await db.select({ v: sessions.upstreamStalledSince }).from(sessions).where(eq(sessions.id, SESS)))[0]!.v ?? null;

/** 读侧那个 EXISTS 投影 —— 卡片上那颗点看的就是它。 */
const stalled = async (): Promise<boolean> => {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, TASK));
  return (await enrichTasks([row!]))[0]!.upstreamStalled === true;
};

/**
 * `markSessionStalled` / `clearSessionStalled` 是「发出去就不管」的(写失败只记一句,不许掀翻
 * 正在收尾的回合),所以这里等库里真的变成期望值 —— 等不到就是没写进去。
 */
async function settles(want: string | null, what: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if ((await flag()) === want) return;
    await new Promise((r) => { setTimeout(r, 10); });
  }
  assert.fail(`${what}(库里仍是 ${JSON.stringify(await flag())},期望 ${JSON.stringify(want)})`);
}

// ── ① 置上就看得见,撤掉就灭 ──────────────────────────────────────────────────────
markSessionStalled(TASK, SESS, T1, SINCE);
await settles(SINCE, "停滞标记没写进库");
assert.equal(await stalled(), true, "标记在库里却没出现在任务行上 —— 卡片上看不出它在干等");
clearSessionStalled(TASK, SESS, T1);
await settles(null, "停滞标记没撤掉");
assert.equal(await stalled(), false, "标记撤了,任务行上那颗点还亮着");

// ── ② 回合身份 CAS:不是这一轮的写入一律不落地 ───────────────────────────────────
markSessionStalled(TASK, SESS, T2, SINCE); // 行上此刻是 T1,这一笔说的是 T2
await new Promise((r) => { setTimeout(r, 150); });
assert.equal(await flag(), null, "别的回合也写得进来 —— 旧台的结论会落在新台正在答的那一轮上");

markSessionStalled(TASK, SESS, T1, SINCE);
await settles(SINCE, "本轮的写入被 CAS 误伤了");
clearSessionStalled(TASK, SESS, T2); // 同理:不是这一轮,撤不动
await new Promise((r) => { setTimeout(r, 150); });
assert.equal(await flag(), SINCE, "别的回合撤得动这一轮的标记 —— 新台会被旧台抹掉状态");

// ── ③ 残值闸:会话收了尾 / 任务不在跑,那颗点都不许亮 ─────────────────────────────
// ash 被硬杀时没人来撤标记,少了这两条它会永久亮在卡片上。
await db.update(sessions).set({ endedAt: T2 }).where(eq(sessions.id, SESS));
assert.equal(await stalled(), false, "会话都收尾了,停滞点还亮着");
await db.update(sessions).set({ endedAt: null }).where(eq(sessions.id, SESS));
assert.equal(await stalled(), true, "夹具不对:会话重新算在跑了,点应该回来");
await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, TASK));
assert.equal(await stalled(), false, "任务已经不在跑了,停滞点还亮着");
await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, TASK));

// ── ④ 开始边界:下一轮复用同一行时,上一轮的标记必须跟着翻篇 ──────────────────────
// 这是第 1 轮审查第 3 条的要害 —— 熔断那一路即使一个字都没撤(进程直接没了、没人来调
// clearSessionStalled),也不能让标记活到下一轮。`resumedTurnFields` 把 `ended_at` 清成 null
// 的同一批里就得把它清掉,否则读侧的残值闸恰好在这一刻失效。
assert.equal(await flag(), SINCE, "夹具不对:这一步之前标记该是在的");
await db.update(sessions).set({ ...resumedTurnFields(T2) }).where(eq(sessions.id, SESS));
assert.equal(await flag(), null, "新回合开起来了,上一轮的停滞标记还在 —— 它会在新回合上复活");
assert.equal(await stalled(), false, "新回合的卡片上还亮着上一轮的停滞点(刷新也还在)");

// ── ⑤ 换轮之后,新回合的标记按新身份正常工作 ─────────────────────────────────────
markSessionStalled(TASK, SESS, T2, SINCE);
await settles(SINCE, "换轮之后新回合的标记写不进去了");
assert.equal(await stalled(), true, "新回合自己卡住了,点却不亮");

console.log("test:stall-flag ok：标记按回合身份 CAS,终止与开始两道边界都清,残值闸三条齐全");
