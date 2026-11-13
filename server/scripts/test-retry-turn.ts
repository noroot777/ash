// 「重跑上一回合」认输入的判据（纯函数，不碰 DB 也不摸盘）。
// 认错了界面上看不出来：会静默退回「从中断处续跑」，而崩在 CLI 起来之前的那一回合根本
// 没把指令交给 CLI —— 用户点了重试，agent 却什么都没收到。所以在这里钉住。
// 跑:npm -w server run test:retry-turn
import assert from "node:assert/strict";
import type { RetryTurnFacts, RetryTurnSession, RetryTurnTask } from "../src/task-retry-turn.js";
import { turnEndedAbnormally } from "@ash/shared/turn-outcome";
import {
  lastInputOf, latestSessionOf, resendInputOf, retryTurnActionOf, retryTurnKindOf, retryTurnRejection, retryTurnTierOf,
} from "../src/task-retry-turn.js";
import { describeQueueBlockers, queueBlockedText, type QueueBlocker } from "../src/queues.js";

const turn = (t: string, text: string, extra: Record<string, unknown> = {}) =>
  `\x1e${JSON.stringify({ t, agent: "claude", text, at: "2026-08-13T01:00:00.000Z", ...extra })}`;

{
  const monitorWake = { version: 1, events: [{ kind: "output", monitorId: "actual", source: "(monitorId=example)", body: "【你当初留下的续跑交代】日志" }], omittedEvents: 0 };
  const input = lastInputOf(turn("user", "哨兵的原始输入", { by: "system", monitorWake }));
  assert.deepEqual(input?.kind === "user" ? input.monitorWake : null, monitorWake);
}

// ── 续聊回合崩了：最后一段是我打的字 → 原样重投 ────────────────────────────
{
  const seg = lastInputOf([
    turn("user", "第一句"),
    "agent 干完了第一件事",
    turn("user", "把标题也改一下"),
    "agent 刚开口就崩了",
    "> 续聊回合异常结束(退出码 1),任务状态保持「已完成」不变。",
  ].join("\n"));
  assert.equal(seg?.kind, "user", "最后一段是真人回合");
  assert.equal(seg?.text, "把标题也改一下", "取的是最后那句，不是第一句");
  assert.equal(seg?.kind === "user" ? seg.bySystem : undefined, undefined, "真人发的不带代写标记");
}

// ── 回合末尾挂着结算说明（level:"notice"）→ 跳过它，照样重投用户那句话 ──────────
// 结算说明恒在收尾时落盘，也就是恒排在最后一个真人回合之后。把它当成「上一轮是系统续跑」
// 的话，每一个「没交卷」的失败回合都会让「重跑上一回合」静默退回 resume。
{
  const seg = lastInputOf([
    turn("user", "把标题也改一下"),
    "agent 刚开口就崩了",
    turn("system", "本回合没有交卷:agent 结束前没有调用 complete_task 确认目标已达成。", { level: "notice" }),
  ].join("\n"));
  assert.equal(seg?.kind, "user", "结算说明不是输入，该跳过去找真人那句");
  assert.equal(seg?.text, "把标题也改一下");
}

// ── 系统续跑提示（没有 notice 标记）照旧算数：上一轮本来就是续跑，重投没有意义 ──
{
  const seg = lastInputOf([
    turn("user", "开工"),
    "agent 干了一半",
    turn("system", "继续（从中断处）"),
  ].join("\n"));
  assert.equal(seg?.kind, "system");
}

// ── 自由工作流自动修复回合崩了：最后一段是后端代写的 user 回合 → 重投并保留标记 ──
{
  const seg = lastInputOf([
    turn("user", "【自由工作流审查未通过 · 第 1 轮】\n请按报告修复", { by: "system" }),
    "agent 起来就吃了 503",
  ].join("\n"));
  assert.equal(seg?.kind, "user", "代写消息仍占真人回合");
  assert.equal(seg?.kind === "user" ? seg.bySystem : undefined, true, "重投时要原样带回 by:system，别把机器的话记成用户说的");
}

