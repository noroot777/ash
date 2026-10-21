/**
 * codex 的「会话级常驻」状态机(`openCodexResident`)。
 *
 * 用假 CLI 驱动,不打真模型 —— 这里要钉的是**状态机**,不是 codex 本身:
 *   ①一个进程一个回合,但 events 流直到 close()/kill() 才结束(done 换 turnEnd)
 *   ②回合进行中来的消息排队,前一个回合结束后依次跑,不并发
 *   ③thread_id 由首回合回填,后续回合必须带着它 `resume`
 *   ④interrupt 杀当前回合、不结束会话;close 等手头这轮跑完;kill 立刻收摊
 *   ⑤openCodexResident 一返回,commandLine 就得是真的(调用方立刻写进 sessions 表)
 *   ⑥恢复 thread 被判 poisoned 后,下一回合必须 fresh
 *   ⑦cleanup 覆盖**这个会话起过的每一个回合**,且幂等
 *
 * codex CLI 本身的行为(resume 保持 thread_id、被杀后会话仍可续)是 2026-08-01
 * 手工实测过的,结论记在 executors/codex-resident.ts 头部,不在这里重复验证。
 */
import type { CleanupResult } from "../src/executors/kill.js";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@ash/shared";

const { openCodexResident } = await import("../src/executors/codex-resident.js");

const dir = mkdtempSync(join(tmpdir(), "ash-codex-resident-"));
let bad = 0;
const fail = (m: string) => { console.log("   ✕ " + m); bad++; };
const ok = (m: string) => console.log("   ✓ " + m);

// 假 codex:吐一个 thread.started + 一条 agent_message,然后退出。
// `--slow` 让它先睡一会,用来测「回合进行中来的消息要排队」和 interrupt。
const STUB = join(dir, "fake-codex.mjs");
writeFileSync(
  STUB,
  `const args = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const resumeAt = args.indexOf("resume");
const threadId = resumeAt >= 0 ? args[resumeAt + 1] : "thread-generated-1";
emit({ type: "thread.started", thread_id: threadId });
const say = () => {
  emit({ type: "item.completed", item: { type: "agent_message", text: "回合:" + args[args.length - 1] } });
  emit({ type: "turn.completed" });
  process.exit(0);
};
if (args.includes("--slow")) setTimeout(say, 3000); else say();
`,
);

/** 造一个跑假 CLI 的常驻会话;prompt 直接当最后一个 argv 传进去便于断言。 */
function open(opts: {
  slow?: boolean; poisonFirst?: boolean; slowFinalize?: boolean;
  /** 让 finalizeTurn 回「还没收干净」,用来钉「这种结论不许把回合从待收册上划掉」。 */
  finalizeResult?: CleanupResult;
} = {}) {
  const spawned: string[][] = [];
  const finalized: number[] = [];
  const handle = openCodexResident({
    initialSessionId: "",
    initialPrompt: "第一条",
    startTurn: (prompt, sessionId) => {
      const args = [STUB, ...(sessionId ? ["resume", sessionId] : []), ...(opts.slow ? ["--slow"] : []), prompt];
      spawned.push(args);
      const turnNumber = spawned.length;
      const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"] });
      child.stdin?.end();
      const lifecycle = { stopRequested: false };
      return {
        child,
        commandLine: `fake-codex ${args.join(" ")}`,
        lifecycle,
        events: parse(child, opts.poisonFirst === true && turnNumber === 1),
      };
    },
    killTurn: (child) => child.kill("SIGTERM"),
    // 真实实现是 cleanupAfterRun(回收这一轮甩到后台的后代);这里只记「谁被收过」。
    finalizeTurn: async (child) => {
      // slowFinalize:真的 cleanupAfterRun 要等 SIGTERM→2s→SIGKILL,快不了。只有这样才分得清
      // 「cleanup 返回了」和「清理真的做完了」。
      if (opts.slowFinalize) await new Promise((r) => setTimeout(r, 150));
      finalized.push(child.pid ?? -1);
      // 返回的是三档结论(executors/kill.ts 的 `CleanupResult`):句柄按它决定能不能把这一轮
      // 从待收册上划掉。夹具这边就是「确证清空」—— ⑪ 另有一条专门钉「没收干净不许划掉」。
      return opts.finalizeResult ?? { kind: "empty" };
    },
  });
  return { handle, spawned, finalized };
}

