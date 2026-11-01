// 「上游停滞」那个**持久标记**的生命周期:置上、撤掉、按停滞身份比对、以及开始边界的清理。
// 跑:npm -w server run test:stall-flag
//
// 判据与两档动手在 `src/turn-stall.ts`(纯状态机,由 test-turn-stall.ts 钉);这里钉的是另一半
// —— 那个结论落进库之后**活多久**。三件事,三轮审查各实测出一件:
//   ① **熔断掉的回合会在下一轮复活**:读侧的 EXISTS 本来靠 `ended_at IS NULL` 把陈旧值挡在
//      外面,可下一轮复用同一行时 `resumedTurnFields` 正好把 `ended_at` 清成 null —— 上一轮
//      留下的标记当场又亮起来。页面上一边是正常答完的新回合、一边亮着红色停滞环,刷新还在。
//   ② **写入没有身份比对**:换台/摘牌之后旧台那个计时器还可能醒一次,拿 sessionId 直接写就会
//      把旧台的结论落在新台正在答的那一轮上,或者反过来把新台的标记撤掉。
//   ③ **「最近一次投入」不是「此刻在执行」**:常驻台用户插话时行上的 `turn_started_at` 当场
//      变成 T2,可执行器真在跑的仍是队首 T1。按回合身份做 CAS 的那一版于是让「补一句话」清掉
//      了一个仍然有效的警告(第 3 轮审查 F2)。现在标记按**停滞自己那一刻**(`since`)认人,
//      ②那一条改由所有权层挡(`lead.retired`,见 team/lead-voice.ts)。
//   ④ **换执行器重试会新建一条会话行**,旧行一个字不动(第 5 轮审查 F5)。①修的是「复用同一
//      行」那条路,这一条是另一条:新会话正常输出只撤得掉自己那一行的标记(撤按停滞身份认人),
//      而旧行跟着新任务的 running 一起又让那颗点亮起来 —— 一直亮到下一次有人恰好清了旧行。
//      所以读侧的 EXISTS 还得再要一条:那条会话得是**此刻这一轮用的那条**。同一个生命周期缺口
//      在「没有进程可接管」的结束边界上也有一半:置标记的消费者早就没了,没人来撤
//      (`clearTaskStallFlags`,由启动对账调)。
//   ⑤ **④那道闸的判据一开始错了**(第 1 轮审查 F3,已实测):它问的是「这个任务里还有没有起得
//      更晚的会话」,而 duet 的两个声部**本来就并行**。于是 A 卡着、B 这一轮先答完,A 那个仍然
//      有效的警告被 B 的时间戳盖掉 —— 恰恰是「上游连不上」最该亮的那段时间里一声不响。
//      所有权在 ash 里从来是 `sessions.role` 说的(每个角色至多一条在跑),不是时间先后,所以
//      那道闸必须限定在**同一个角色**内比。duet 的 voiceA / voiceB 因此互不遮蔽,而④那条
//      「换执行器另起一条 single」照旧被挡住。
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
const {
  clearSessionStalled, clearTaskStallFlags, markSessionStalled,
} = await import("../src/session-stall-flag.js");
const { resumedTurnFields } = await import("../src/session-turns.js");
const { enrichTasks } = await import("../src/task-store.js");

const TASK = "task-stall-flag";
const SESS = "sess-stall-flag";
const T1 = "2026-10-30T07:36:21.000Z";
const T2 = "2026-10-30T08:10:00.000Z";
const SINCE = "2026-10-30T07:40:00.000Z";
const OTHER_SINCE = "2026-10-30T08:40:00.000Z";

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
markSessionStalled(TASK, SESS, SINCE);
await settles(SINCE, "停滞标记没写进库");
assert.equal(await stalled(), true, "标记在库里却没出现在任务行上 —— 卡片上看不出它在干等");
clearSessionStalled(TASK, SESS, SINCE);
await settles(null, "停滞标记没撤掉");
assert.equal(await stalled(), false, "标记撤了,任务行上那颗点还亮着");

// ── ② 身份比对:只有置上它的那一次停滞撤得动它 ─────────────────────────────────
// 原来这道闸比的是会话行上的回合起点,那把「最近一次投入」当成了「此刻在执行」(见文件头③)。
// 现在比的是停滞自己那一刻:别人的那一次(新台、下一轮)值不一样,一个字都碰不到。
markSessionStalled(TASK, SESS, SINCE);
await settles(SINCE, "本轮的写入没落地");
clearSessionStalled(TASK, SESS, OTHER_SINCE); // 另一次停滞,撤不动这一次的
await new Promise((r) => { setTimeout(r, 150); });
assert.equal(await flag(), SINCE, "别的那次停滞撤得动这一次的标记 —— 新台会被旧台抹掉状态");
clearSessionStalled(TASK, SESS, SINCE);
await settles(null, "置上它的那一次也撤不掉了");

