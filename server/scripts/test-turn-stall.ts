// 回合级停滞看门狗的两档判据,以及它**绝不该**动手的那几种形状。
// 跑:npm -w server run test:turn-stall
//
// 起因(2026-10-30,现场取证 data/runs/W54czudPJ9Q9/6ze45D4I2Bz_-…agent-out.jsonl):模型上游
// 所在的中转主机整体离线,codex 自己重连了 4 小时 45 分 —— 事件流里 216 条
// 「Reconnecting... waiting for network」全带 `willRetry:true`,被执行器静默丢掉,于是 ash
// 全程无报错、无超时,界面一直 running。本文件钉三件事:
//   ① 那种形状现在会按时限报警并熔断;
//   ② **正常的长回合一档都不许触发** —— 长思考、长工具调用期间同样一个事件都不发,判据
//      只能是「自上次上游真回话以来」,不能是回合总时长;
//   ③ 现场那条事件流的副本重放:旧判据一条事件都发不出来(全程无声),新判据 220 条。
//
// 阈值刻意做成**每次现读 env**(见 turn-stall.ts 的 thresholds),所以这里能在一个进程里分段
// 换口径;时间档用毫秒级阈值 + 真实 sleep 跑,连同那个共享计时器一起钉住(它才是「最后一条
// 错误之后再也没有事件」时唯一的出路)。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "@ash/shared";
import { codexErrorEvent } from "../src/executors/codex-error-event.js";
import { childActivity } from "../src/executors/native-agent-activity.js";
import {
  __resetTurnStalls,
  clearTurnStall,
  resumeTrippedTurn,
  trackTurnStall,
  type StallActions,
  type StallFacts,
} from "../src/turn-stall.js";
import { __resetStallFailures, clearStallFailure, markStallFailure, stallFailure } from "../src/turn-stall-verdict.js";
// 夹具与**解除条件那一组**分别住在 stall-fixtures.ts / test-turn-stall-progress.ts:这份文件
// 顶到过单文件上限,而「判据」和「两档动手」本来就是两件事(根 CLAUDE.md 的 700 行)。
import { configure, deferredSpy, hard, notice, RETRY, sleep, spy, TURN } from "./stall-fixtures.js";


// ── ① 警告档·条数路径:连续错误、期间上游一次都没真回话 ───────────────────────────
{
  configure({ warnErrors: 5 });
  const { actions, log } = spy();
  const owner = {};
  for (let i = 0; i < 4; i += 1) trackTurnStall("s1", owner, TURN, notice(), actions);
  assert.equal(log.warns.length, 0, "还没到阈值就报警了");
  trackTurnStall("s1", owner, TURN, notice(), actions);
  assert.equal(log.warns.length, 1, "连续 5 条重试提示没报警 —— 这正是现场那种形状");
  assert.equal(log.warns[0]!.facts.errors, 5);
  assert.equal(log.warns[0]!.facts.retries, 5);
  assert.equal(log.warns[0]!.facts.lastMessage, RETRY, "警告里要带最后一条错误的摘要");
  assert.match(log.warns[0]!.text, /全部是上游重试提示/, "全是重试时措辞不该说「其中 N 条」");
  assert.match(log.warns[0]!.text, /上游停滞/);
  // 一次停滞只报一次:重连能刷出几百条,报一条是提示,报几百条是刷屏。
  for (let i = 0; i < 20; i += 1) trackTurnStall("s1", owner, TURN, notice(), actions);
  assert.equal(log.warns.length, 1, "同一次停滞报了第二次警告");
  assert.equal(log.trips.length, 0, "熔断档关着还是动手了");

  // 上游真回话 = 停滞解除,报过警就得把卡片上那个标记撤掉。
  trackTurnStall("s1", owner, TURN, { kind: "text", text: "上游回来了，继续回答。" }, actions);
  // 撤那一笔**排在置那一笔确认落库之后**(见 ①c),所以这里要把那个微任务放掉再问。
  await sleep(0);
  assert.deepEqual(log.resolves, [TURN], "上游已经在吐正文了,卡片上那个停滞标记没撤");
  // 解除之后重新起算:下一轮重试要能再报一次(真的又挂了就得再说一声)。
  for (let i = 0; i < 5; i += 1) trackTurnStall("s1", owner, TURN, notice(), actions);
  assert.equal(log.warns.length, 2, "解除之后又挂了,第二次停滞不报警");
}