// ── 上一回合本来就是系统续跑 → 不重投，退回 resume ──────────────────────────
{
  const seg = lastInputOf([
    turn("user", "开工"),
    "agent 干了一半",
    turn("system", "继续（从中断处）"),
    "agent 又崩了",
  ].join("\n"));
  assert.equal(seg?.kind, "system", "最后一段是系统提示，重投它没有意义");
}

// ── 首跑（会话里一个非 agent 段都没有）→ 退回 resume ────────────────────────
assert.equal(lastInputOf("agent 从头到尾自己说话"), null, "没有输入段就没有可重投的东西");
assert.equal(lastInputOf(""), null, "空正文");

console.log("✓ retry-turn input predicate");

// ── 「最新会话」的排序口径 ────────────────────────────────────────────────────
// 会话行跨回合复用，恢复旧会话只更新 turnStartedAt。按 startedAt 排会把「先建后用」的
// 那条永远判成旧的，于是前端提交的正确 sessionId 被判成「不是最新一次」，按钮永久 409。
const sess = (over: Partial<RetryTurnSession> & { id: string }): RetryTurnSession => ({
  role: "single",
  turnStartedAt: null,
  startedAt: "2026-08-13T01:00:00.000Z",
  exitStatus: 1,
  ...over,
});
{
  // A 先建（01:00），B 后建并跑完（02:00），03:00 切回 A 续聊 —— 最新的是 A。
  const a = sess({ id: "a", startedAt: "2026-08-13T01:00:00.000Z", turnStartedAt: "2026-08-13T03:00:00.000Z" });
  const b = sess({ id: "b", startedAt: "2026-08-13T02:00:00.000Z", exitStatus: 0 });
  assert.equal(latestSessionOf([a, b])?.id, "a", "按最近一次回合排，不是按会话创建时间");
  assert.equal(latestSessionOf([b, a])?.id, "a", "与入参顺序无关");
  assert.equal(latestSessionOf([])?.id, undefined, "没有会话就没有最新会话");
}

// ── 能不能重跑 ──────────────────────────────────────────────────────────────
const task = (over: Partial<RetryTurnTask> = {}): RetryTurnTask => ({
  archived: false,
  mode: "single",
  status: "done",
  verifyRound: null,
  ...over,
});
const why = (t: RetryTurnTask, s: RetryTurnSession | null, extra: Partial<RetryTurnFacts> = {}) =>
  retryTurnRejection({ task: t, latest: s, ...extra })?.error ?? null;