/** 极简 codex 事件解析(真的那份在 codex.ts,这里只要够驱动状态机)。 */
async function* parse(child: ReturnType<typeof spawn>, poisoned = false): AsyncIterable<AgentEvent> {
  const queue: AgentEvent[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  const push = (e: AgentEvent) => { queue.push(e); wake?.(); wake = null; };
  let buf = "";
  child.stdout?.on("data", (d) => {
    buf += d.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const ev = JSON.parse(line);
      if (ev.type === "thread.started") push({ kind: "session", cliSessionId: ev.thread_id });
      else if (ev.item?.type === "agent_message") push({ kind: "text", text: ev.item.text });
    }
  });
  child.on("close", (code) => {
    done = true;
    if (poisoned) {
      push({
        kind: "error",
        message: "Codex 会话诊断：session=poisoned_session；Codex stderr 出现 `dropping turn-scoped item for unknown turn id`，恢复 thread 已无法对应旧回合。",
      });
    }
    push({ kind: "done", exitStatus: code ?? 0 });
  });
  while (true) {
    if (queue.length) { yield queue.shift()!; continue; }
    if (done) return;
    await new Promise<void>((r) => (wake = r));
  }
}

/**
 * 订阅事件流。**必须长期订阅、不能中途 break** —— `for await` 一 break 就把
 * async generator 关掉了,后面再迭代同一个 events 直接空转。真实调用方
 * (team/session.ts 的 consume)也是一个长期循环,这里照着来。
 */