// ── ①b 「已经通知过」≠「持久状态已经确认」:投影失败要重投到确认(本轮审查 N1) ─────
// 从前这两件事挤在 `warn` 一个动作里,而 `warned` 在调用动作之前就置了 true —— 置标记那笔
// UPDATE 一次失败(I/O、权限、库忙)只写一行 console,之后再也没人重投。于是上游继续断着、
// 时间线上的警告也在,卡片却永远没有那颗红环:**通知是一次性的,投影是个要确认的状态**。
{
  configure({ warnErrors: 2, pollMs: 10 });
  const { actions, log } = spy("task-1", 2); // 前两次投影报失败
  const owner = {};
  for (let i = 0; i < 2; i += 1) trackTurnStall("s-proj", owner, TURN, notice(), actions);
  assert.equal(log.warns.length, 1, "没到警告档 —— 夹具不对");
  assert.equal(log.projects.length, 1, "报警那一刻没去投影");
  // 看门狗每一拍重投一次,直到投影自己说「落库了」。
  for (let i = 0; i < 60 && log.projects.length < 3; i += 1) await sleep(10);
  assert.ok(log.projects.length >= 3,
    `投影失败之后再也没人重投(只投了 ${log.projects.length} 次)—— 上游还断着,卡片上永远不会有红环`);
  assert.equal(log.warns.length, 1, "重投把用户看得见的那条警告也重发了 —— 那是刷屏");
  // 确认之后就停:幂等不等于可以每拍白写一次库。
  const settled = log.projects.length;
  await sleep(60);
  assert.equal(log.projects.length, settled, "投影已经确认落库了,看门狗还在一拍一笔地重投");
  assert.equal(log.projects[0]!.since, log.projects[settled - 1]!.since,
    "重投换了停滞身份 —— 那会写出一条撤不掉的标记(撤按 since 做 CAS)");
}

// ── ①c 撤标记必须排在置标记**之后**,而且用置上它的那个身份 ────────────────────
// 库那一侧撤是 CAS(`WHERE upstream_stalled_since = ?`,session-stall-flag.ts):顺序倒过来,
// 撤的那一笔一个字都碰不到,随后那笔 UPDATE 把红环永久留在卡片上。所以「置那一笔确认落库」
// 既是记下身份的时机,也是撤的前置条件 —— 回合在投影落定之前就收口的,由投影那一头补撤。
{
  configure({ warnErrors: 1 });
  const { actions, log, settleProjection } = deferredSpy();
  const owner = {};
  trackTurnStall("s1c", owner, TURN, notice(), actions);
  assert.equal(log.projects.length, 1, "报警那一刻没去投影");

  // 投影还悬着,这一轮就收口了。
  clearTurnStall("s1c", owner);
  await sleep(0);
  assert.deepEqual(log.resolves, [], "投影还没落库就先撤了 —— 那一笔 CAS 碰不到任何行,红环会留下来");

  await settleProjection();
  assert.deepEqual(log.resolves, [TURN], "投影落库之后没人补撤 —— 红环留在库里再也没人管");
  assert.deepEqual(log.resolveSince, [log.projects[0]!.since],
    "撤的时候换了停滞身份 —— 按 since 做的那道 CAS 一个字都碰不到");
}

// ── ②「只有错误事件」逐字成立:真故障也计入,notice 与否只影响措辞 ──────────────
{
  configure({ warnErrors: 3 });
  const { actions, log } = spy();
  const owner = {};
  trackTurnStall("s2", owner, TURN, hard("工具炸了"), actions);
  trackTurnStall("s2", owner, TURN, notice(), actions);
  trackTurnStall("s2", owner, TURN, hard("又炸了"), actions);
  assert.equal(log.warns.length, 1, "真故障不计入停滞 —— 每隔几分钟报一次真错、永不收尾的回合就逃掉了");
  assert.equal(log.warns[0]!.facts.errors, 3);
  assert.equal(log.warns[0]!.facts.retries, 1);
  assert.match(log.warns[0]!.text, /其中 1 条是上游重试提示/, "混着真故障时措辞要分开说");
}

// ── ④ 警告档·时间路径:最后一条错误之后再也没有事件了,靠计时器 ─────────────────
{
  configure({ warnMs: 60, pollMs: 15 });
  const { actions, log } = spy();
  trackTurnStall("s4", {}, TURN, notice(), actions);
  assert.equal(log.warns.length, 0, "一条错误刚到就按时间档报警了");
  await sleep(200);
  assert.equal(log.warns.length, 1, "时间档没靠计时器报出来 —— 事件驱动的那一版会在最后一条提示上永远停住");
  assert.ok(log.warns[0]!.facts.elapsedMs >= 60);
}