assert.equal(why(task(), sess({ id: "a" })), null, "停在 done、上一回合非零退出 → 放行");
// 主动停止/暂停的真实形状:CLI 吃 SIGTERM 按 signal 写 exit 1,任务正常落 canceled/paused。
// 这不是崩溃,给了按钮就是把「我停的」冒充成「它崩了」。
assert.ok(why(task({ status: "canceled" }), sess({ id: "a" })), "主动停止不是异常结束");
assert.ok(why(task({ status: "paused" }), sess({ id: "a" })), "暂停不是异常结束");
assert.ok(why(task({ status: "backlog" }), sess({ id: "a" })), "手工改回 backlog 也不给");
assert.ok(why(task({ status: "failed" }), sess({ id: "a" })), "failed 归头部那颗重试");
assert.ok(why(task({ status: "running" }), sess({ id: "a" })), "正在跑的不给重投");
assert.ok(why(task({ status: "queued" }), sess({ id: "a" })), "排队中的不给重投");
assert.ok(why(task({ archived: true }), sess({ id: "a" })), "归档任务不跑");
assert.ok(why(task({ mode: "team" }), sess({ id: "a" })), "只接单飞");
assert.ok(why(task({ verifyRound: 2 }), sess({ id: "a" })), "验证轮还挂着号,那是旁路回合");
assert.ok(why(task({ question: "选 A 还是 B?" }), sess({ id: "a" })), "还在等答复,先答复");
assert.ok(why(task({ resumePrompt: "继续做第二步" }), sess({ id: "a" })), "挂着续跑指令,该继续而不是重投");
assert.ok(why(task(), sess({ id: "a", exitStatus: 0 })), "正常结束不用重跑");
assert.ok(why(task(), sess({ id: "a", exitStatus: null })), "没结算的回合不算崩溃");
assert.ok(why(task(), null), "没跑过就没有上一回合");
assert.ok(why(task(), sess({ id: "a" }), { wantedSessionId: "b" }), "页面上那条不是最新会话 → 拒绝而不是照跑");
assert.equal(why(task(), sess({ id: "a" }), { wantedSessionId: "a" }), null, "页面上那条就是最新会话 → 放行");
// 手动停止:CLI 按 signal 写非零退出码,跟崩溃在 exitStatus 上完全一样,只有 stoppedAs 分得开。
// 认不出来 = 用户刚亲手停下的那句话被按钮又跑了一遍。
assert.ok(why(task(), sess({ id: "a", stoppedAs: "canceled" })), "手动停止的回合不是崩溃");
assert.ok(why(task(), sess({ id: "a", stoppedAs: "paused" })), "手动暂停的回合不是崩溃");
// 旁路回合(就地验证、/compact):重投会按任务当前配置跑普通回合,跑的不是那一轮的验证者。
assert.ok(why(task(), sess({ id: "a", sideTurn: true })), "旁路回合有自己的入口");
assert.ok(why(task(), sess({ id: "a" }), { groupPaused: true }), "分组暂停时不许从这里插队开跑");
// 队列那道闸只挡**续跑档**(任务的执行回合)。重投档是终态任务的续聊、审查档是旁路回合,
// 队列都按原终态看它们 —— 挡它们,串行队列只要还在往下跑,队里已完成成员上断掉的那一回合
// 就续不了(2026-11-13 现场:挡路的排在后面第 4 位,409 却说「队列前面还有未完成的任务」)。
{
  const running: QueueBlocker = { id: "y", title: "正在执行的那条", running: true };
  const resume = retryTurnRejection({ task: task(), latest: sess({ id: "a" }), blockedBy: [running] });
  assert.ok(resume, "续跑档:同队有人在执行就不许抢跑");
  assert.match(resume.error, /「正在执行的那条」正在运行/, "那句话点名挡路的是哪条");
  assert.deepEqual(resume.detail?.blockedBy, ["y"], "409 里照旧带 blockedBy(任务 id)");
  assert.equal(retryTurnTierOf("turn", undefined), "resume", "不知道能不能重投时按续跑档算,往严里判");
  assert.equal(why(task(), sess({ id: "a" }), { resendable: true, blockedBy: [running] }), null,
    "重投档:终态任务的续聊,手打同一句话也不受队列限制");
  assert.equal(why(task({ workflowMode: "free" }), sess({ id: "a", role: "reviewer" }), { reviewBlocker: null, blockedBy: [running] }), null,
    "审查档:旁路回合,派审本来就不查队列");
  assert.equal(retryTurnActionOf("review"), "继续本轮审查", "留痕跟按钮同名");
  assert.equal(retryTurnActionOf("turn"), "重试这一回合");
}
// 被队列挡回的那一句(/run、/fire、认领占位、续跑档共用):说出是谁在挡,不说「队列前面」。
{
  const members = [
    { id: "a", position: 0, title: "排第一的", status: "paused" },
    { id: "b", position: 1, title: "", status: "done" },
    { id: "c", position: 4, title: "在跑的", status: "running" },
    { id: "d", position: 2, title: "续聊中的已完成成员", status: "running", followUpFrom: "done" },
  ];
  const described = describeQueueBlockers(members, ["a", "c"]);
  assert.deepEqual(described.map((b) => b.id), ["c", "a"], "在跑的排在前面:那句话只点名第一条");
  assert.equal(described[0]!.running, true);
  assert.equal(described[1]!.running, false, "排在前面没完的不叫在跑");
  assert.equal(describeQueueBlockers(members, ["d"])[0]!.running, false, "终态续聊按原终态看");
  assert.equal(describeQueueBlockers(members, ["b"])[0]!.title, "b", "没有标题就用 id 顶上");
  assert.match(queueBlockedText(described.slice(0, 1)), /^同一队列里「在跑的」正在运行/);
  assert.match(queueBlockedText(described.slice(1)), /^同一队列里排在前面的「排第一的」还没完成/);
  assert.match(queueBlockedText(described), /^同一队列里「在跑的」等 2 条任务/, "多条时写第一条加「等 N 条」");
  for (const text of [queueBlockedText(described), queueBlockedText(described.slice(0, 1)), queueBlockedText([])]) {
    assert.doesNotMatch(text, /队列前面/);
  }
}
// 能不能重投:是 user 段且去掉附件标记后还剩点东西。
assert.equal(resendInputOf(lastInputOf(turn("user", "把标题也改一下")))?.text, "把标题也改一下");
assert.equal(resendInputOf(lastInputOf(turn("user", "   "))), null, "空话没得重投,落续跑档");
assert.equal(resendInputOf(lastInputOf(turn("system", "继续（从中断处）"))), null, "系统续跑提示不重投");
assert.equal(resendInputOf(null), null, "没有输入段");
// profile 可编辑可删:改一次模型就换了个脑子,改一次供应商就换了套账号。「原样再跑一遍」
// 的前提是那套执行环境还在,对不上就得让用户明确决定,不能拿新环境冒充原样重放。
assert.ok(why(task(), sess({ id: "a" }), { profileDrift: "missing" }), "执行器被删了,重跑不了");
assert.ok(why(task(), sess({ id: "a" }), { profileDrift: "changed" }), "执行器配置被改过,不是原样重放");
assert.equal(why(task(), sess({ id: "a" }), { profileDrift: null }), null, "环境没变(或老会话行无从核对)→ 放行");
assert.ok(
  why(task({ workflowMode: "free" }), sess({ id: "a", role: "reviewer" }), { reviewBlocker: null, profileDrift: "changed" }),
  "审查档同吃这一条:它重跑引的是同一条可变 profile",
);

