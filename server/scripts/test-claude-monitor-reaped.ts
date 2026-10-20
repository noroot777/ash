// 「全都停止了，为什么也没唤醒监听？」——用户 2026-10-16 的原话，钉的就是那个问题。
//
// 内置 Monitor 的进程在智能体自己的进程树里，回合一结束 CLI 就把它们成批收走。实测行序
// （Bp2LkwfRO37A 第 2 轮审查的 run 文件原样，本用例按它复刻）：
//
// ```
// system task_started                        ← 智能体挂上监听
// assistant "监听已挂上，套件结束会叫我。"
// result   success                           ← 回合结束
// system task_notification status=stopped    ← 紧接着被收走，summary **就是那条描述**
// ```
//
// 于是用户那一侧全部的线索是卡片变成「已停止」+ 下面原样复读一遍描述。那读起来像「等到了
// 然后停了」，而真相相反：它没等到，而且内置 Monitor 的通知只注回智能体自己的会话，从来
// 不经过 ash —— 谁也不会被叫醒。这份回归钉三件事：
//
// ① 终态文案不复读描述（复读 = 两行都没说出发生了什么）；
// ② 来源**明说**是被进程退出收走的那一句（`Orphaned by a previous…`）要翻出来；
// ③ 回合结束时在任务时间线上留一条合并说明——「停止/暂停必须留下持久可见的状态」
//    （AGENTS.md）在这里同样成立：用户刷新页面后得能看出「这一轮它挂了几个、现在全没了」。
import { db, makeTask, monitors, now, sessions, teardown } from "./monitors-fixture.js";
import { CLAUDE_MONITOR_ENDED_REASON, CLAUDE_MONITOR_REAPED_REASON, claudeMonitorEndedReason } from "@ash/shared/monitor-claude";
import { eq } from "drizzle-orm";

const { ClaudeMonitorTrace } = await import("../src/claude-monitors.js");
const { bus } = await import("../src/bus.js");

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  if (ok) return;
  failures += 1;
  console.error(`✗ ${label}${detail ? ` —— ${detail}` : ""}`);
};

const settle = () => new Promise((r) => setTimeout(r, 60));

/** 来源侧补报孤儿时的原话（claude 2.1.283 实测原文）。 */
const ORPHAN = "Orphaned by a previous Claude Code process exit and reported in an aggregate summary.";

/** 像 claude-stream.ts 那样喂一次 Monitor 调用：先 `event()` 再 `toolUse()`。 */
function callMonitor(
  trace: InstanceType<typeof ClaudeMonitorTrace>, input: Record<string, unknown>, toolUseId: string,
): void {
  trace.event({
    type: "assistant", timestamp: now(),
    message: { content: [{ type: "tool_use", name: "Monitor", input, id: toolUseId }] },
  });
  trace.toolUse("Monitor", input, toolUseId);
}

/** 这个任务时间线上收到的那些 `aside` 说明。 */
function collectTimeline(taskId: string): { texts: string[]; asides: boolean[]; stop: () => void } {
  const texts: string[] = [];
  const asides: boolean[] = [];
  const stop = bus.subscribe((ev: any) => {
    if (ev.type !== "agent.event" || ev.taskId !== taskId) return;
    texts.push(String(ev.event?.text ?? ""));
    asides.push(ev.event?.aside === true);
  });
  return { texts, asides, stop };
}