// ── ⑤ 熔断档:自动终止该回合,诊断齐全,之后不再重复动手 ──────────────────────────
{
  configure({ warnErrors: 1, tripMs: 120, pollMs: 15 });
  const { actions, log } = spy();
  const owner = {};
  trackTurnStall("s5", owner, TURN, notice(), actions);
  assert.equal(log.trips.length, 0, "还没到熔断时长就终止了回合");
  await sleep(300);
  assert.equal(log.trips.length, 1, "到了熔断时长没有自动终止回合");
  const text = log.trips[0]!;
  assert.match(text, /已自动终止本回合/);
  assert.match(text, /只收到错误事件/);
  assert.match(text, new RegExp(RETRY.slice(0, 12)), "诊断里没有最后一条错误");
  assert.match(text, /task-1/, "诊断里没有原始事件流的落点");
  assert.match(text, new RegExp(TURN), "诊断里没有本回合的起点");
  assert.match(text, /ASH_STALL_TRIP_MS/, "诊断里没写阈值怎么调");
  assert.match(text, /没有过任何正常事件/, "诊断里没说清卡在哪一步");
  assert.match(text, /重试续跑|换一个执行器/, "诊断里没写用户还能做什么");
  await sleep(100);
  assert.equal(log.trips.length, 1, "同一次停滞熔断了两次");
  // 熔断掉的那一轮**仍然留在表里**:熔断的成功条件是「这一轮真的结束」。回合真结束(收流走到
  // clearTurnStall)时才撤那个持久标记 —— 标记说的是「此刻正卡着」,回合都结束了它就该灭,
  // 持久可见的那份证据是时间线上的熔断诊断 + 任务落的失败态。
  //
  // 从前这里断言的正相反(熔断时就摘牌、之后不许再 resolve),而那样标记永远没人撤:下一轮
  // 复用同一行把 `ended_at` 清成 null,它当场复活 —— 页面上一边是正常答完的新回合、一边
  // 亮着红色停滞环,刷新还在(第 1 轮审查第 3 条,已实测)。
  clearTurnStall("s5", owner);
  assert.deepEqual(log.resolves, [TURN], "熔断掉的回合结束时没撤标记 —— 它会在下一轮复活");
}

// ── ⑤b 熔断必须把「这一轮失败」钉在回合身份上,让三处结算读得到 ──────────────────
{
  configure({ warnErrors: 1, tripMs: 60, pollMs: 15 });
  const { actions } = spy();
  const owner = {};
  trackTurnStall("s5b", owner, TURN, notice(), actions);
  assert.equal(stallFailure("s5b", TURN), null, "还没熔断就先判了失败");
  await sleep(320); // 扫表间隔有 200ms 下限(turn-stall.ts 的 pollMs),等够一拍
  // 这就是 span/会话/任务结算共同的判据(turn-stall-verdict.ts)。只靠退出码是不行的:
  // 被我们杀掉的 CLI 多半报不出非零 —— claude 走信号退出时写的是 `code ?? 0`,于是 0,
  // 于是时间线红着写「按失败结算」、任务却落 done(第 1 轮审查第 2 条)。
  const verdict = stallFailure("s5b", TURN);
  assert.ok(verdict, "熔断了却没把失败结论钉在回合身份上 —— 结算读不到,这一轮会落成功");
  assert.match(verdict.reason, /已自动终止本回合/, "钉下来的结论不是熔断那段诊断");
  assert.equal(stallFailure("s5b", "2026-10-30T09:00:00.000Z"), null, "把别的回合也判成失败了");
  assert.equal(stallFailure("other", TURN), null, "把别的会话也判成失败了");
}

// ── ⑤h 接管一个**上一个进程已经判了熔断**的回合:走同一条动手路径 ───────────────────
// 判决跨进程留下来了(落盘),**义务没有**:义务的语义全住在状态机那张表里。上一版在消费入口
// 手抄了「发一句诊断 + 杀一次」,于是这个回合在状态机里压根不存在 —— 下面三条一条都拿不到。
{
  // 扫表间隔有 200ms 下限(thresholds 的夹取),所以下面每一段都要等够一拍;宽限期特意放到
  // 700ms,免得「第二次熔断」和「宽限回收」挤在同一拍里分不清是哪一条在动。
  configure({ warnErrors: 1, tripMs: 60, graceMs: 700, pollMs: 15 });
  const { actions, log } = spy();
  const owner = {};
  const SINCE = "2026-10-30T07:30:00.000Z";
  resumeTrippedTurn("s5h", owner, TURN, { reason: "上次那段熔断诊断", at: SINCE, since: SINCE, durable: true }, actions);
  assert.equal(log.trips.length, 1, "接管后没有继续兑现终止义务");
  assert.match(log.trips[0]!, /接管后继续终止/, "没说清这是上次运行作出的判决");
  assert.match(log.trips[0]!, /上次那段熔断诊断/, "原判决原文没带上 —— 上一次运行写的那条诊断可能已经随进程没了");

  // ① 终止义务只有两个出口:**普通进展事件撤不动它**。
  trackTurnStall("s5h", owner, TURN, { kind: "text", text: "上游回来了,接着说。" }, actions);
  assert.deepEqual(log.resolves, [], "一条正文就把接管来的终止义务撤了");

  // ② 上游继续只吐错误,也**不会第二次宣布熔断** —— 状态机知道这一轮已经熔断过了。
  for (let i = 0; i < 6; i += 1) trackTurnStall("s5h", owner, TURN, notice(), actions);
  await sleep(320); // 等够一拍扫表:没进状态机的话,这些错误会被当成一次全新的停滞再熔断一遍
  assert.equal(log.trips.length, 1, "同一轮被宣布了两次熔断 —— 接管那一路没进状态机");
  assert.equal(log.escalations.length, 0, "宽限期还没到就回收了");

  // ③ 终止请求没生效:宽限期到了照样升一级回收(手抄那一版一次 kill 之后就没有下文了)。
  await sleep(600);
  assert.equal(log.escalations.length, 1, "接管来的终止请求没人理,宽限回收这一档没接上");

  // ④ 回合真收口:撤标记撤的是**判决里记的那一次停滞**,不是接管这一刻(持久标记按它做 CAS)。
  clearTurnStall("s5h", owner);
  assert.deepEqual(log.resolveSince, [SINCE], "撤的不是上一个进程置上的那个停滞身份 —— 那个标记永远撤不掉");
}

