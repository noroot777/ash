// 内置 Monitor 实时投影的**写库责任**：事件一旦从流里消费掉，来源侧不会再发一遍，库里也没有
// 别的地方能补回来（翻会话记录的历史扫描已经删了）。所以这份回归钉两件事：
//
// ① 一次几百毫秒的读库故障之后，卡片照样落库，回合收尾那条「为什么没唤醒」的说明照样留下
//    （它数的正是这些行）；
// ② 库整个不可用时积压有上界：试满一轮阶梯就熔断，后面的事件不再各排一整轮，流结束那一刻的
//    收尾不会被拖成分钟级；库恢复后同一条流照常落库。
import { db, makeTask, monitors, now, sessions, teardown } from "./monitors-fixture.js";
import { eq } from "drizzle-orm";

const { ClaudeMonitorTrace } = await import("../src/claude-monitors.js");
const { bus } = await import("../src/bus.js");

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  if (ok) return;
  failures += 1;
  console.error(`✗ ${label}${detail ? ` —— ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ORIGIN = { pid: null, pidStartedAt: null, runPath: "" };

/** 像 claude-stream.ts 那样喂一次 Monitor 调用 + 它的 task_started。 */
function startMonitor(trace: InstanceType<typeof ClaudeMonitorTrace>, cli: string, n: string): void {
  const input = { command: `tail -F /tmp/${n}.log`, description: `监听 ${n}` };
  trace.event({ type: "assistant", timestamp: now(), message: { content: [{ type: "tool_use", name: "Monitor", input, id: `tu-${n}` }] } });
  trace.toolUse("Monitor", input, `tu-${n}`);
  trace.event({ type: "system", subtype: "task_started", task_id: `b-${n}`, tool_use_id: `tu-${n}`, task_type: "local_bash", session_id: cli });
}

/** 让 `db.select` 整个抛错（会话定位、认行、查重都走它），返回恢复函数。 */
function breakReads(): () => void {
  const original = db.select.bind(db);
  (db as any).select = () => { throw new Error("INJECTED_SQLITE_BUSY"); };
  return () => { (db as any).select = original; };
}

async function session(name: string): Promise<{ taskId: string; cli: string }> {
  const taskId = await makeTask();
  const cli = `cli-${name}-${taskId}`;
  await db.insert(sessions).values({ id: `s-${name}-${taskId}`, taskId, role: "single", agentType: "claude",
    executor: "claude@test", cliSessionId: cli, cwd: "/tmp/wt", startedAt: now() });
  return { taskId, cli };
}

const rowsOf = (cli: string) => db.select().from(monitors).where(eq(monitors.cliSessionId, cli));

async function main(): Promise<void> {
  // ── ① 暂态故障：几百毫秒之后库好了，那笔事实不能丢 ───────────────────────────
  {
    const { taskId, cli } = await session("transient");
    const notes: string[] = [];
    const stop = bus.subscribe((ev: any) => {
      if (ev.type === "agent.event" && ev.taskId === taskId) notes.push(String(ev.event?.text ?? ""));
    });
    const trace = new ClaudeMonitorTrace(cli, ORIGIN);
    await sleep(60);                         // 认领上一轮那一步先走完
    const restore = breakReads();
    startMonitor(trace, cli, "flaky");
    await sleep(300);
    restore();
    await trace.finishAll();
    stop();
    const rows = await rowsOf(cli);
    check(rows.length === 1, "①短暂读库失败之后，那张卡照样落库", `${rows.length} 张`);
    check(rows[0]?.status === "lost", "①收尾照常把它收成「进程已不在」", String(rows[0]?.status));
    const notice = notes.find((t) => t.includes("内置 Monitor"));
    check(!!notice?.includes("1 个"), "①回合收尾那条说明照样留下，数字跟卡片对得上", String(notice));
  }

  // ── ② 库整个不可用：积压有上界，恢复后照常落库 ─────────────────────────────
  {
    const { cli } = await session("outage");
    const trace = new ClaudeMonitorTrace(cli, ORIGIN);
    await sleep(60);
    const restore = breakReads();
    const began = Date.now();
    for (const n of ["o1", "o2", "o3", "o4"]) startMonitor(trace, cli, n);
    // 第一笔试满一轮阶梯（约 5 秒），后面三笔熔断后各试一次 —— 不是 4 × 5 秒。
    await (trace as any).chain;
    const waited = Date.now() - began;
    restore();
    check(waited < 8_000, "②库不可用时积压有上界：熔断之后不再每笔排一整轮", `${waited}ms`);
    check((await rowsOf(cli)).length === 0, "②库不可用期间确实一张都没写成（注入生效）");
    startMonitor(trace, cli, "after");
    await trace.finishAll();
    const rows = await rowsOf(cli);
    check(rows.some((r) => r.nativeId === "b-after"), "②库恢复后同一条流照常落库（熔断会自己解除）",
      rows.map((r) => r.nativeId).join(",") || "(空)");
  }

  if (failures) {
    console.error(`\n${failures} 条断言未通过`);
    process.exitCode = 1;
  } else {
    console.log("✓ 内置 Monitor 实时投影的写库责任：暂态故障后照样落库且收尾留痕 / 库不可用时积压有上界、恢复后照常落库 均受回归保护");
  }
}

try {
  await main();
} finally {
  await teardown();
}
