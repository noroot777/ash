// claude 单飞「回合说完了、后台还有工作在跑」的生命周期(任务 SGK-4lWyRQCX;自由审查 c2vZ4d3LmL1q、
// i8RAcPM3zvgD):先不收台、空档插话直接送、到期杀进程、进程退了按未完成结算,以及「后台跑完」与
// 「下一回合开始」分开判。都是假常驻句柄直接喂 `singleRunFromResident`;真实 CLI 子进程那一路在
// test-claude-reattach-background.ts。从 test-native-steer.ts 拆出来(那份逼近 700 行)。
import assert from "node:assert/strict";
import type { AgentEvent } from "@ash/shared";
import { singleRunFromResident } from "../src/executors/claude.js";
import type { ResidentHandle } from "../src/executors/types.js";

function eventQueue() {
  const events: AgentEvent[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  return {
    push(event: AgentEvent) { events.push(event); wake?.(); wake = null; },
    end() { ended = true; wake?.(); wake = null; },
    stream: (async function* () {
      while (true) {
        if (events.length) { yield events.shift()!; continue; }
        if (ended) return;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    })(),
  };
}

// 回合说完了、后台还有工作流没跑完（任务 SGK-4lWyRQCX）：先不收台，读到它跑完后 CLI 自己开的
// 那一回合的结尾才收；空档里没有回合可打断，插话直接送进去。
const holdEvents = eventQueue();
const holdCalls: string[] = [];
let holdActive = true;
const holdResident: ResidentHandle = {
  sessionId: "claude-hold",
  commandLine: "claude hold",
  events: holdEvents.stream,
  interrupt: () => { holdCalls.push("interrupt"); },
  send: (text) => { holdCalls.push(`send:${text}`); holdActive = true; return true; },
  turnActive: () => holdActive,
  close: () => { holdCalls.push("close"); holdEvents.end(); },
  kill: () => { holdCalls.push("kill"); holdEvents.end(); },
  cleanup: async () => ({ kind: "empty" } as const),
};
const hold = singleRunFromResident(holdResident);
const holdIterator = hold.events[Symbol.asyncIterator]();
holdEvents.push({ kind: "text", text: "已在后台跑起来" });
assert.deepEqual(await holdIterator.next(), { value: { kind: "text", text: "已在后台跑起来" }, done: false });
holdActive = false;
holdEvents.push({ kind: "turnEnd", background: { agent: 0, workflow: 1 } });
await new Promise<void>((resolve) => setImmediate(resolve));
await hold.steer!("进度如何");
assert.deepEqual(holdCalls, ["send:进度如何"], "空档里插话不打断、直接送进去，也不收台");
holdEvents.push({ kind: "text", text: "工作流的结果" });
assert.deepEqual(await holdIterator.next(), { value: { kind: "text", text: "工作流的结果" }, done: false },
  "后台还有工作流时回合结尾不结算");
holdEvents.push({ kind: "turnEnd" });
assert.deepEqual(await holdIterator.next(), { value: { kind: "done", exitStatus: 0 }, done: false });
assert.equal(holdCalls.at(-1), "close", "后台的活跑完之后那一回合结尾才收台");
assert.equal(hold.failure?.() ?? null, null, "正常等到后台跑完不留失败结论");
console.log("✓ Claude 后台工作流没跑完先不收台，空档插话直接送达");

// 等到时限还没跑完:硬杀(关 stdin 它可以不走)、报真错误,并把「未完成」交给结算 —— 智能体
// 也可能早就交过卷,不能让它落成完成。
const expiryEvents = eventQueue();
const expiryCalls: string[] = [];
const expiryResident: ResidentHandle = {
  sessionId: "claude-hold-expiry",
  commandLine: "claude hold",
  events: expiryEvents.stream,
  interrupt: () => { expiryCalls.push("interrupt"); },
  send: () => true,
  turnActive: () => false,
  close: () => { expiryCalls.push("close"); },
  kill: () => { expiryCalls.push("kill"); expiryEvents.push({ kind: "done", exitStatus: 0 }); expiryEvents.end(); },
  cleanup: async () => ({ kind: "empty" } as const),
};
// 收台定时器 unref 了(不替 ash 拖住退出),测试进程里得另有东西撑着事件循环。
const keepAlive = setInterval(() => {}, 1000);
const expiry = singleRunFromResident(expiryResident, undefined, 30);
const expiryIterator = expiry.events[Symbol.asyncIterator]();
expiryEvents.push({ kind: "turnEnd", background: { agent: 1, workflow: 0 } });
const expiryError = await expiryIterator.next();
assert.deepEqual(expiryCalls, ["kill"], "到点直接杀,不靠关 stdin 请它退出");
assert.equal(expiryError.value?.kind, "error");
assert.equal((expiryError.value as any).level, undefined, "超时是真错误,不是过程提示");
assert.match((expiryError.value as any).message, /按未完成结算/);
assert.deepEqual(await expiryIterator.next(), { value: { kind: "done", exitStatus: 0 }, done: false });
assert.equal(expiry.failure?.()?.kind, "background_timeout", "超时结论交给结算");
console.log("✓ Claude 后台工作等到时限：杀进程、报错、按未完成结算");

/**
 * 一个只会吐事件的假常驻句柄;`turnStart` 模拟 CLI 自己开了一回合(回合身份 +1)。`killEnds=false`
 * 模拟收到 SIGTERM 还没退、等着升级 SIGKILL 的进程:kill 之后流先不结束。给了 `ledger` 就带上
 * 实时后台账本(ResidentHandle.backgroundPending),改它的字段 = 后台跑完/核实不了。
 */
function fakeResident(name: string, killEnds = true, ledger?: { agent: number; workflow: number; unknown?: true }) {
  const queue = eventQueue();
  const calls: string[] = [];
  let epoch = 0;
  const handle: ResidentHandle = {
    sessionId: name,
    commandLine: "claude hold",
    events: queue.stream,
    interrupt: () => { calls.push("interrupt"); },
    send: () => true,
    turnActive: () => false,
    epoch: () => epoch,
    ...(ledger ? { backgroundPending: () => ({ ...ledger }) } : {}),
    close: () => { calls.push("close"); queue.push({ kind: "done", exitStatus: 0 }); queue.end(); },
    kill: () => { calls.push("kill"); if (killEnds) { queue.push({ kind: "done", exitStatus: 0 }); queue.end(); } },
    cleanup: async () => ({ kind: "empty" } as const),
  };
  return { queue, calls, handle, turnStart: () => { epoch += 1; }, epoch: () => epoch };
}
const settle = async (run: ReturnType<typeof singleRunFromResident>) => {
  const out: AgentEvent[] = [];
  for await (const event of run.events) out.push(event);
  return out;
};

// 等后台时进程自己退了(exit 0、没有完成通知):不是跑完了。
{
  const fake = fakeResident("claude-hold-lost");
  const run = singleRunFromResident(fake.handle, undefined, 60_000);
  fake.queue.push({ kind: "turnEnd", background: { agent: 0, workflow: 1 } });
  fake.queue.push({ kind: "done", exitStatus: 0 });
  fake.queue.end();
  const out = await settle(run);
  assert.equal(out.at(-1)?.kind, "done");
  assert.ok(out.some((e) => e.kind === "error" && /还没跑完，智能体进程就退出了/.test(e.message)), "报真错误");
  assert.equal(run.failure?.()?.kind, "background_lost", "按未完成结算");
}
// 不在等后台、但进程没了的那一刻账上还有没跑完的:同样不是跑完了。
{
  const fake = fakeResident("claude-unfinished-exit");
  const run = singleRunFromResident(fake.handle, undefined, 60_000);
  fake.queue.push({ kind: "done", exitStatus: 0, unfinished: { agent: 1, workflow: 0 } });
  fake.queue.end();
  const out = await settle(run);
  assert.ok(out.some((e) => e.kind === "error" && /1 个后台子代理/.test(e.message)));
  assert.equal(run.failure?.()?.kind, "background_lost");
}
// 用户停止:停止自有结算,不另判「后台丢了」。
{
  const fake = fakeResident("claude-hold-stopped");
  const run = singleRunFromResident(fake.handle, undefined, 60_000);
  const iterator = run.events[Symbol.asyncIterator]();
  fake.queue.push({ kind: "turnEnd", background: { agent: 0, workflow: 1 } });
  fake.queue.push({ kind: "text", text: "等着" });
  await iterator.next();
  run.kill();
  assert.deepEqual(await iterator.next(), { value: { kind: "done", exitStatus: 0 }, done: false });
  assert.equal(run.failure?.() ?? null, null);
}
console.log("✓ Claude 后台没跑完进程就退了:按未完成结算,用户停止除外");

// CLI 自己开了下一回合(完成通知到了、主智能体在整理结果):等后台的期限作废,整理慢不算超时。
// 两种先后都要对:定时器已经建起来之后才开回合;开回合在先、那个结尾排着队后到(第 2 轮 R2:
// 一整块 stdout 里「结尾 → 完成通知 → 新回合」一起到,解析先跑完,消费后到)。
for (const order of ["armed-first", "turn-first"] as const) {
  const fake = fakeResident(`claude-hold-${order}`);
  const run = singleRunFromResident(fake.handle, undefined, 30);
  const iterator = run.events[Symbol.asyncIterator]();
  if (order === "turn-first") fake.turnStart();
  fake.queue.push({ kind: "turnEnd", background: { agent: 0, workflow: 1 }, epoch: 0 });
  fake.queue.push({ kind: "text", text: "开始整理" });
  assert.deepEqual(await iterator.next(), { value: { kind: "text", text: "开始整理" }, done: false });
  if (order === "armed-first") fake.turnStart();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(fake.calls, [], `${order}: 期限作废了,不杀`);
  fake.queue.push({ kind: "turnEnd", epoch: fake.epoch() });
  assert.deepEqual(await iterator.next(), { value: { kind: "done", exitStatus: 0 }, done: false });
  assert.equal(run.failure?.() ?? null, null, `${order}: 整理慢不算后台超时`);
}
// 过期的普通结尾也不收台:消费到它时插话开的新回合已经在跑了。
{
  const fake = fakeResident("claude-stale-end");
  const run = singleRunFromResident(fake.handle, undefined, 60_000);
  const iterator = run.events[Symbol.asyncIterator]();
  fake.turnStart();
  fake.queue.push({ kind: "turnEnd", epoch: 0 });
  fake.queue.push({ kind: "text", text: "插话之后" });
  assert.deepEqual(await iterator.next(), { value: { kind: "text", text: "插话之后" }, done: false });
  assert.deepEqual(fake.calls, [], "过期结尾不收台");
  fake.queue.push({ kind: "turnEnd", epoch: fake.epoch() });
  assert.deepEqual(await iterator.next(), { value: { kind: "done", exitStatus: 0 }, done: false });
}
// 用户停止临近到期、进程还没退(等 SIGKILL 升级):旧期限不补报超时。
{
  const fake = fakeResident("claude-stop-near-expiry", false);
  const run = singleRunFromResident(fake.handle, undefined, 30);
  const iterator = run.events[Symbol.asyncIterator]();
  fake.queue.push({ kind: "turnEnd", background: { agent: 0, workflow: 1 }, epoch: 0 });
  fake.queue.push({ kind: "text", text: "等着" });
  await iterator.next();
  run.kill();
  await new Promise((resolve) => setTimeout(resolve, 80));
  fake.queue.push({ kind: "done", exitStatus: 0 });
  fake.queue.end();
  assert.deepEqual(await iterator.next(), { value: { kind: "done", exitStatus: 0 }, done: false }, "没有额外的超时错误");
  assert.equal(run.failure?.() ?? null, null);
  assert.deepEqual(fake.calls, ["kill"], "只有用户那一次 kill");
}
// 进程退出时后台跑没跑完核实不了:单独一种判决,不说成「没跑完」,也不当跑完了。
{
  const fake = fakeResident("claude-unverified-exit");
  const run = singleRunFromResident(fake.handle, undefined, 60_000);
  fake.queue.push({ kind: "done", exitStatus: 0, unfinished: { agent: 0, workflow: 0, unknown: true } });
  fake.queue.end();
  const out = await settle(run);
  assert.ok(out.some((e) => e.kind === "error" && /确认不了后台工作跑没跑完/.test(e.message)));
  assert.equal(run.failure?.()?.kind, "background_unverified");
}
console.log("✓ Claude 等后台的期限按回合身份作废:先开回合后到结尾、停止临近到期、过期结尾都对");

// 后台跑完了(账本归零)和下一回合开始是两件事(自由审查 i8RAcPM3zvgD R2):到期时账上已经都跑完,
// 不判后台超时,改等收尾;收尾也等不来,如实判「没开始整理结果」。
{
  const ledger = { agent: 0, workflow: 1 };
  const fake = fakeResident("claude-settled-at-deadline", true, ledger);
  const run = singleRunFromResident(fake.handle, undefined, 30, 60);
  const iterator = run.events[Symbol.asyncIterator]();
  fake.queue.push({ kind: "turnEnd", background: { agent: 0, workflow: 1 }, epoch: 0 });
  fake.queue.push({ kind: "text", text: "等着" });
  await iterator.next();
  ledger.workflow = 0; // 完成通知到了,但没有事件流到单飞这一层
  await new Promise((resolve) => setTimeout(resolve, 55));
  assert.deepEqual(fake.calls, [], "到期时账上都跑完了:不判后台超时");
  const error = await iterator.next();
  assert.equal(error.value?.kind, "error");
  assert.match((error.value as any).message, /都跑完了/);
  assert.deepEqual(fake.calls, ["kill"], "收尾等不来才杀");
  assert.equal(run.failure?.()?.kind, "wrapup_missing");
}
// 完成通知一到(随便一条事件流过来),等后台的责任就结束;之后开了回合,收尾的期限也作废。
{
  const ledger = { agent: 1, workflow: 0 };
  const fake = fakeResident("claude-settled-then-turn", true, ledger);
  const run = singleRunFromResident(fake.handle, undefined, 30, 60);
  const iterator = run.events[Symbol.asyncIterator]();
  fake.queue.push({ kind: "turnEnd", background: { agent: 1, workflow: 0 }, epoch: 0 });
  ledger.agent = 0;
  fake.queue.push({ kind: "text", text: "子代理完成" });
  await iterator.next();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(fake.calls, [], "账本归零之后旧期限不再判后台超时");
  fake.turnStart();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(fake.calls, [], "开了回合,收尾期限作废");
  fake.queue.push({ kind: "turnEnd", epoch: fake.epoch() });
  assert.deepEqual(await iterator.next(), { value: { kind: "done", exitStatus: 0 }, done: false });
  assert.equal(run.failure?.() ?? null, null);
}
// 到期时账上已知的都跑完、但接管时读不出之前的输出:按核实不了判,不说成「还没跑完」。
{
  const fake = fakeResident("claude-unknown-at-deadline", true, { agent: 0, workflow: 0, unknown: true });
  const run = singleRunFromResident(fake.handle, undefined, 30, 60_000);
  const out = settle(run);
  fake.queue.push({ kind: "turnEnd", background: { agent: 0, workflow: 0 }, epoch: 0 });
  const events = await out;
  assert.ok(events.some((e) => e.kind === "error" && /确认不了后台工作跑没跑完/.test(e.message)));
  assert.equal(run.failure?.()?.kind, "background_unverified");
}
// 在等着的时候进程退了、账上都跑完了:是没开始收尾,不是后台丢了。
{
  const fake = fakeResident("claude-settled-exit", true, { agent: 0, workflow: 0 });
  const run = singleRunFromResident(fake.handle, undefined, 60_000, 60_000);
  fake.queue.push({ kind: "turnEnd", background: { agent: 0, workflow: 1 }, epoch: 0 });
  fake.queue.push({ kind: "done", exitStatus: 0 });
  fake.queue.end();
  const out = await settle(run);
  assert.ok(out.some((e) => e.kind === "error" && /都跑完了/.test(e.message)));
  assert.ok(!out.some((e) => e.kind === "error" && /还没跑完/.test(e.message)));
  assert.equal(run.failure?.()?.kind, "wrapup_missing");
}
clearInterval(keepAlive);
console.log("✓ Claude 后台跑完与开回合分开判:到期先核账本,跑完了只等收尾,原因如实");
console.log("claude 单飞等后台回归通过");