// ── ⑤c 熔断之后回合**没真的结束**:过了宽限期回收句柄 ─────────────────────────────
// 常驻台的 trip 走 `interrupt()` —— 那只是往 stdin 写一行请求,没有 ACK、不等回合结束、也没有
// 强杀退路。请求没人理的话,熔断就只是在时间线上说了句话,回合照旧卡着(第 1 轮审查第 4 条)。
{
  configure({ warnErrors: 1, tripMs: 60, graceMs: 400, pollMs: 15 });
  const { actions, log } = spy();
  const owner = {};
  trackTurnStall("s5c", owner, TURN, notice(), actions);
  await sleep(320); // 第一拍就该熔断(扫表间隔下限 200ms)
  assert.equal(log.trips.length, 1, "没熔断");
  assert.equal(log.escalations.length, 0, "宽限期还没过就回收了句柄");
  await sleep(500);
  assert.equal(log.escalations.length, 1, "终止请求没生效,却也没有回收兜底 —— 回合永远卡着");
  assert.match(log.escalations[0]!, /终止请求未生效/, "兜底那句话冒充了前一句");
  assert.match(log.escalations[0]!, /ASH_STALL_TRIP_GRACE_MS/, "兜底诊断里没写宽限期怎么调");
  await sleep(300);
  assert.equal(log.escalations.length, 1, "同一轮回收了两次");
}

// ── ⑤d 回合**真的**结束了就不该再回收:成功条件是真实结束 ─────────────────────────
{
  configure({ warnErrors: 1, tripMs: 60, graceMs: 400, pollMs: 15 });
  const { actions, log } = spy();
  const owner = {};
  trackTurnStall("s5d", owner, TURN, notice(), actions);
  await sleep(320);
  assert.equal(log.trips.length, 1, "没熔断");
  clearTurnStall("s5d", owner); // 终止请求生效了,回合收尾
  await sleep(600);
  assert.equal(log.escalations.length, 0, "回合已经结束了还去回收句柄 —— 那会连整台一起收掉");
}

// ── ⑤e 熔断之后:普通事件撤不动那份**还没兑现的**终止义务 ───────────────────────
// 第 2 轮审查 F1(已实测):旧版在非错误分支无条件 close,于是熔断之后随便来一条 `context` /
// `usage` / 正文,整条记录就没了 —— grace 兜底跟着消失(回合永远卡着)、resolve 还顺手把停滞
// 环撤了。页面上「已自动终止本回合并按失败结算」白写着,任务却停在运行中、什么异常都看不出来。
{
  configure({ warnErrors: 1, tripMs: 60, graceMs: 1000, pollMs: 15 });
  const { actions, log } = spy();
  const owner = {};
  trackTurnStall("s5e", owner, TURN, notice(), actions);
  await sleep(320); // 扫表间隔下限 200ms,第一拍就熔断
  assert.equal(log.trips.length, 1, "没熔断");
  const trippedAt = Date.now();

  await sleep(700);
  trackTurnStall("s5e", owner, TURN, { kind: "text", text: "继续" }, actions);
  trackTurnStall("s5e", owner, TURN, { kind: "tool", name: "Bash", detail: "{}" }, actions);
  assert.deepEqual(log.resolves, [], "熔断之后一条普通事件就把停滞标记撤了 —— 异常现场当场消失");
  assert.ok(stallFailure("s5e", TURN), "熔断之后一条普通事件就把失败判决抹了 —— 这一轮会落成功");

  // 它也不许**延长**宽限期:定期发 usage/context 的 CLI 会让兜底永远不到点,F1 就换成慢放版。
  // 距熔断已过 ~1020ms(宽限 1000ms),没被顶掉就该在这之后的第一拍回收;若按进展事件重算,
  // 到点要等到 ~1700ms 之后那一拍 —— 下面这个检查点落在两者中间。
  await sleep(600);
  assert.equal(
    log.escalations.length,
    1,
    `熔断后的进展事件把宽限期顶掉或延长了(距熔断 ${Date.now() - trippedAt}ms 仍未回收)`,
  );

  // 熔断之后再来的错误同样不该把钟重置掉,也不该二次熔断、二次回收。
  trackTurnStall("s5e", owner, TURN, notice(), actions);
  await sleep(300);
  assert.deepEqual([log.trips.length, log.escalations.length], [1, 1], "同一轮熔断/回收了两次");

  // 唯一的正常出口:同一 owner+回合真的收口(三条链的 turnEnd / 收流 finally / closeLead)。
  clearTurnStall("s5e", owner);
  assert.deepEqual(log.resolves, [TURN], "回合真结束了却没撤停滞标记 —— 它会在下一轮复活");
}