// 置上**不再**比对行上的回合起点:插话之后行上写的是 T2,而真在跑、真卡着的是队首 T1 ——
// 那一笔报警必须落得进去(第 3 轮审查 F2:旧版 CAS 把它挡了,于是干等几十分钟一声不响)。
await db.update(sessions).set({ turnStartedAt: T2 }).where(eq(sessions.id, SESS));
markSessionStalled(TASK, SESS, SINCE);
await settles(SINCE, "行上换了起点,正在执行的那一轮就报不了警了");
clearSessionStalled(TASK, SESS, SINCE);
await settles(null, "撤不掉");
await db.update(sessions).set({ turnStartedAt: T1 }).where(eq(sessions.id, SESS));
markSessionStalled(TASK, SESS, SINCE);
await settles(SINCE, "夹具不对:这一步之后标记该是在的");

// ── ③ 残值闸:会话收了尾 / 任务不在跑,那颗点都不许亮 ─────────────────────────────
// ash 被硬杀时没人来撤标记,少了这两条它会永久亮在卡片上。
await db.update(sessions).set({ endedAt: T2 }).where(eq(sessions.id, SESS));
assert.equal(await stalled(), false, "会话都收尾了,停滞点还亮着");
await db.update(sessions).set({ endedAt: null }).where(eq(sessions.id, SESS));
assert.equal(await stalled(), true, "夹具不对:会话重新算在跑了,点应该回来");
await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, TASK));
assert.equal(await stalled(), false, "任务已经不在跑了,停滞点还亮着");
await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, TASK));

// ── ④ 开始边界:真开跑一轮就翻篇,**只排在后面**则一个字不动 ─────────────────────
// 前半是第 1 轮审查第 3 条的要害 —— 熔断那一路即使一个字都没撤(进程直接没了、没人来调
// clearSessionStalled),也不能让标记活到下一轮:`resumedTurnFields` 把 `ended_at` 清成 null
// 的同一批里就得把它清掉,否则读侧的残值闸恰好在这一刻失效。
assert.equal(await flag(), SINCE, "夹具不对:这一步之前标记该是在的");
await db.update(sessions).set({ ...resumedTurnFields(T2) }).where(eq(sessions.id, SESS));
assert.equal(await flag(), null, "新回合开起来了,上一轮的停滞标记还在 —— 它会在新回合上复活");
assert.equal(await stalled(), false, "新回合的卡片上还亮着上一轮的停滞点(刷新也还在)");

// 后半是第 3 轮审查 F2:**投入 ≠ 切换正在执行的回合**。常驻台用户插话时 `sendToLead` 当场
// 持有 T2、`beginTurn(T2)` 随即刷这一批字段,可队首 T1 还在执行器手里重连。那种情形只刷「这条
// 会话还在跑」那几列,停滞标记一个字不许动 —— 补一句话既不是恢复也不是回合结束,清掉它等于
// 让一个仍然有效的警告凭空消失,而且之后不会再报第二次。
markSessionStalled(TASK, SESS, SINCE);
await settles(SINCE, "夹具不对:这一步之前标记该是在的");
await db.update(sessions).set({ ...resumedTurnFields(T2, { queuedBehind: true }) }).where(eq(sessions.id, SESS));
assert.equal(await flag(), SINCE, "补一句话就把仍在重连的停滞警告清掉了(刷新也不回来)");
assert.equal(await stalled(), true, "排在后面的那一轮把正在执行那一轮的停滞点灭了");
// 那一轮真结束时照旧撤得掉:撤按停滞身份认人,不看行上此刻写的是哪一轮。
clearSessionStalled(TASK, SESS, SINCE);
await settles(null, "行上换了起点之后,正在执行那一轮的标记就撤不掉了");

// ── ⑤ 换轮之后,新回合的标记按新身份正常工作 ─────────────────────────────────────
markSessionStalled(TASK, SESS, OTHER_SINCE);
await settles(OTHER_SINCE, "换轮之后新回合的标记写不进去了");
assert.equal(await stalled(), true, "新回合自己卡住了,点却不亮");

// ── ⑥ 另起一条会话:旧行上的标记不许再代表这个任务(第 5 轮审查 F5) ──────────────
// 换执行器重试、或者旧执行器不能复用时走的是**新建会话行**(task-run.ts / orchestrator.ts),
// 旧行一个字不动 —— 上面④的前半(`resumedTurnFields`)压根不经过。于是旧行仍然「标记非空、
// 没收尾」,任务又是 running,那颗点就凭空亮回来了。
const NEWER = "sess-stall-flag-2";
await db.insert(sessions).values({
  id: NEWER, taskId: TASK, role: "single", agentType: "claude", executor: "claude",
  startedAt: OTHER_SINCE, turnStartedAt: OTHER_SINCE,
});
assert.equal(await flag(), OTHER_SINCE, "夹具不对:旧行上的标记该还在");
assert.equal(await stalled(), false,
  "换了执行器另起一条会话,旧行上那个没人撤的标记还在给任务点灯 —— 用户看到的是一个凭空亮起的红环");
