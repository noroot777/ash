// 回合级停滞看门狗的两档判据,以及它**绝不该**动手的那几种形状。
// 跑:npm -w server run test:turn-stall
//
// 起因(2026-10-30,现场取证 data/runs/W54czudPJ9Q9/6ze45D4I2Bz_-…agent-out.jsonl):模型上游
// 所在的中转主机整体离线,codex 自己重连了 4 小时 45 分 —— 事件流里 216 条
// 「Reconnecting... waiting for network」全带 `willRetry:true`,被执行器静默丢掉,于是 ash
// 全程无报错、无超时,界面一直 running。本文件钉三件事:
//   ① 那种形状现在会按时限报警并熔断;
//   ② **正常的长回合一档都不许触发** —— 长思考、长工具调用期间同样一个事件都不发,判据
//      只能是「自上次非错误事件以来」,不能是回合总时长;
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
  trackTurnStall,
  type StallActions,
  type StallFacts,
} from "../src/turn-stall.js";
import { __ageStallFailures, __resetStallFailures, clearStallFailure, markStallFailure, stallFailure } from "../src/turn-stall-verdict.js";

const TURN = "2026-10-30T07:36:21.000Z";
const RETRY = "Reconnecting... waiting for network";
const notice = (message = RETRY): AgentEvent => ({ kind: "error", message, level: "notice", affectsTurn: false });
const hard = (message: string): AgentEvent => ({ kind: "error", message });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Log = {
  warns: { text: string; facts: StallFacts }[];
  trips: string[];
  escalations: string[];
  /** 撤标记时拿到的回合身份 —— 库里那一侧按它做 CAS(session-stall-flag.ts),所以得钉住。 */
  resolves: string[];
};
function spy(taskId = "task-1"): { actions: StallActions; log: Log } {
  const log: Log = { warns: [], trips: [], escalations: [], resolves: [] };
  return {
    log,
    actions: {
      taskId,
      warn: (text, facts) => log.warns.push({ text, facts }),
      trip: (text) => log.trips.push(text),
      escalate: (text) => log.escalations.push(text),
      resolve: (facts) => log.resolves.push(facts.turnStartedAt),
    },
  };
}

/** 每段各自设口径,免得上一段的 env 漏到下一段。各档 0 = 关掉。 */
function configure(opts: {
  warnErrors?: number; warnMs?: number; tripMs?: number; graceMs?: number; pollMs?: number;
}) {
  __resetTurnStalls();
  __resetStallFailures();
  process.env.ASH_STALL_WARN_ERRORS = String(opts.warnErrors ?? 0);
  process.env.ASH_STALL_WARN_MS = String(opts.warnMs ?? 0);
  process.env.ASH_STALL_TRIP_MS = String(opts.tripMs ?? 0);
  process.env.ASH_STALL_TRIP_GRACE_MS = String(opts.graceMs ?? 0);
  process.env.ASH_STALL_POLL_MS = String(opts.pollMs ?? 20);
}

// ── ① 警告档·条数路径:连续错误、期间没有任何非错误事件 ─────────────────────────
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

  // 非错误事件 = 停滞解除,报过警就得把卡片上那个标记撤掉。
  trackTurnStall("s1", owner, TURN, { kind: "text", text: "上游回来了，继续回答。" }, actions);
  assert.deepEqual(log.resolves, [TURN], "上游已经在吐正文了,卡片上那个停滞标记没撤");
  // 解除之后重新起算:下一轮重试要能再报一次(真的又挂了就得再说一声)。
  for (let i = 0; i < 5; i += 1) trackTurnStall("s1", owner, TURN, notice(), actions);
  assert.equal(log.warns.length, 2, "解除之后又挂了,第二次停滞不报警");
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