// ── ⑤f 失败判决的水位:**只按时间回收,绝不按条数** ─────────────────────────────
// 第 2 轮审查 F2(已实测 1 completed / 64 failed):旧版留条数水位(KEEP=64,超了扔最老的),
// 而被扔掉的恰恰是**还没结算**的那一条。断网会同时波及很多台,65 个回合先全部熔断、再统一
// 收到结束回执时,最早那一轮的判决已经被挤掉 —— 时间线写着「按失败结算」,区间却记 completed。
{
  __resetStallFailures();
  const turns = Array.from({ length: 65 }, (_, i) => `2026-10-30T07:${String(i).padStart(2, "0")}:00.000Z`);
  for (const [i, turn] of turns.entries()) markStallFailure(`cap-${i}`, turn, `熔断 ${i}`);
  const missing = turns.filter((turn, i) => !stallFailure(`cap-${i}`, turn));
  assert.deepEqual(
    missing,
    [],
    `同时熔断 65 轮,有 ${missing.length} 条判决被挤掉了 —— 那几轮会在结算时落成功`,
  );

  // 结算完了才销账(三条链各自调 clearStallFailure:单飞 settle 后、团队逐轮、讨论 span 后)。
  for (const [i, turn] of turns.entries()) clearStallFailure(`cap-${i}`, turn);
  assert.equal(stallFailure("cap-0", turns[0]!), null, "销账之后还读得到 —— 下一轮会被当成熔断过");

  // **写入不许顺手回收任何东西**:上两版在这里各挂了一个代理指标(条数水位、年龄 TTL),
  // 两次都把「还没结算」的那条扫掉了。现在写一百条也动不了别人一条。
  markStallFailure("nosweep", TURN, "没人来销账的那种");
  for (let i = 0; i < 100; i += 1) markStallFailure(`flood-${i}`, TURN, "后面来的一大批");
  assert.ok(stallFailure("nosweep", TURN), "写入时顺手扫掉了一条还没结算的判决");
  clearStallFailure("nosweep", TURN);
  for (let i = 0; i < 100; i += 1) clearStallFailure(`flood-${i}`, TURN);
}

// ── ⑤g **回收的唯一条件是结算**:离开状态机不算,老了也不算 ──────────────────────
// 同一处被打回过三次,三次都是拿一个代理指标冒充「没有读者了」:条数水位(第 2 轮)、年龄 TTL
// (第 3 轮)、「退场 + 年龄」(第 5 轮 F2 —— 摘牌只证明那条记录不再代表这个会话,不证明旧消费
// 循环已经读过判决)。`ASH_STALL_TRIP_GRACE_MS=0` 是产品允许的配置(关掉强制回收),于是一个
// 熔断过、`interrupt` 没人理的回合可以一直活着,读者随后才来。
{
  configure({ warnErrors: 1, tripMs: 60, graceMs: 0, pollMs: 15 });
  const { actions, log } = spy();
  const owner = {};
  trackTurnStall("s5g", owner, TURN, notice(), actions);
  await sleep(320);
  assert.equal(log.trips.length, 1, "没熔断");
  assert.equal(log.escalations.length, 0, "graceMs=0 该是「不强制回收」,却还是回收了");

  // 这一轮没结束(没有 clearTurnStall,也没被顶掉),后面又来了一大批熔断。
  for (let i = 0; i < 100; i += 1) markStallFailure("another", `2026-10-30T09:${String(i).padStart(2, "0")}:00.000Z`, "另一轮熔断了");
  assert.ok(
    stallFailure("s5g", TURN),
    "一个还在跑的熔断回合,判决被后面来的写入扫掉了 —— 它收到结束回执时会被记成正常完成",
  );

  // **离开状态机也不算**:同一条会话被新一轮顶掉、或者 close 掉,判决都得留着等读者销账。
  clearTurnStall("s5g", owner);
  assert.ok(stallFailure("s5g", TURN), "离开状态机就删了 —— 结算还没来得及读");
  for (let i = 0; i < 100; i += 1) markStallFailure("another2", `2026-10-30T10:${String(i).padStart(2, "0")}:00.000Z`, "再来一轮");
  assert.ok(stallFailure("s5g", TURN), "退场之后被当成孤立记录扫掉了 —— 读者还没来");

  // 只有读者自己销账才清得掉。
  clearStallFailure("s5g", TURN);
  assert.equal(stallFailure("s5g", TURN), null, "销账之后还读得到");
  for (let i = 0; i < 100; i += 1) {
    clearStallFailure("another", `2026-10-30T09:${String(i).padStart(2, "0")}:00.000Z`);
    clearStallFailure("another2", `2026-10-30T10:${String(i).padStart(2, "0")}:00.000Z`);
  }
}