function subscribe(events: AsyncIterable<AgentEvent>) {
  const all: AgentEvent[] = [];
  const finished = (async () => {
    for await (const event of events) all.push(event);
  })();
  const turns = () => all.filter((e) => e.kind === "turnEnd").length;
  return {
    all,
    turns,
    finished,
    /** 等到第 n 个回合收尾(超时就放弃,让断言去报真正的问题)。 */
    async waitTurns(n: number, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (turns() < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    },
  };
}

console.log("1) 首回合同步起,commandLine 立刻可读");
{
  const { handle, spawned } = open();
  if (handle.commandLine.includes("第一条")) ok("openResident 返回时 commandLine 已就位");
  else fail(`commandLine 还是空的:${JSON.stringify(handle.commandLine)}`);
  if (spawned.length === 1) ok("首回合已经起了进程");
  else fail(`期望 1 个进程,实到 ${spawned.length}`);
  const sub = subscribe(handle.events);
  await sub.waitTurns(1);
  if (!sub.all.some((e) => e.kind === "done")) ok("done 被吞掉了(流不能在回合结束时断)");
  else fail("done 漏了出去 —— 上层会以为调度台死了");
  if (sub.all.at(-1)?.kind === "turnEnd") ok("回合以 turnEnd 收尾");
  else fail(`最后一个事件是 ${sub.all.at(-1)?.kind}`);
  if (handle.sessionId === "thread-generated-1") ok("thread_id 已回填");
  else fail(`sessionId=${JSON.stringify(handle.sessionId)}`);
  handle.kill();
  await sub.finished;
}

console.log("2) 后续回合带着 thread_id resume,且严格串行");
{
  const { handle, spawned } = open();
  const sub = subscribe(handle.events);
  await sub.waitTurns(1); // 等首回合结束,拿到 thread_id
  handle.send("第二条");
  handle.send("第三条");
  await sub.waitTurns(3);
  if (spawned.length === 3) ok("三条消息 = 三个回合");
  else fail(`期望 3 个进程,实到 ${spawned.length}`);
  const resumed = spawned.slice(1).every((args) => args.includes("resume") && args.includes("thread-generated-1"));
  if (resumed) ok("第二、三回合都 resume 了同一个 thread");
  else fail(`resume 参数不对:${JSON.stringify(spawned.slice(1))}`);
  if (spawned[1]?.at(-1) === "第二条" && spawned[2]?.at(-1) === "第三条") ok("按发送顺序依次跑");
  else fail(`顺序错了:${spawned.map((a) => a.at(-1)).join(",")}`);
  handle.kill();
  await sub.finished;
}

console.log("3) 回合进行中来的消息排队,不并发");
{
  const { handle, spawned } = open({ slow: true });
  const sub = subscribe(handle.events);
  handle.send("插队的");
  // 首回合要跑 3 秒;这一刻队列里躺着第二条,但进程只该有一个。
  await new Promise((r) => setTimeout(r, 300));
  if (spawned.length === 1) ok("回合进行中不另起进程");
  else fail(`并发了:${spawned.length} 个进程`);
  handle.kill();
  await sub.finished;
}

console.log("4) interrupt 杀当前回合,会话还活着");
{
  const { handle, spawned } = open({ slow: true });
  const sub = subscribe(handle.events);
  const started = Date.now();
  setTimeout(() => handle.interrupt(), 300);
  await sub.waitTurns(1);
  const elapsed = Date.now() - started;
  if (elapsed < 2500) ok(`被打断的回合提前收尾(${elapsed}ms < 3000ms)`);
  else fail(`interrupt 没起作用,等满了 ${elapsed}ms`);
  handle.send("打断之后还能说话");
  await sub.waitTurns(2);
  if (spawned.length === 2) ok("打断后照常开下一个回合");
  else fail(`期望 2 个回合,实到 ${spawned.length}`);
  handle.kill();
  await sub.finished;
}

console.log("5) close 等手头这轮跑完;kill 立刻收摊");
{
  const { handle } = open();
  const sub = subscribe(handle.events);
  handle.close();
  await sub.finished; // close 之后流必须自己结束,不是卡在那等
  if (sub.turns() === 1) ok("close 后手头这轮仍跑完,然后流正常结束");
  else fail(`close 把回合掐了或没收尾:turnEnd × ${sub.turns()}`);
}
{
  const { handle, spawned } = open({ slow: true });
  const sub = subscribe(handle.events);
  handle.kill();
  await sub.finished;
  ok("kill 之后事件流立刻结束");
  // 拒收必须**说出来**:调度台靠这个回执决定「这条汇报还欠着」还是「已经送到了」,
  // 拿不到 false 就会把一份执行者汇报当成已投递丢掉(见 ResidentHandle.send)。
  if (handle.send("死了之后不该再起回合") === false) ok("kill 之后 send 明确回执拒收");
  else fail("kill 之后 send 仍报「收下了」—— 调用方会把这条消息当成已投递");
  await new Promise((r) => setTimeout(r, 200));
  if (spawned.length === 1) ok("kill 之后 send 不再起回合");
  else fail(`kill 之后又起了 ${spawned.length - 1} 个回合`);
}

console.log("6) poisoned 回合结束前已排队,下一回合仍 fresh");
{
  const { handle, spawned } = open({ slow: true, poisonFirst: true });
  const sub = subscribe(handle.events);
  handle.send("坏回合进行中就排进来的下一条");
  await sub.waitTurns(2);
  if (!spawned[1]?.includes("resume")) ok("resident 在 pump 下一回合前已作废恢复 id");
  else fail(`下一回合仍在 resume:${JSON.stringify(spawned[1])}`);
  const contradictory = sub.all.some((event) => event.kind === "error" && event.message.includes("没有报出会话 id"));
  if (!contradictory) ok("已收到 thread.started 后判 poisoned，不会再误报没有会话 id");
  else fail("poisoned 清空 id 后又误报没有收到 thread.started");
  handle.kill();
  await sub.finished;
}

// 「会话级常驻」= 一个回合一个进程,所以句柄的清理能力必须覆盖**所有**回合,而不是当前
// 那一个。这条能力以前只长在 codex.ts 的事件包装器上,它要求「流正常走到尽头 + 这条
// thread 在桌面端可见」—— 起跑失败、被杀、普通 exec 会话一条都走不到,等于句柄对外没有
// 清理能力(第 1 轮审查 F1)。
console.log("7) cleanup 覆盖所有已启动回合,且幂等");
{
  const { handle, spawned, finalized } = open();
  const sub = subscribe(handle.events);
  await sub.waitTurns(1);
  handle.send("第二条");
  await sub.waitTurns(2);
  handle.send("第三条");
  await sub.waitTurns(3);
  if (spawned.length === 3) ok("三个回合都起过进程");
  else fail(`期望 3 个回合,实到 ${spawned.length}`);
  if (!finalized.length) ok("正常跑完的回合不会被提前回收(上一轮起的后台服务还能接着用)");
  else fail(`回合正常结束就被回收了:${JSON.stringify(finalized)}`);
  await handle.cleanup();
  if (finalized.length === 3) ok("cleanup 把三个回合的后代一并收掉");
  else fail(`cleanup 只收了 ${finalized.length} 个回合`);
  await handle.cleanup();
  if (finalized.length === 3) ok("重复 cleanup 不再重复动手(幂等)");
  else fail(`第二次 cleanup 又收了一遍:${finalized.length} 次`);
  handle.kill();
  await sub.finished;
}

// 这个句柄以前有一条「最多攒 16 轮未收尾的回合,超了先把最老那一轮收掉」的引用上限。
// 它拿错东西换内存了:finalizeTurn 做的是 cleanupAfterRun —— 把那一轮甩到后台的**所有**
// 后代杀掉,而调度台恰恰是「第 3 轮起一个服务、第 20 轮还在用它」的典型,第 17 轮一到就会
// 把那个服务连根杀掉,而且是静默的(第 2 轮审查 F4)。
console.log("8) 轮次远超旧的 16 轮上限,也不许提前回收任何一轮");
{
  const TURNS = 20;
  const { handle, spawned, finalized } = open();
  const sub = subscribe(handle.events);
  await sub.waitTurns(1);
  for (let i = 2; i <= TURNS; i++) {
    handle.send(`第 ${i} 条`);
    await sub.waitTurns(i);
  }
  if (spawned.length === TURNS) ok(`${TURNS} 个回合都起过进程`);
  else fail(`期望 ${TURNS} 个回合,实到 ${spawned.length}`);
  if (!finalized.length) ok("过了第 17 轮仍然一个都没被回收(上一轮起的服务不会被静默杀掉)");
  else fail(`有回合被提前回收:${JSON.stringify(finalized)}`);
  await handle.cleanup();
  if (finalized.length === TURNS) ok("cleanup 一次把 20 个回合全收齐");
  else fail(`cleanup 只收了 ${finalized.length}/${TURNS} 个回合`);
  handle.kill();
  await sub.finished;
}

// 「收过了」的凭据必须是**那次清理真的做完了**:划掉早于 await 时,第二个 cleanup 看到册上
// 没它就立刻返回,其实清理还在途 —— 调用方(finalizeAbandonedRun)于是在后代还没收干净时
// 就认为收完了(第 2 轮审查 N1)。
console.log("9) 并发 cleanup 等的是在途那份清理,不是「册上没它了」");
{
  const { handle, finalized } = open({ slowFinalize: true });
  const sub = subscribe(handle.events);
  await sub.waitTurns(1);
  handle.send("第二条");
  await sub.waitTurns(2);
  const first = handle.cleanup();
  const second = handle.cleanup();
  await second;
  if (finalized.length === 2) ok("第二个 cleanup 等到了在途那份清理做完才返回");
  else fail(`第二个 cleanup 提前返回了,此刻只收掉 ${finalized.length}/2 个回合`);
  await first;
  if (finalized.length === 2) ok("两个调用合起来也只收一遍(不重复动手)");
  else fail(`重复动手了:${finalized.length} 次`);
  handle.kill();
  await sub.finished;
}

// ⑪ 没收干净的那一轮**留在待收册上**,下一次 cleanup 还会再来收。
// 钉的是本轮审查 F2:上一版把 `finalizeTurn` resolve 当成成功,于是「还有残留 / 这一轮
// 没问清楚」两档也会把回合从册上划掉 —— 而册上那条是这摊后代唯一的线索,划掉之后下一次
// cleanup 看到册上没它便直接返回,再没有人会来追。
console.log("\n11) 没收干净的回合不许从待收册上划掉");
{
  const stale: CleanupResult = { kind: "remaining", detail: "夹具:假装还有后代活着" };
  const { handle, finalized } = open({ finalizeResult: stale });
  const sub = subscribe(handle.events);
  handle.send("一");
  await sub.waitTurns(1);
  const first = await handle.cleanup();
  if (first.kind === "remaining") ok("句柄把「还没收干净」原样往上报(不吞成成功)");
  else fail(`句柄报的是 ${first.kind},应当是 remaining`);
  const collectedOnce = finalized.length;
  if (collectedOnce >= 1) ok("第一次 cleanup 确实动手了");
  else fail("第一次 cleanup 没动手");
  // **再来一次**:册上还留着它,所以这一次必须重新动手(而不是「册上没它 ⇒ 直接返回」)。
  await handle.cleanup();
  if (finalized.length > collectedOnce) ok("留在册上 ⇒ 下一次 cleanup 重新动手(可重试)");
  else fail("第二次 cleanup 没有重试:这一轮已经被当成收完了");
  handle.kill();
  await sub.finished;
}

console.log(bad ? `\n✗ ${bad} 项未通过` : "\n✓ 全部通过");
process.exit(bad ? 1 : 0);
