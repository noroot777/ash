// 认人那一侧：claude 的 stream-json 里，哪些 `local_bash` 后台任务是内置 `Monitor` 起的。
//
// 这是整份投影的地基，而它只有一条可靠判据：`system/task_started` 带的 `tool_use_id`
// 回指到发起它的 tool_use 块的**工具名**。实测那个任务 76 条 task_started 里只有 12 条
// 来自 Monitor，另外 64 条是普通后台 Bash（`run_in_background`）——两者的 `task_type`
// 都是 `local_bash`，`description` 也长得一模一样，按内容猜一律分不开。分错的代价是
// 哨兵面板变成一份「这个任务跑过的所有后台命令」流水账。
//
// 下面的事件片段逐字段照搬 2026-10-14 真实录下的 agent-out.jsonl（M8W-joLcUdys），
// 内嵌而不是去读 data/runs：那些文件会被 run-logs-gc 回收，依赖它们的测试迟早变成
// 「跳过」而没人发现。
import { eq } from "drizzle-orm";
import { parseMonitorStartReceipt } from "@ash/shared/monitor";
import { db, makeTask, now, sessions, monitors, listMonitors, teardown } from "./monitors-fixture.js";

const { ClaudeMonitorTrace } = await import("../src/claude-monitors.js");

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  if (ok) return;
  failures += 1;
  console.error(`✗ ${label}${detail ? ` —— ${detail}` : ""}`);
};

const CLI_SESSION = "fa1256cd-7a30-409a-8014-c9dd8ed96cf5";
const settle = () => new Promise((r) => setTimeout(r, 50));

/** assistant 消息里的一个 tool_use 块。 */
const toolUse = (name: string, input: unknown, id: string) => ({ name, input, id });