// 新会话自己卡住了当然要亮:这道闸挡的是「不是此刻这一轮的那条会话」,不是「有两条会话」。
markSessionStalled(TASK, NEWER, OTHER_SINCE);
for (let i = 0; i < 100 && !(await stalled()); i += 1) await new Promise((r) => { setTimeout(r, 10); });
assert.equal(await stalled(), true, "此刻这一轮自己卡住了,点却不亮");

// ── ⑦ 不接管的那道结束边界:没人来撤,就由对账整个任务清一遍 ──────────────────────
// 那条消费链连进程都没了(没活到接管),CAS 要的那个 `since` 没有任何人握着,所以这里需要一个
// 不带身份的版本。安全性靠调用点:对账只处理「状态在飞、手上却没有活句柄」的任务,而且已经原子
// 预占了它的回合锁。
await clearTaskStallFlags(TASK);
assert.equal(await flag(), null, "旧行的标记没清掉");
assert.equal(
  (await db.select({ v: sessions.upstreamStalledSince }).from(sessions).where(eq(sessions.id, NEWER)))[0]!.v ?? null,
  null, "新行的标记没清掉 —— 这一路是整个任务收尾,不是只收一条会话",
);
assert.equal(await stalled(), false, "清完了点还亮着");

// ── ⑧ 并行的两个声部互不遮蔽:遮蔽按**角色**算,不按时间先后(第 1 轮审查 F3) ──────────
// 上面⑥那道闸原先问的是「这个任务里还有没有起得更晚的会话」。单飞链上「更晚」确实等于「换了
// 一条」—— 一个任务同一时刻只有一条 single 在跑。可 duet 不是:voiceA 和 voiceB 本来就并行,
// B 这一轮正常答完(甚至只是起得晚一点)就会把 A 那个仍然有效的警告盖掉。
const DUET = "task-duet-flag";
const VOICE_A = "sess-duet-a";
const VOICE_B = "sess-duet-b";
await db.insert(tasks).values({
  id: DUET, projectId: "proj-stall-flag", title: "两个声部并行", body: "", status: "running",
  mode: "duet", createdAt: T1, updatedAt: T1,
});
await db.insert(sessions).values([
  // A:还在跑(没收尾),上游连不上,标记已经置上。
  { id: VOICE_A, taskId: DUET, role: "voiceA", agentType: "codex", executor: "codex", startedAt: T1, turnStartedAt: T1 },
  // B:起得更晚,而且这一轮**已经收尾**了 —— 时间先后那一版判据正是被这种行盖掉的。
  { id: VOICE_B, taskId: DUET, role: "voiceB", agentType: "claude", executor: "claude", startedAt: T2, turnStartedAt: T2, endedAt: OTHER_SINCE },
]);
const duetStalled = async (): Promise<boolean> => {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, DUET));
  return (await enrichTasks([row!]))[0]!.upstreamStalled === true;
};
assert.equal(await duetStalled(), false, "夹具不对:还没置标记,点就亮了");
markSessionStalled(DUET, VOICE_A, SINCE);
for (let i = 0; i < 100 && !(await duetStalled()); i += 1) await new Promise((r) => { setTimeout(r, 10); });
assert.equal(await duetStalled(), true,
  "另一个声部起得更晚,就把这个声部仍然有效的停滞警告盖掉了 —— duet 的两个声部本来就并行,"
  + "遮蔽只能在同一个角色内算(所有权在 ash 里是 sessions.role 说的,不是时间先后)");
// 同一个角色内照旧遮蔽:A 这一轮收了尾、新开一条 voiceA,旧行那个没人撤的标记不许再点灯。
await db.insert(sessions).values({
  id: "sess-duet-a2", taskId: DUET, role: "voiceA", agentType: "codex", executor: "codex",
  startedAt: OTHER_SINCE, turnStartedAt: OTHER_SINCE,
});
assert.equal(await duetStalled(), false,
  "同一个声部另起了一条会话,旧行上那个没人撤的标记还在点灯 —— 限定角色之后这道闸不该失效");

console.log("test:stall-flag ok：标记按停滞身份认人,终止/开始/不接管三道边界都清,只认此刻这一轮,遮蔽按角色算(并行声部互不遮蔽)");