// ── ⑥ 反向:正常的长回合一档都不许触发(误杀代价最高的一位) ──────────────────────
{
  // 一边重试一边有正常输出(真实的恢复过程就是这样):总时长远超两档阈值,但从来没有
  // 「自上次上游真回话以来」够长过,所以一下都不许动。
  configure({ warnErrors: 5, warnMs: 60, tripMs: 100, pollMs: 15 });
  const { actions, log } = spy();
  const owner = {};
  for (let i = 0; i < 10; i += 1) {
    trackTurnStall("s6", owner, TURN, notice(), actions);
    trackTurnStall("s6", owner, TURN, { kind: "tool", name: "Bash", detail: "{}" }, actions);
    await sleep(40);
  }
  assert.deepEqual(
    [log.warns.length, log.trips.length],
    [0, 0],
    "一个 400 毫秒、期间一直有工具调用的回合被判成停滞 —— 判据漂成了「回合总时长」",
  );

  // 纯静默(长思考、pytest 跑半小时):一个事件都没有,这一层分辨不出来,一律不动手。
  configure({ warnErrors: 1, warnMs: 30, tripMs: 60, pollMs: 15 });
  const quiet = spy();
  trackTurnStall("s7", {}, TURN, { kind: "tool", name: "Bash", detail: "pytest" }, quiet.actions);
  await sleep(200);
  assert.deepEqual(
    [quiet.log.warns.length, quiet.log.trips.length],
    [0, 0],
    "一个工具跑着、安安静静的回合被动了手 —— 纯静默不是停滞的证据",
  );
}

// ── ⑦ 没有回合身份的错误一条都不记 ────────────────────────────────────────────
{
  configure({ warnErrors: 1 });
  const { actions, log } = spy();
  for (let i = 0; i < 5; i += 1) trackTurnStall("s8", {}, null, notice(), actions);
  assert.equal(log.warns.length, 0, "没有回合身份也动手了 —— 熔断会杀到一个与它无关的回合");
}

// ── ⑧ 换台/换轮:只有持有者动得了自己那份 ───────────────────────────────────────
{
  configure({ warnErrors: 2 });
  const shared = "s9";
  const oldLead = spy("task-old");
  const newLead = spy("task-new");
  const a = {};
  const b = {};
  trackTurnStall(shared, b, TURN, notice(), newLead.actions);
  // 旧台迟到的正文无权解除新台的停滞(落盘产物早有摘牌闸,内存这一份同理)。
  trackTurnStall(shared, a, TURN, { kind: "text", text: "旧台迟到的半句" }, oldLead.actions);
  trackTurnStall(shared, b, TURN, notice(), newLead.actions);
  assert.equal(newLead.log.warns.length, 1, "旧台迟到的输出解除了新台的停滞");
  clearTurnStall(shared, a); // 不是持有者:空转
  assert.equal(newLead.log.resolves.length, 0, "不是持有者也撤得动别人的标记");
  clearTurnStall(shared, b);
  await sleep(0); // 同 ①:撤排在投影确认之后
  assert.deepEqual(newLead.log.resolves, [TURN], "持有者自己也撤不掉,或者没把回合身份交出来");

  // 换轮同理:新回合的第一条错误是**认领**,上一轮悬着的计数不许跟着带过来。
  configure({ warnErrors: 3 });
  const next = spy();
  const owner = {};
  trackTurnStall("s10", owner, TURN, notice(), next.actions);
  trackTurnStall("s10", owner, TURN, notice(), next.actions);
  trackTurnStall("s10", owner, "2026-10-30T09:00:00.000Z", notice(), next.actions);
  assert.equal(next.log.warns.length, 0, "上一轮的计数被带进了新回合");
}

// ── ⑪ 阈值配错一个字不许变成「见错就杀」 ────────────────────────────────────────
// `Number("30m")` 是 NaN,而 `NaN <= 0` 和 `elapsedMs < NaN` **都是 false** —— 不校验的那一版
// 两道闸同时放行,第一条错误事件就当场熔断。比不设看门狗更坏(第 1 轮审查非拦项)。
{
  configure({ warnErrors: 1 });
  process.env.ASH_STALL_TRIP_MS = "30m";
  const { actions, log } = spy();
  trackTurnStall("s14", {}, TURN, notice(), actions);
  assert.equal(log.trips.length, 0, "阈值写成 30m 就见错即杀 —— 配错一个字比没有看门狗更坏");
  assert.equal(log.warns.length, 1, "警告档也被那个坏值带坏了");
  process.env.ASH_STALL_TRIP_MS = "0";
}