// ── ③ 解除条件认的是「非错误事件」这一整类 ──────────────────────────────────────
{
  for (const resume of [
    { kind: "text", text: "续" },
    { kind: "thinking", text: "想" },
    { kind: "tool", name: "Bash", detail: "{}" },
    { kind: "attachment", path: "/tmp/a.png" },
    { kind: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
    { kind: "session", cliSessionId: "abc" },
    { kind: "context", context: { used: 1, window: 2, windowEstimated: false } },
    { kind: "system", text: "旁注" },
    { kind: "turnEnd" },
    { kind: "done", exitStatus: 0 },
  ] as AgentEvent[]) {
    configure({ warnErrors: 2 });
    const { actions, log } = spy();
    const owner = {};
    trackTurnStall("s3", owner, TURN, notice(), actions);
    trackTurnStall("s3", owner, TURN, resume, actions);
    trackTurnStall("s3", owner, TURN, notice(), actions);
    assert.equal(log.warns.length, 0, `${resume.kind} 没能解除停滞 —— 流还在动就不许动手`);
  }
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

  // 孤立回收:久到不可能还有人来结算的那些,下一次写入时顺手清掉;新的那条一个字不动。
  markStallFailure("orphan", TURN, "没人来销账的那种");
  __ageStallFailures(7 * 60 * 60_000);
  markStallFailure("fresh", TURN, "刚熔断");
  assert.equal(stallFailure("orphan", TURN), null, "孤立判决一直占着内存,TTL 没生效");
  assert.ok(stallFailure("fresh", TURN), "回收把刚写下的活判决也清了");
  clearStallFailure("fresh", TURN);
}

// ── ⑥ 反向:正常的长回合一档都不许触发(误杀代价最高的一位) ──────────────────────
{
  // 一边重试一边有正常输出(真实的恢复过程就是这样):总时长远超两档阈值,但从来没有
  // 「自上次非错误事件以来」够长过,所以一下都不许动。
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

// ── ⑩ 子智能体的错误被包成 kind:"tool",**包装不算进展** ──────────────────────────
// 子线程(codex 子线程、claude 的 parent_tool_use_id 子回合)的每一条活动都被 childActivity()
// 包成 `{kind:"tool", name:"Agent", nativeWork:{type:"activity", event}}` —— 外层恒为 tool。
// 只看外层的那一版把子线程的重连风暴读成「有工具在动」:既开不了停滞,还会把父线程已经开着
// 的那一份当场解除,正好把看门狗关在最需要它的场合(第 1 轮审查第 1 条,已实测)。
{
  configure({ warnErrors: 3 });
  const { actions, log } = spy();
  const owner = {};
  const childRetry = childActivity("thread-1", { kind: "error", message: RETRY, level: "notice" });
  assert.equal(childRetry.kind, "tool", "夹具不对:子智能体活动的外层本来就该是 tool");
  for (let i = 0; i < 3; i += 1) trackTurnStall("s11", owner, TURN, childRetry, actions);
  assert.equal(log.warns.length, 1, "子线程的重连风暴一条都没被计入 —— 整条链上只有它在报错");
  const facts = log.warns[0]!.facts;
  assert.equal(facts.errors, 3);
  assert.equal(facts.retries, 3, "包装里的 level:\"notice\" 没读出来,重试被当成真故障");
  assert.equal(facts.childErrors, 3, "没记下这几条来自子线程 —— 诊断里分不清是谁卡住了");
  assert.match(log.warns[0]!.text, /子智能体线程/, "诊断没说清停滞来自子线程");

  // 另一半:子线程的错误**不许**解除父线程已经开着的停滞。
  configure({ warnErrors: 2 });
  const parent = spy();
  const owner2 = {};
  trackTurnStall("s12", owner2, TURN, notice(), parent.actions);
  trackTurnStall("s12", owner2, TURN, childRetry, parent.actions);
  assert.equal(parent.log.warns.length, 1, "子线程的错误把父线程的停滞当成进展解除掉了");

  // 反向闸:子线程**真的在干活**(正文/工具)照样解除 —— 它证明这条流还在动。
  configure({ warnErrors: 2 });
  const live = spy();
  const owner3 = {};
  trackTurnStall("s13", owner3, TURN, notice(), live.actions);
  trackTurnStall("s13", owner3, TURN, childActivity("thread-1", { kind: "tool", name: "exec" }), live.actions);
  trackTurnStall("s13", owner3, TURN, notice(), live.actions);
  assert.equal(live.log.warns.length, 0, "子线程在干活却被算成停滞 —— 误杀正在跑的回合");
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

__resetTurnStalls();
console.log("test:turn-stall ok：两档按「自上次非错误事件以来」判,长回合与纯静默一档都不触发");
