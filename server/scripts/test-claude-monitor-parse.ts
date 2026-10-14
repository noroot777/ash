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
  // 30 分钟上限（已与 claude 对齐）：1_200_000ms 在区间内，应原样生效。
  const span = mon ? Date.parse(mon.expiresAt) - Date.parse(mon.startedAt) : 0;
  check(Math.abs(span - 1_200_000) < 2_000, "到期时刻按 timeout_ms 算", `${span}ms`);

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

  if (failures) {
    console.error(`\n${failures} 条断言未通过`);
    process.exitCode = 1;
  } else {
    console.log("✓ claude 内置 Monitor 认人：Monitor 与普通后台 Bash 分得开 / 入参与会话落位 / 终态 / 重放幂等 / 进程结束落 lost / 孤儿安静跳过 均受回归保护");
  }
}

try {
  await main();
} finally {
  await teardown();
}