async function main(): Promise<void> {
  const taskId = await makeTask();
  await db.insert(sessions).values({
    id: "sess-1", taskId, role: "single", agentType: "claude", executor: "claude@test",
    cliSessionId: CLI_SESSION, cwd: "/tmp/wt", startedAt: now(),
  });

  const trace = new ClaudeMonitorTrace();

  // ① Monitor 起的 —— 应当被认领
  trace.toolUse(...Object.values(toolUse("Monitor", {
    command: 'until grep -qE "^(OK|FAILED)" /tmp/r4.log; do sleep 5; done; grep -E "^Ran " /tmp/r4.log',
    description: "最终全量回归结果", timeout_ms: 1_200_000,
  }, "toolu_monitor_1")) as [string, unknown, string]);
  // ② 普通后台 Bash —— 同样是 local_bash，必须被排除
  trace.toolUse(...Object.values(toolUse("Bash", {
    command: "uv run python -m unittest discover -s tests", description: "跑全量回归", run_in_background: true,
  }, "toolu_bash_1")) as [string, unknown, string]);

  trace.event({ type: "system", subtype: "task_started", task_id: "bvvsd32ii", tool_use_id: "toolu_monitor_1",
    description: "最终全量回归结果", is_backgrounded: false, task_type: "local_bash", session_id: CLI_SESSION });
  trace.event({ type: "system", subtype: "task_started", task_id: "bkmzsumfy", tool_use_id: "toolu_bash_1",
    description: "跑全量回归", is_backgrounded: false, task_type: "local_bash", session_id: CLI_SESSION });
  await settle();

  let rows = await listMonitors(taskId);
  check(rows.length === 1, "只认领 Monitor 起的那条，普通后台 Bash 被排除", `实际 ${rows.length} 条：${rows.map((r) => r.description).join(" / ")}`);
  const mon = rows[0];
  check(mon?.nativeId === "bvvsd32ii", "记下的是 Monitor 那条的原生 id", String(mon?.nativeId));
  check(mon?.kind === "claude", "落的是 claude 投影");
  check(mon?.status === "running", "起手状态是 running", String(mon?.status));
  check(mon?.command.includes("until grep"), "命令原文来自 Monitor 的入参", mon?.command ?? "");
  check(mon?.cwd === "/tmp/wt", "工作目录取自会话", String(mon?.cwd));
  // **请求参数不是生效期限**：claude 自己会钳，还有 persistent 模式。回执（tool_result）
  // 在 task_started 之后才到，所以这一刻只能是「未知」，对外也不给到期时刻。
  // 上一轮这里断言的是「到期时刻按 timeout_ms 算」——那正是第 2 轮审查指出的错误判据。
  check(mon?.lifetime === "unknown", "回执还没到：期限是未知，不拿请求值冒充", String(mon?.lifetime));
  check(mon?.expiresAt === null, "未知期限对外不给到期时刻", String(mon?.expiresAt));

  // ③ 终态：只收自己认领过的那条
  trace.event({ type: "system", subtype: "task_notification", task_id: "bkmzsumfy", tool_use_id: "toolu_bash_1",
    status: "completed", summary: "跑全量回归", session_id: CLI_SESSION });
  trace.event({ type: "system", subtype: "task_notification", task_id: "bvvsd32ii", tool_use_id: "toolu_monitor_1",
    status: "stopped", summary: "最终全量回归结果", session_id: CLI_SESSION });
  await settle();

  rows = await listMonitors(taskId);
  check(rows.length === 1, "终态事件不会凭空多出一行", `实际 ${rows.length} 条`);
  check(rows[0]?.status === "stopped", "被 TaskStop 停掉 → stopped", String(rows[0]?.status));
  check(rows[0]?.endedAt !== null, "落了结束时刻");

  // ④ 重放同一段：唯一索引 + 先查一次，不该重复落库
  const replay = new ClaudeMonitorTrace();
  replay.toolUse("Monitor", { command: "until grep -q DONE /tmp/x; do sleep 5; done", description: "重放", timeout_ms: 600_000 }, "toolu_monitor_1");
  replay.event({ type: "system", subtype: "task_started", task_id: "bvvsd32ii", tool_use_id: "toolu_monitor_1",
    description: "重放", task_type: "local_bash", session_id: CLI_SESSION });
  await settle();
  rows = await listMonitors(taskId);
  check(rows.length === 1, "同一个原生 id 重放不会再插一行", `实际 ${rows.length} 条`);

  // ⑤ agent 进程结束 → 还挂着 running 的投影落 lost
  const live = new ClaudeMonitorTrace();
  live.toolUse("Monitor", { command: "tail -F /tmp/y", description: "还在盯着", timeout_ms: 600_000 }, "toolu_monitor_2");
  live.event({ type: "system", subtype: "task_started", task_id: "bnewlive1", tool_use_id: "toolu_monitor_2",
    description: "还在盯着", task_type: "local_bash", session_id: CLI_SESSION });
  await settle();
  check((await listMonitors(taskId)).some((r) => r.nativeId === "bnewlive1" && r.status === "running"), "第二条投影在盯着");
  live.finishAll();
  await settle();
  const after = (await db.select().from(monitors).where(eq(monitors.nativeId, "bnewlive1"))).at(0);
  check(after?.status === "lost", "agent 进程结束后它落 lost，不留僵尸卡", String(after?.status));
  check(/进程/.test(after?.endedReason ?? ""), "结束原因说明了它是跟着进程没的", after?.endedReason ?? "");

  // ⑥ 认不出会话就安静跳过，不抛、不污染别的任务
  const orphan = new ClaudeMonitorTrace();
  orphan.toolUse("Monitor", { command: "sleep 1", description: "孤儿", timeout_ms: 600_000 }, "toolu_monitor_3");
  orphan.event({ type: "system", subtype: "task_started", task_id: "borphan1", tool_use_id: "toolu_monitor_3",
    description: "孤儿", task_type: "local_bash", session_id: "unknown-session-id" });
  await settle();
  check((await db.select().from(monitors).where(eq(monitors.nativeId, "borphan1"))).length === 0, "认不出会话就不落库");

  // ⑦ 子智能体挂的 Monitor 同样要认（嵌套 assistant 带 parent_tool_use_id）
  const nested = new ClaudeMonitorTrace();
  nested.event({ type: "system", subtype: "init", session_id: CLI_SESSION });
  nested.toolUse("Monitor", { command: "until grep -q SUB /tmp/s; do sleep 5; done", description: "子智能体的哨兵", timeout_ms: 600_000 }, "toolu_sub1");
  nested.event({ type: "system", subtype: "task_started", task_id: "bsubagent", tool_use_id: "toolu_sub1",
    description: "子智能体的哨兵", task_type: "local_bash", session_id: CLI_SESSION });
  await settle();
  const sub = (await db.select().from(monitors).where(eq(monitors.nativeId, "bsubagent"))).at(0);
  check(sub !== undefined, "子智能体挂的 Monitor 也认领（接线在 claude-stream 的嵌套分支）");
  check(sub?.taskId === taskId, "子智能体的哨兵归属到同一个 ash 任务", String(sub?.taskId));

  // ⑧ 来源报多久就记多久 —— 不能套 ash 的创建区间
  const secs = new ClaudeMonitorTrace();
  secs.event({ type: "system", subtype: "init", session_id: CLI_SESSION });
  secs.toolUse("Monitor", { command: "sleep 1", description: "只盯 5 秒", timeout_ms: 5_000 }, "toolu_secs");
  secs.event({ type: "system", subtype: "task_started", task_id: "bsecs001", tool_use_id: "toolu_secs",
    description: "只盯 5 秒", task_type: "local_bash", session_id: CLI_SESSION });
  await settle();
  secs.toolResult("toolu_secs", "Monitor started (task bsecs001, expires in 5s unless the source ends first).");
  await settle();
  const quick = (await db.select().from(monitors).where(eq(monitors.nativeId, "bsecs001"))).at(0);
  const quickSpan = quick ? Date.parse(quick.expiresAt) - Date.parse(quick.startedAt) : -1;
  check(Math.abs(quickSpan - 5_000) < 1_500, "来源回执说 5 秒就记 5 秒，不抬到 ash 的下限", `${quickSpan}ms`);

  // ⑨ 接管回来：新 trace 必须把上一轮的投影认回来，否则终态通知会被当成「不是我的」丢掉
  const reclaimTrace = new ClaudeMonitorTrace();
  reclaimTrace.event({ type: "system", subtype: "init", session_id: CLI_SESSION });
  await settle();
  reclaimTrace.event({ type: "system", subtype: "task_notification", task_id: "bsubagent",
    status: "completed", summary: "子智能体的哨兵跑完了", session_id: CLI_SESSION });
  await settle();
  const reclaimed = (await db.select().from(monitors).where(eq(monitors.nativeId, "bsubagent"))).at(0);
  check(reclaimed?.status === "exited", "接管后的新 trace 认回了上一轮的投影，终态落得下去",
    `实际 ${reclaimed?.status}（running = 认领关系没恢复，通知被丢了）`);

  // ⑩ **真实接管：没有新的 init**。接管是从已消费的 offset 之后接着读的，上一轮的 init
  // 早就消费掉了。靠「等下一条 system 事件设身份」在这条路上永远等不到——我上一轮的回归
  // 每次都重发 init，恰好把它盖住了（第 2 轮审查实测）。身份改成构造时传入。
  await db.update(monitors).set({ status: "running", endedAt: null }).where(eq(monitors.nativeId, "bsubagent"));
  const resumed = new ClaudeMonitorTrace(CLI_SESSION);   // 不发 init
  await settle();
  resumed.event({ type: "system", subtype: "task_notification", task_id: "bsubagent",
    status: "stopped", summary: "接管后才收到的终态", session_id: CLI_SESSION });
  await settle();
  const afterResume = (await db.select().from(monitors).where(eq(monitors.nativeId, "bsubagent"))).at(0);
  check(afterResume?.status === "stopped", "没有 init 的接管流照样认回上一轮并落终态",
    `实际 ${afterResume?.status}（没变 = 身份没传进来，认领压根没发生）`);

  // ⑪ **进程结束时按持久归属收尾，不按内存账本**。接管流从没认领过某一行时，finishAll
  // 原来查不到它，于是进程都结束了卡片还写着「正在盯着」（第 2 轮审查实测）。
  await db.update(monitors).set({ status: "running", endedAt: null }).where(eq(monitors.nativeId, "bsubagent"));
  const quiet = new ClaudeMonitorTrace(CLI_SESSION);
  quiet.finishAll();                       // 一条事件都没喂过
  await settle();
  const afterQuiet = (await db.select().from(monitors).where(eq(monitors.nativeId, "bsubagent"))).at(0);
  check(afterQuiet?.status === "lost", "一条事件都没收到的接管流，结束时照样把本会话的投影收干净",
    `实际 ${afterQuiet?.status}（running = finishAll 还在只看内存 rows）`);

  // ⑫ **认领失败不能变成权威空账本**。注入一次读失败，随后的有效通知仍要落得下去。
  {
    const original = db.select.bind(db);
    let injected = 0;
    (db as any).select = (...args: any[]) => {
      // 只打第一次 reclaim 的那条查询（它选的就是 id + nativeId 两列）。同步抛即可：
      // 调用点在 async 函数体内，会原样变成那个 promise 的 rejection。
      const fields = args[0];
      if (injected === 0 && fields && "nativeId" in fields && "id" in fields && Object.keys(fields).length === 2) {
        injected += 1;
        throw new Error("INJECTED_SQLITE_BUSY");
      }
      return original(...(args as []));
    };
    await db.update(monitors).set({ status: "running", endedAt: null }).where(eq(monitors.nativeId, "bsubagent"));
    const flaky = new ClaudeMonitorTrace(CLI_SESSION);
    await settle();
    flaky.event({ type: "system", subtype: "task_notification", task_id: "bsubagent",
      status: "completed", summary: "读失败之后仍然有效的通知", session_id: CLI_SESSION });
    await settle();
    await settle();
    (db as any).select = original;
    check(injected === 1, "确实注入了一次读失败", `injected=${injected}`);
    const afterFlaky = (await db.select().from(monitors).where(eq(monitors.nativeId, "bsubagent"))).at(0);
    check(afterFlaky?.status === "exited", "一次认领读失败之后，来源的有效通知照样落得下去",
      `实际 ${afterFlaky?.status}（running = 失败被当成「认领完成且账本为空」，通知被永久丢弃）`);
  }

  // ⑬ 期限以**来源回执**为准，不是请求参数（claude 自己会钳）。
  const receipt = new ClaudeMonitorTrace(CLI_SESSION);
  receipt.toolUse("Monitor", { command: "sleep 9999", description: "请求一小时", timeout_ms: 3_600_000 }, "toolu_rcpt");
  receipt.event({ type: "system", subtype: "task_started", task_id: "brcpt001", tool_use_id: "toolu_rcpt",
    description: "请求一小时", task_type: "local_bash", session_id: CLI_SESSION });
  await settle();
  const beforeReceipt = (await db.select().from(monitors).where(eq(monitors.nativeId, "brcpt001"))).at(0);
  check(beforeReceipt?.sourceLifetime === "unknown", "回执还没到时期限是「未知」，不拿请求值冒充",
    String(beforeReceipt?.sourceLifetime));
  // 来源把一小时钳成了 30 分钟 —— 这才是事实。
  receipt.toolResult("toolu_rcpt", "Monitor started (task brcpt001, expires in 30m unless the source ends first).");
  await settle();
  const afterReceipt = (await db.select().from(monitors).where(eq(monitors.nativeId, "brcpt001"))).at(0);
  const receiptSpan = afterReceipt ? Date.parse(afterReceipt.expiresAt) - Date.parse(afterReceipt.startedAt) : -1;
  check(afterReceipt?.sourceLifetime === "bounded", "拿到回执后升级成有限期", String(afterReceipt?.sourceLifetime));
  check(Math.abs(receiptSpan - 1_800_000) < 2_000, "期限按回执的 30 分钟，不是请求的 60 分钟", `${receiptSpan}ms`);

  // ⑭ persistent：没有到期时刻，不能编一个。
  const forever = new ClaudeMonitorTrace(CLI_SESSION);
  forever.toolUse("Monitor", { command: "tail -F /tmp/z", description: "持续盯", timeout_ms: 600_000 }, "toolu_fv");
  forever.event({ type: "system", subtype: "task_started", task_id: "bforever", tool_use_id: "toolu_fv",
    description: "持续盯", task_type: "local_bash", session_id: CLI_SESSION });
  await settle();
  forever.toolResult("toolu_fv", "Monitor started (task bforever, persistent; it will keep running).");
  await settle();
  const fv = (await db.select().from(monitors).where(eq(monitors.nativeId, "bforever"))).at(0);
  check(fv?.sourceLifetime === "persistent", "persistent 回执落成持续监听", String(fv?.sourceLifetime));
  const fvDto = (await listMonitors(taskId)).find((m) => m.nativeId === "bforever");
  check(fvDto?.expiresAt === null, "持续监听对外不给到期时刻（给了就是假的）", String(fvDto?.expiresAt));

  // ⑮ **误判过的 lost 要能被来源事实纠正。**
  // `lost` 是 ash 推断的（流断了、重启后判来源已不在），不是来源说的。agent 活得过 ash
  // 重启，所以推断错很正常——错了之后来源照常送来 completed，那时必须改回来。第 3 轮审查
  // 实测：卡片被误判成 lost 之后，真 completed 到了仍然是 lost，错误永久固化。
  const mis = new ClaudeMonitorTrace(CLI_SESSION);
  mis.toolUse("Monitor", { command: "tail -F /tmp/mis", description: "被误判的", timeout_ms: 600_000 }, "toolu_mis");
  mis.event({ type: "system", subtype: "task_started", task_id: "bmis001", tool_use_id: "toolu_mis",
    description: "被误判的", task_type: "local_bash", session_id: CLI_SESSION });
  await settle();
  // 模拟一次误判（开机清扫把来源判死了，而其实它还在）。
  await db.update(monitors).set({ status: "lost", endedAt: now(), endedReason: "推断：进程已不在" })
    .where(eq(monitors.nativeId, "bmis001"));
  mis.event({ type: "system", subtype: "task_notification", task_id: "bmis001", status: "completed",
    summary: "其实我跑完了", session_id: CLI_SESSION });
  await settle();
  const fixed = (await db.select().from(monitors).where(eq(monitors.nativeId, "bmis001"))).at(0);
  check(fixed?.status === "exited", "被误判成 lost 的，来源报完成时纠正回来", String(fixed?.status));
  check(fixed?.endedReason === "其实我跑完了", "结束说明也跟着换成来源说的", String(fixed?.endedReason));

  // 反过来：来源**已经说过**的终态不该被重放翻案（否则显示跟着扫描次数变）。
  // 用 `stopped` 而不是 `failed`——后者和 `completed` 一样映射成 `exited`，断言会免费通过。
  mis.event({ type: "system", subtype: "task_notification", task_id: "bmis001", status: "stopped",
    summary: "重放的旧事件", session_id: CLI_SESSION });
  await settle();
  const kept = (await db.select().from(monitors).where(eq(monitors.nativeId, "bmis001"))).at(0);
  check(kept?.status === "exited", "来源已定的终态不被重放改写", String(kept?.status));

  // ⑯ **复合时长**：来源侧那个 formatter 是多段的（`Zt()`，本机 claude 2.1.283），
  // 90 秒印成 `1m 30s`。只取首个数值单位对会读成 60 秒，少掉的那半正好落在用户最关心的
  // 「还剩多久」上（第 3 轮审查实测 90s/1790s/3599s 分别少 30s/50s/59s）。
  for (const [text, want, label] of [
    ["expires in 1m 30s unless the source ends first", 90_000, "1m 30s → 90 秒"],
    ["expires in 29m 50s unless the source ends first", 1_790_000, "29m 50s → 1790 秒"],
    ["expires in 59m 59s unless the source ends first", 3_599_000, "59m 59s → 3599 秒"],
    ["expires in 1h 30m 20s unless the source ends first", 5_420_000, "1h 30m 20s → 5420 秒"],
    ["expires in 30m unless the source ends first", 1_800_000, "整分仍然对"],
    ["expires in 45s unless the source ends first", 45_000, "不足一分钟那支"],
    // feature flag 关掉时走的第三支：`timeout ${timeoutMs}ms`，同样是钳过的生效值。
    ["timeout 90000ms", 90_000, "timeout 90000ms 这一支也认"],
  ] as const) {
    const got = parseMonitorStartReceipt(`Monitor started (task b12m34, ${text}).`);
    check(got.lifetime === "bounded" && got.ms === want, `回执期限：${label}`,
      `${got.lifetime}/${got.ms}（应为 bounded/${want}）`);
  }
  // 后台任务 id 里带「数值+单位」的诱饵不能被当成时长吃掉。
  check(parseMonitorStartReceipt("Monitor started (task b12m34, persistent — runs until TaskStop or session end).").lifetime === "persistent",
    "persistent 分支不被 id 里的 `12m` 带偏");
  check(parseMonitorStartReceipt("Bash started in background with id b12m34").lifetime === "unknown",
    "不是 Monitor 回执的一概不认");

  if (failures) {
    console.error(`\n${failures} 条断言未通过`);
    process.exitCode = 1;
  } else {
    console.log("✓ claude 内置 Monitor 认人：识别与归属 / 终态 / 幂等 / 子智能体 / 无 init 的接管认回 / 持久归属收尾 / 认领失败可重试 / 期限以来源回执为准(含 persistent、复合时长、timeout 那一支) / 误判的 lost 可被来源事实纠正且已定终态不翻案 均受回归保护");
  }
}

try {
  await main();
} finally {
  await teardown();
}