// ── 审查会话崩了：走审查那条路重跑，而不是拒绝，也不是拿实现 agent 顶上 ──────
const reviewer = sess({ id: "a", role: "reviewer" });
assert.equal(retryTurnKindOf(reviewer), "review", "reviewer 会话走审查档");
assert.equal(retryTurnKindOf(sess({ id: "a" })), "turn", "普通会话走重投档");
assert.equal(
  why(task({ workflowMode: "free", status: "done" }), reviewer, { reviewBlocker: null }),
  null,
  "自由工作流里崩掉的审查回合 → 放行(交给审查链重跑这一轮)",
);
assert.ok(why(task(), reviewer, { reviewBlocker: null }), "不是自由工作流的审查会话没有可重跑的链");
assert.ok(
  why(task({ workflowMode: "free" }), reviewer, { reviewBlocker: "最近一轮审查没有停在异常结束状态" }),
  "审查链本身不可重跑时,原样把理由抛给前端",
);
// 审查档不看 done：审查回合是旁路回合,任务停在哪个终态都可能(paused 上派审也合法)。
assert.equal(
  why(task({ workflowMode: "free", status: "canceled" }), reviewer, { reviewBlocker: null }),
  null,
  "审查档不要求任务停在 done",
);
// 审查档不看退出码：CLI 报错后照样 exit 0（实测「API Error: Connection lost mid-response」），
// 而那一轮一个结论都没给，审查链已经停在 failed 并在时间线上写了「未能正常给出结论」。
// 拿退出码当门槛的话，这种局面下整页没有任何重来的入口 —— 用户看到的就是「按钮坏了」。
assert.equal(
  why(task({ workflowMode: "free" }), sess({ id: "a", role: "reviewer", exitStatus: 0 }), { reviewBlocker: null }),
  null,
  "审查回合 exit 0 但这一轮没出结论 → 放行(判据是审查链自己的 error/failed)",
);
assert.equal(
  why(task({ workflowMode: "free" }), sess({ id: "a", role: "reviewer", exitStatus: null }), { reviewBlocker: null }),
  null,
  "审查回合连退出码都没落 → 仍看审查链的判据",
);
assert.ok(
  why(task({ workflowMode: "free" }), sess({ id: "a", role: "reviewer", exitStatus: 0 }), { reviewBlocker: "最近一轮审查没有停在异常结束状态" }),
  "审查链正常收尾的 exit 0 照旧拒绝",
);
assert.ok(
  why(task({ workflowMode: "free" }), sess({ id: "a", role: "reviewer", exitStatus: 0, stoppedAs: "canceled" }), { reviewBlocker: null }),
  "手动停掉的审查回合仍不算崩溃",
);
// ── 审查档按那一轮审查的身份来(`kind: "review"`),不按最新会话分档 ───────────────────
// 下一次自由审查第 1 轮 R1:审查等用户拿主意时跑一条 `/compact`,最新会话成了那条普通旁路
// 回合 —— 按最新会话分档,拿审查会话来点 409「不是最新一次」,拿最新会话来点 409「不是异常
// 结束」。审查档只问审查链自己(reviewBlocker,里面含身份/代次核对)。
const compactTurn = sess({ id: "c", role: "single", exitStatus: 0, sideTurn: true });
assert.ok(why(task({ workflowMode: "free" }), compactTurn, { reviewBlocker: null }),
  "老请求(只带 sessionId)照旧按最新会话分档:那条旁路回合不给重跑");