// ── ⑫ 诊断要说得出「卡在哪一步」:停滞前最后一条正常事件是什么 ──────────────────
// 「工具跑完在等模型总结」和「一条正常输出都没有过」是两种现场,要查的东西完全不同。
// 原始协议的 method/type 不在这一层(那个由 RunTraceRecorder.finish() 在**进程退出后**才产出,
// 熔断这一刻它压根不存在),所以这一层给的是归一化之后的 kind + 指名那个原始事件流文件。
{
  configure({ warnErrors: 2, tripMs: 60, pollMs: 15 });
  const { actions, log } = spy();
  const owner = {};
  trackTurnStall("s15", owner, TURN, { kind: "tool", name: "exec", detail: "pytest" }, actions);
  trackTurnStall("s15", owner, TURN, notice(), actions);
  trackTurnStall("s15", owner, TURN, notice(), actions);
  assert.equal(log.warns.length, 1, "没报警");
  assert.equal(log.warns[0]!.facts.lastProgressKind, "tool", "没记下停滞前最后那条正常事件");
  await sleep(320);
  assert.match(log.trips[0]!, /最后一条正常事件是 tool/, "熔断诊断里没说清卡在哪一步");

  // 上一轮的「最后一条正常事件」不许带进新回合。
  configure({ warnErrors: 1 });
  const next = spy();
  const o = {};
  trackTurnStall("s16", o, TURN, { kind: "tool", name: "exec" }, next.actions);
  trackTurnStall("s16", o, "2026-10-30T09:00:00.000Z", notice(), next.actions);
  assert.equal(next.log.warns[0]!.facts.lastProgressKind, null, "上一轮的最后一步被算进了新回合");
}

// ── ⑨ 现场重放:旧判据全程无声,新判据按时限报警并熔断 ───────────────────────────
{
  // 副本(原始取证文件只读,见文件头)。只留 method/params/emittedAtMs 并截短长字段:
  // 重放要的是**错误流的形状与时序**,那两样一个字节没动。
  const fixture = fileURLToPath(new URL("./fixtures/codex-upstream-stall.jsonl", import.meta.url));
  const lines = readFileSync(fixture, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
    method: string;
    params: Record<string, any>;
    emittedAtMs: number | null;
  });
  const errors = lines.filter((line) => line.method === "error");
  assert.equal(errors.length, 220, "夹具里的错误条数变了,下面那些结论是照它算的");

  // **旧行为:全程无声。** 旧判据是 `if (!p.willRetry && p.error?.message)`,而现场这 220 条
  // 全带 willRetry:true —— 一条事件都到不了消费层,所以 ash 没有任何可报的东西。
  assert.equal(errors.filter((line) => !line.params.willRetry).length, 0, "现场里居然有不重试的错误?");
  // **新行为:220 条,全是 notice。** notice 这一级是必须的:裸 error 会把这一轮判成有执行
  // 故障,上游恢复后正常答完的那一轮也会被记成失败。
  const reported = errors.map((line) => codexErrorEvent(line.params));
  assert.equal(reported.filter((item) => item !== null).length, 220, "新判据漏掉了现场的重试提示");
  assert.ok(
    reported.every((item) => item?.event.level === "notice" && item.counted === false),
    "现场的重试提示被抬成了裸 error / 混进了收尾诊断",
  );

  // 把这 220 条原样喂给看门狗:按默认条数阈值(5),第 5 条就该报警。
  configure({ warnErrors: 5, warnMs: 5 * 60_000, tripMs: 30 * 60_000, pollMs: 20_000 });
  const { actions, log } = spy("W54czudPJ9Q9");
  const owner = {};
  for (const item of reported) trackTurnStall("replay", owner, TURN, item!.event, actions);
  assert.equal(log.warns.length, 1, "现场那条事件流重放后仍然一声不响");
  assert.equal(log.warns[0]!.facts.errors, 5, "警告不是在第 5 条上报的");

  // 时限对照(纯算术,照夹具里的真实时间戳):停滞从第一条错误起算,现场的回合直到
  // turn/completed 才结束。默认 30 分钟熔断能把这一轮从 4 小时 51 分砍到半小时。
  const stallStart = errors[0]!.emittedAtMs!;
  const warnAt = errors[4]!.emittedAtMs!;
  const completedAt = lines.find((line) => line.method === "turn/completed")!.emittedAtMs!;
  const realMin = (completedAt - stallStart) / 60_000;
  const warnMin = (warnAt - stallStart) / 60_000;
  assert.ok(realMin > 240, `现场那一轮只停滞了 ${realMin.toFixed(1)} 分钟?夹具不对`);
  assert.ok(warnMin < 5, `第 5 条错误落在 ${warnMin.toFixed(1)} 分钟,条数档不该比时间档还慢`);
  assert.ok(realMin > 30, "默认 30 分钟的熔断对现场那一轮无效 —— 它比熔断时长还短");
  console.log(
    `  现场对照:旧行为 0 条事件、${realMin.toFixed(0)} 分钟全程无声;`
    + `新行为第 5 条错误(停滞 ${warnMin.toFixed(1)} 分钟)报警、30 分钟熔断。`,
  );
}