async function main(): Promise<void> {
  // ── ① 文案归一（纯函数）────────────────────────────────────────────────────
  check(
    claudeMonitorEndedReason("stopped", ORPHAN, "等待全量 unittest 跑完") === CLAUDE_MONITOR_REAPED_REASON,
    "来源明说「被上一个进程退出收走」时翻成那句话",
  );
  check(
    claudeMonitorEndedReason("stopped", "等待全量 unittest 跑完", "等待全量 unittest 跑完")
      === CLAUDE_MONITOR_ENDED_REASON.stopped,
    "summary 跟描述一字不差时不复读，改说状态本身是怎么回事",
  );
  check(
    claudeMonitorEndedReason("exited", "命令退出码 1", "等待全量 unittest 跑完") === "命令退出码 1",
    "来源真多说了什么就原样转述",
  );
  check(
    claudeMonitorEndedReason("expired", "", "等待全量 unittest 跑完") === CLAUDE_MONITOR_ENDED_REASON.expired,
    "summary 为空时退回状态文案",
  );

  // ── ② 真实行序：回合收尾那一批 stopped ─────────────────────────────────────
  const taskId = await makeTask();
  const cli = "2f6b1a40-0000-4b2e-9f01-aa1122334455";
  await db.insert(sessions).values({
    id: "sess-reaped", taskId, role: "single", agentType: "claude", executor: "claude@test",
    cliSessionId: cli, cwd: "/tmp/wt", startedAt: now(),
  });

  const timeline = collectTimeline(taskId);
  const trace = new ClaudeMonitorTrace(cli);
  await settle();

  const DESCRIPTION = "等待全量 unittest 跑完";
  callMonitor(trace, { command: "until ! pgrep -f unittest; do sleep 15; done", description: DESCRIPTION }, "toolu_r1");
  trace.event({
    type: "system", subtype: "task_started", task_id: "bhrdepn66", tool_use_id: "toolu_r1",
    description: DESCRIPTION, task_type: "local_bash", session_id: cli,
  });
  // 第二个监听，用来验收尾那条说明里的**计数**（实测那一轮同时挂着两个后台任务）。
  callMonitor(trace, { command: "tail -F /tmp/full.log", description: "盯日志" }, "toolu_r2");
  trace.event({
    type: "system", subtype: "task_started", task_id: "borph001", tool_use_id: "toolu_r2",
    description: "盯日志", task_type: "local_bash", session_id: cli,
  });
  await settle();

  // 回合结束，CLI 把名下后台任务成批收走：summary 填的就是那条描述。
  trace.event({
    type: "system", subtype: "task_notification", task_id: "bhrdepn66",
    status: "stopped", summary: DESCRIPTION, session_id: cli,
  });
  // 另一条走「下一个进程启动时补报孤儿」那一支。
  trace.event({
    type: "system", subtype: "task_notification", task_id: "borph001",
    status: "stopped", summary: ORPHAN, session_id: cli,
  });
  await settle();

  const reaped = (await db.select().from(monitors).where(eq(monitors.nativeId, "bhrdepn66"))).at(0);
  check(reaped?.status === "stopped", "来源报的终态照常落地", String(reaped?.status));
  check(reaped?.endedReason !== DESCRIPTION, "终态原因不是把描述复读一遍",
    `实际「${reaped?.endedReason}」（复读 = 卡片上两行都没说出它其实是被收走的）`);
  check(reaped?.endedReason === CLAUDE_MONITOR_ENDED_REASON.stopped, "改说 stopped 到底是怎么回事",
    String(reaped?.endedReason));

  const orphan = (await db.select().from(monitors).where(eq(monitors.nativeId, "borph001"))).at(0);
  check(orphan?.endedReason === CLAUDE_MONITOR_REAPED_REASON, "来源明说的那一句翻成中文落库",
    String(orphan?.endedReason));

  // ── ③ 回合结束：时间线上必须留下一条合并说明 ───────────────────────────────
  await trace.finishAll();
  await settle();
  const notice = timeline.texts.find((t) => t.includes("内置 Monitor"));
  check(!!notice, "回合结束时在任务时间线上留了一笔", `收到 ${timeline.texts.length} 条，没有一条提到内置 Monitor`);
  check(!!notice?.includes("2 个"), "说清这一轮起了几个", String(notice));
  check(!!notice?.includes("不会唤醒任务"), "答了用户那个问题：它们停了，为什么没人被叫醒", String(notice));
  check(!!notice?.includes("start_monitor"), "指出跨回合等事情该走哪条路", String(notice));
  check(timeline.asides.every((a) => a), "这条说明是 aside —— 说给用户听的记账，不塞进 agent 的上下文");
  timeline.stop();

  // ── ④ 没起过监听的回合不记账 ───────────────────────────────────────────────
  const quietTask = await makeTask();
  const quietCli = "2f6b1a40-1111-4b2e-9f01-aa1122334455";
  await db.insert(sessions).values({
    id: "sess-quiet", taskId: quietTask, role: "single", agentType: "claude", executor: "claude@test",
    cliSessionId: quietCli, cwd: "/tmp/wt", startedAt: now(),
  });
  const quietLine = collectTimeline(quietTask);
  const quiet = new ClaudeMonitorTrace(quietCli);
  await settle();
  await quiet.finishAll();
  await settle();
  check(quietLine.texts.length === 0, "一个内置 Monitor 都没起的回合不往时间线上写字",
    `实际写了 ${quietLine.texts.length} 条：${quietLine.texts.join(" / ")}`);
  quietLine.stop();

  // ── ⑤ 生产路径：有 run 凭据时按**这一代**数，上一代的不算 ────────────────────
  //
  // 上面几条走的是「没有 run 凭据」那一支（fixture 的会话没有落盘路径）。生产里每条流都
  // 自带 run 文件，计数走的是另一个谓词——不单独钉一遍的话，那一支写错了也全绿：时间线
  // 要么悄悄不记，要么把上一代的监听一起数进去，而两种错都只有在真任务上才看得见。
  const genTask = await makeTask();
  const genCli = "2f6b1a40-2222-4b2e-9f01-aa1122334455";
  await db.insert(sessions).values({
    id: "sess-gen", taskId: genTask, role: "single", agentType: "claude", executor: "claude@test",
    cliSessionId: genCli, cwd: "/tmp/wt", startedAt: now(),
  });
  const genLine = collectTimeline(genTask);

  // 上一代：起一个监听就散了（不收尾），留在库里。
  const older = new ClaudeMonitorTrace(genCli, { pid: null, pidStartedAt: null, runPath: "/tmp/run-older.jsonl" });
  await settle();
  callMonitor(older, { command: "sleep 9999", description: "上一代的监听" }, "toolu_old");
  older.event({
    type: "system", subtype: "task_started", task_id: "bold0001", tool_use_id: "toolu_old",
    description: "上一代的监听", task_type: "local_bash", session_id: genCli,
  });
  await settle();

  // 这一代：同一条 CLI 会话（resume 后号不变），另一个 run 文件。
  const newer = new ClaudeMonitorTrace(genCli, { pid: null, pidStartedAt: null, runPath: "/tmp/run-newer.jsonl" });
  await settle();
  callMonitor(newer, { command: "sleep 9999", description: "这一代的监听" }, "toolu_new");
  newer.event({
    type: "system", subtype: "task_started", task_id: "bnew0001", tool_use_id: "toolu_new",
    description: "这一代的监听", task_type: "local_bash", session_id: genCli,
  });
  await settle();
  const newRow = (await db.select().from(monitors).where(eq(monitors.nativeId, "bnew0001"))).at(0);
  check(newRow?.sourceRun === "/tmp/run-newer.jsonl", "投影行记下了起它的那个 run 文件",
    String(newRow?.sourceRun));

  await newer.finishAll();
  await settle();
  const genNotice = genLine.texts.find((t) => t.includes("内置 Monitor"));
  check(!!genNotice, "有 run 凭据时照样留账", `收到 ${genLine.texts.length} 条`);
  check(!!genNotice?.includes("1 个"), "只数这一代起的那些，上一代的不算进来", String(genNotice));
  genLine.stop();

  await teardown();
  if (failures) {
    console.error(`\n${failures} 条断言未通过`);
    process.exit(1);
  }
  console.log("✓ 内置 Monitor 被回合收走这件事：终态文案不复读描述 / 来源明说的「孤儿」翻得出来 / 回合结束在时间线上留账且答得出「为什么没唤醒」");
}

await main();