assert.equal(why(task({ workflowMode: "free" }), reviewer, { kind: "review", reviewBlocker: null }), null,
  "按审查身份来的:落点是这一轮输入进过的那条会话(readRetryTurnFacts 按交付凭据给),之后插进来的旁路回合不算数");
assert.equal(why(task({ workflowMode: "free" }), null, { kind: "review", reviewBlocker: null }), null,
  "一条审查会话都没有(崩在起跑前)也放行:服务端按审查身份重跑,从头交代任务书");
assert.equal(
  why(task({ workflowMode: "free" }), reviewer, { kind: "review", reviewBlocker: "页面上的这一轮审查已经变了（被重跑过或换了一轮），刷新后再试" }),
  "页面上的这一轮审查已经变了（被重跑过或换了一轮），刷新后再试", "身份/代次对不上 → 原样拒绝");
assert.ok(why(task(), reviewer, { kind: "review", reviewBlocker: null }), "不是自由工作流就没有审查档");
assert.ok(why(task({ workflowMode: "free", status: "running" }), reviewer, { kind: "review", reviewBlocker: null }),
  "审查档同样不在任务跑着时插进来");
assert.ok(why(task({ workflowMode: "free" }), { ...reviewer, stoppedAs: "canceled" }, { kind: "review", reviewBlocker: null }),
  "审查档:手动停掉的那条审查回合仍不算");
// 其余身份(团队调度台、duet 双声道)连「上一回合」的形状都不一样。
assert.ok(why(task(), sess({ id: "a", role: "lead" })), "调度台会话不归这颗按钮");
assert.ok(why(task(), sess({ id: "a", role: "voiceA" })), "duet 会话不归这颗按钮");
// 重投档不跟着放松：续聊聊天回合本来就不调 complete_task，exit 0 给按钮等于每次闲聊后
// 都挂一颗「重试」。
assert.ok(why(task(), sess({ id: "a", role: "single", exitStatus: 0 })), "普通回合 exit 0 仍然不给");

