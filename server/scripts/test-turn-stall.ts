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
import {
  __resetTurnStalls,
  clearTurnStall,
  trackTurnStall,
  type StallActions,
  type StallFacts,
} from "../src/turn-stall.js";

const TURN = "2026-10-30T07:36:21.000Z";
const RETRY = "Reconnecting... waiting for network";
const notice = (message = RETRY): AgentEvent => ({ kind: "error", message, level: "notice", affectsTurn: false });
const hard = (message: string): AgentEvent => ({ kind: "error", message });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Log = { warns: { text: string; facts: StallFacts }[]; trips: string[]; resolves: number };
function spy(taskId = "task-1"): { actions: StallActions; log: Log } {
  const log: Log = { warns: [], trips: [], resolves: 0 };
  return {
    log,
    actions: {
      taskId,
      warn: (text, facts) => log.warns.push({ text, facts }),
      trip: (text) => log.trips.push(text),
      resolve: () => { log.resolves += 1; },
    },
  };
}

/** 每段各自设口径,免得上一段的 env 漏到下一段。 */
function configure(opts: { warnErrors?: number; warnMs?: number; tripMs?: number; pollMs?: number }) {
  __resetTurnStalls();
  process.env.ASH_STALL_WARN_ERRORS = String(opts.warnErrors ?? 0);
  process.env.ASH_STALL_WARN_MS = String(opts.warnMs ?? 0);
  process.env.ASH_STALL_TRIP_MS = String(opts.tripMs ?? 0);
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
  assert.equal(log.resolves, 1, "上游已经在吐正文了,卡片上那个停滞标记没撤");
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
  assert.match(text, /重试续跑|换一个执行器/, "诊断里没写用户还能做什么");
  await sleep(100);
  assert.equal(log.trips.length, 1, "同一次停滞熔断了两次");
  // 熔断那一刻已经摘牌:随后收流走到 clearTurnStall 时不能再撤一次卡片标记 ——
  // 那会把熔断诊断旁边那个「它卡在上游」的状态当场擦掉。
  const resolvesBefore = log.resolves;
  clearTurnStall("s5", owner);
  assert.equal(log.resolves, resolvesBefore, "熔断之后的收流又撤了一次标记,诊断旁边那个状态被擦掉");
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
  assert.equal(newLead.log.resolves, 0, "不是持有者也撤得动别人的标记");
  clearTurnStall(shared, b);
  assert.equal(newLead.log.resolves, 1, "持有者自己也撤不掉");

  // 换轮同理:新回合的第一条错误是**认领**,上一轮悬着的计数不许跟着带过来。
  configure({ warnErrors: 3 });
  const next = spy();
  const owner = {};
  trackTurnStall("s10", owner, TURN, notice(), next.actions);
  trackTurnStall("s10", owner, TURN, notice(), next.actions);
  trackTurnStall("s10", owner, "2026-10-30T09:00:00.000Z", notice(), next.actions);
  assert.equal(next.log.warns.length, 0, "上一轮的计数被带进了新回合");
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