// ── ⑬ 现场副本**按原相对时序**整条重放(验收标准⑤) ─────────────────────────────
// 上一段是算术对照(按时间戳算旧/新各会说什么);这一段把**全部 257 行按它们记录下来的相对
// 顺序与间隔**喂进状态机,时钟整体压缩 K 倍,阈值同比例缩小。它要答的是算术答不了的那几问:
//   · 停滞之前那 33 行正常事件在场时,一档都不许触发;
//   · 220 条错误连成一片时,报警恰好一次、熔断恰好一次(不是每条一次);
//   · 熔断**之后**现场那几行收尾事件(thread/status/changed、turn/completed…)到达时,
//     那份没兑现的终止义务不许被它们撤掉(⑤e 的同一条不变量,这里用真实事件序复核);
//   · 回合真收口时标记才撤。
//
// 只到状态机为止:**不拉起真实 CLI、不走消费链与结算**(那两段各有自己的钉子 —— 结算那一段
// 在 test-stall-settle.ts)。非错误行按「不是错误」这唯一一条属性折成一个占位进展事件:状态机
// 对它们只区分「是/不是错误」,原方法名照样带着,便于读失败现场。
{
  const fixture = fileURLToPath(new URL("./fixtures/codex-upstream-stall.jsonl", import.meta.url));
  const lines = readFileSync(fixture, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
    method: string;
    params: Record<string, any>;
    emittedAtMs: number | null;
  });
  assert.equal(lines.length, 257, "夹具行数变了,下面的时序结论是照它算的");
  const stamped = lines.filter((line) => line.emittedAtMs !== null);
  const spanMs = stamped[stamped.length - 1]!.emittedAtMs! - stamped[0]!.emittedAtMs!;
  // 墙钟压缩倍率:整条流跑完约 3.5 秒。阈值同比例缩小,于是「5 分钟/30 分钟」在压缩后的
  // 时间轴上还是同一个相对位置(扫表间隔有 200ms 下限,所以熔断会落在它之后第一拍)。
  const K = Math.round(spanMs / 3500);
  configure({ warnErrors: 5, warnMs: Math.round(5 * 60_000 / K), tripMs: Math.round(30 * 60_000 / K), pollMs: 15 });
  const { actions, log } = spy("W54czudPJ9Q9");
  const owner = {};
  const base = stamped[0]!.emittedAtMs!;
  const startedAt = Date.now();
  let preStall: [number, number] | null = null;
  let firstError = true;
  for (const line of lines) {
    if (line.emittedAtMs !== null) {
      const due = startedAt + (line.emittedAtMs - base) / K;
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
    }
    const converted = line.method === "error" ? codexErrorEvent(line.params) : null;
    if (converted && firstError) {
      firstError = false;
      // 停滞开始前那 33 行里有正常事件,这一刻两档都该是 0 —— 判据是「自上次上游真回话以来」,
      // 不是回合总时长(⑥ 用构造事件钉同一条,这里用现场真实序列复核)。
      preStall = [log.warns.length, log.trips.length];
    }
    trackTurnStall("replay", owner, TURN, converted?.event ?? { kind: "tool", name: line.method }, actions);
  }
  assert.deepEqual(preStall, [0, 0], "停滞还没开始(现场前 33 行都是正常事件)就报警/熔断了");
  assert.equal(log.warns.length, 1, "现场那条流重放后一声不响,或者 220 条错误报了 220 次警");
  assert.equal(log.warns[0]!.facts.errors, 5, "警告不是在第 5 条错误上报的");
  assert.equal(log.trips.length, 1, "整条流重放后没有熔断,或者熔断了不止一次");
  assert.ok(stallFailure("replay", TURN), "熔断了却没把失败结论钉在回合身份上");
  // 现场在最后一条错误之后还有 4 行收尾事件,刚才已经原样喂进去了。
  assert.deepEqual(log.resolves, [], "熔断之后现场那几行收尾事件把停滞标记撤了 —— 终止义务没兑现");
  clearTurnStall("replay", owner);
  assert.deepEqual(log.resolves, [TURN], "回合真收口了却没撤标记");
  console.log(
    `  整条重放:${lines.length} 行按原时序(${(spanMs / 60_000).toFixed(0)} 分钟压缩 ${K}×,`
    + `实耗 ${((Date.now() - startedAt) / 1000).toFixed(1)}s)→ 报警 1 次、熔断 1 次、收口时撤标记。`,
  );
}

__resetTurnStalls();
console.log("test:turn-stall ok：错误档两档按「自上次上游真回话以来」判,长回合不触发;纯静默不进这一档 —— 它归静默档(test:undriven-turn)");