// ── 共用判据本身:三个信号的优先级(@ash/shared/turn-outcome) ───────────────────
// 这一份被**前端那颗按钮读着同一个函数**(web/src/task-detail/turnRetry.ts),所以优先级直接
// 钉在这儿,而不是只通过 retryTurnRejection 间接测 —— 审查 F2 要修的那一条恰恰是同一句判据
// 在两端各错一次。
{
  const abnormal = (turn: Parameters<typeof turnEndedAbnormally>[0]) => turnEndedAbnormally(turn);
  // ① 真人按下的停止排最前:CLI 吃 SIGTERM 后按 signal 写非零退出码,跟崩溃一模一样。
  assert.equal(abnormal({ exitStatus: 1, stoppedAs: "canceled" }), false, "手动停止不是异常结束");
  assert.equal(
    abnormal({ exitStatus: 1, stoppedAs: "canceled", turnOutcome: "failed" }),
    false,
    "手动停止压得住权威结局 —— 否则用户刚停下的那句话会被重跑",
  );
  // ② 有权威结局就完全听它(只认 failed)。
  assert.equal(abnormal({ exitStatus: 0, turnOutcome: "failed" }), true, "exit 0 + 区间 failed = 被我们终止的那一轮");
  assert.equal(abnormal({ exitStatus: null, turnOutcome: "failed" }), true, "退出码没写成也认权威结局");
  assert.equal(abnormal({ exitStatus: 1, turnOutcome: "completed" }), false, "权威结局说好着呢,非零退出码也不算");
  assert.equal(abnormal({ exitStatus: 1, turnOutcome: "stopped" }), false, "受控停止不是异常结束");
  // ③ 不知道权威结局时才退回退出码。
  assert.equal(abnormal({ exitStatus: 1 }), true, "存量行/回合还开着 → 退回退出码");
  assert.equal(abnormal({ exitStatus: 1, turnOutcome: null }), true, "null = 不知道,同上");
  assert.equal(abnormal({ exitStatus: 0 }), false, "正常退出");
  assert.equal(abnormal({ exitStatus: null }), false, "还没结算不算异常结束");
}

// ── 权威结局优先于退出码(审查 F2,已实测) ──────────────────────────────────────
// 回合级停滞看门狗终止掉的那一轮:ash 已经判它失败(区间 outcome=failed、正文写明「已自动
// 终止本回合并按失败结算」),而被终止的进程多半以 exit 0 收流。照退出码判就是 409
// 「上一回合不是异常结束」,而页面同时明写着它被自动终止 —— 用户没有任何重来的入口。
assert.equal(
  why(task(), sess({ id: "a", exitStatus: 0 }), { turnOutcome: "failed" }),
  null,
  "被看门狗终止的那一轮(exit 0 + 区间 failed)必须放行重投",
);
assert.equal(
  why(task(), sess({ id: "a", exitStatus: null }), { turnOutcome: "failed" }),
  null,
  "退出码没写成、但 ash 已判这一轮失败,同样放行",
);
// 上面那一条不许把闲聊也放进来:**只认 failed**。续聊的聊天回合本来就不调 complete_task,
// 它的区间是 completed —— 跟着放松就等于每次闲聊后都挂一颗「重试」(紧挨着的那条断言)。
assert.ok(
  why(task(), sess({ id: "a", exitStatus: 0 }), { turnOutcome: "completed" }),
  "正常完成的回合仍然不给",
);
assert.ok(
  why(task(), sess({ id: "a", exitStatus: 0 }), { turnOutcome: "stopped" }),
  "受控停止的回合仍然不给",
);
// 真人按下的停止优先级更高:它连权威失败结局都压得住(stoppedAs 那道闸排在前面)。
assert.ok(
  why(task(), sess({ id: "a", exitStatus: 0, stoppedAs: "canceled" }), { turnOutcome: "failed" }),
  "手动停止的那一轮不许靠权威结局绕过 stoppedAs 那道闸",
);

console.log("✓ retry-turn gate");
