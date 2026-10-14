// **接线**：claude-stream.ts 真的把内置 Monitor 的事件喂给了投影层吗。
//
// 解析逻辑本身由 test-claude-monitor-parse.ts 钉住（那份直接驱动 ClaudeMonitorTrace），
// 落库与隔离由 test-claude-monitor-projection.ts 钉住。中间还剩一道缝：那两样都对，但
// parseClaudeStream 里忘了调 `claudeMonitors.toolUse()` / `.event()` / `.finishAll()`，
// 整个功能就一条记录都不会产生，而上面两份测试全绿。
//
// 这份测试从**真实的 CLI stdout 形态**走完整条路：起一个真子进程吐 stream-json，
// 让 parseClaudeStream 读它，最后查库。接线断了这里立刻红。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-monitor-wiring-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
requireTmpDb("monitor-wiring");

const [{ db, ensureSchema }, schema, { parseClaudeStream }] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/executors/claude.js"),
]);
const { monitors, projects, sessions, tasks } = schema;
await ensureSchema();

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  if (ok) return;
  failures += 1;
  console.error(`✗ ${label}${detail ? ` —— ${detail}` : ""}`);
};

const CLI_SESSION = "fa1256cd-7a30-409a-8014-c9dd8ed96cf5";
const now = () => new Date().toISOString();

/** 把若干行 stream-json 交给一个真子进程吐出来，喂给 parseClaudeStream 读完。 */
async function drain(lines: unknown[], cliSessionId?: string): Promise<void> {
  const script = join(root, `stub-${Math.random().toString(36).slice(2, 8)}.mjs`);
  writeFileSync(
    script,
    lines.map((l) => `process.stdout.write(${JSON.stringify(JSON.stringify(l) + "\n")});`).join("\n"),
  );
  const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin?.end();
  for await (const _ of parseClaudeStream(child as any, undefined, "claude", undefined, null, () => {}, 5 * 60_000, cliSessionId)) {
    /* 事件本身这份测试不关心 */
  }
}

async function main(): Promise<void> {
  await db.insert(projects).values({ id: "p1", name: "wiring", repoPath: root, createdAt: now() });
  await db.insert(tasks).values({
    id: "t1", projectId: "p1", title: "wiring", body: "", status: "running",
    agentType: "claude", mode: "single", createdAt: now(), updatedAt: now(),
  });
  await db.insert(sessions).values({
    id: "s1", taskId: "t1", role: "single", agentType: "claude", executor: "claude@test",
    cliSessionId: CLI_SESSION, cwd: "/tmp/wt", startedAt: now(),
  });

  // 一段真实形态的 CLI 输出：init → 一条 assistant 同时调 Monitor 和后台 Bash →
  // 两条 task_started → Monitor 那条的终态 → result。
  await drain([
    { type: "system", subtype: "init", session_id: CLI_SESSION, tools: ["Monitor", "Bash"] },
    {
      type: "assistant",
      message: {
        model: "claude-opus-5", content: [
          { type: "tool_use", name: "Monitor", id: "toolu_m1", input: { command: "until grep -q DONE /tmp/a; do sleep 5; done", description: "等回归结论", timeout_ms: 900_000 } },
          { type: "tool_use", name: "Bash", id: "toolu_b1", input: { command: "pytest -q", description: "跑测试", run_in_background: true } },
        ],
      },
    },
    { type: "system", subtype: "task_started", task_id: "bmon0001", tool_use_id: "toolu_m1", description: "等回归结论", task_type: "local_bash", session_id: CLI_SESSION },
    { type: "system", subtype: "task_started", task_id: "bbash001", tool_use_id: "toolu_b1", description: "跑测试", task_type: "local_bash", session_id: CLI_SESSION },
    // 起手回执：来源侧说出**生效**期限的地方（请求的是 15 分钟，来源给了 10 分钟）。
    { type: "user", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_m1", content: "Monitor started (task bmon0001, expires in 10m unless the source ends first)." },
    ] } },
    { type: "system", subtype: "task_notification", task_id: "bmon0001", tool_use_id: "toolu_m1", status: "completed", summary: "等回归结论", session_id: CLI_SESSION },
    { type: "result", subtype: "success", is_error: false, session_id: CLI_SESSION, num_turns: 1, result: "done" },
  ]);
  await new Promise((r) => setTimeout(r, 150)); // 投影是 fire-and-forget，给它落库的时间

  const rows = await db.select().from(monitors).where(eq(monitors.taskId, "t1"));
  check(rows.length === 1, "接线通了：内置 Monitor 落了一行投影", `实际 ${rows.length} 条`);
  check(rows[0]?.nativeId === "bmon0001", "落的是 Monitor 那条，不是后台 Bash", String(rows[0]?.nativeId));
  check(rows[0]?.kind === "claude", "kind=claude");
  check(rows[0]?.description === "等回归结论", "说明来自 Monitor 的入参", String(rows[0]?.description));
  check(rows[0]?.status === "exited", "completed → exited", String(rows[0]?.status));
  const span = rows[0] ? Date.parse(rows[0].expiresAt) - Date.parse(rows[0].startedAt) : -1;
  check(rows[0]?.sourceLifetime === "bounded", "回执把期限从未知升级成有限期", String(rows[0]?.sourceLifetime));
  check(Math.abs(span - 600_000) < 2_000, "期限按回执的 10 分钟，不是请求的 15 分钟", `${span}ms`);

  // 另一条：起了但没等到终态，进程就结束了 → finishAll 应当把它收成 lost。
  await drain([
    { type: "system", subtype: "init", session_id: CLI_SESSION },
    {
      type: "assistant",
      message: { model: "claude-opus-5", content: [
        { type: "tool_use", name: "Monitor", id: "toolu_m2", input: { command: "tail -F /tmp/b", description: "没等到就断了", timeout_ms: 600_000 } },
      ] },
    },
    { type: "system", subtype: "task_started", task_id: "bmon0002", tool_use_id: "toolu_m2", description: "没等到就断了", task_type: "local_bash", session_id: CLI_SESSION },
    { type: "result", subtype: "success", is_error: false, session_id: CLI_SESSION, num_turns: 1, result: "done" },
  ]);
  await new Promise((r) => setTimeout(r, 200));

  const orphan = (await db.select().from(monitors).where(eq(monitors.nativeId, "bmon0002"))).at(0);
  check(orphan !== undefined, "第二条也落了库");
  check(orphan?.status === "lost", "流结束时还在跑的投影被收成 lost，不留僵尸卡", String(orphan?.status));

  // ── 子智能体那条路：嵌套 assistant 带 parent_tool_use_id，走的是 parser 里另一个分支
  // （而且那个分支**提前 return**）。只接顶层的话，子智能体挂的哨兵一条都不会出现。
  await drain([
    { type: "system", subtype: "init", session_id: CLI_SESSION },
    {
      type: "assistant", parent_tool_use_id: "toolu_parent",
      message: { model: "claude-opus-5", content: [
        { type: "tool_use", name: "Monitor", id: "toolu_sub", input: { command: "until grep -q SUB /tmp/s; do sleep 5; done", description: "子智能体的哨兵", timeout_ms: 600_000 } },
      ] },
    },
    { type: "system", subtype: "task_started", task_id: "bsub0001", tool_use_id: "toolu_sub", description: "子智能体的哨兵", task_type: "local_bash", session_id: CLI_SESSION },
    { type: "result", subtype: "success", is_error: false, session_id: CLI_SESSION, num_turns: 1, result: "done" },
  ]);
  await new Promise((r) => setTimeout(r, 200));
  const subRow = (await db.select().from(monitors).where(eq(monitors.nativeId, "bsub0001"))).at(0);
  check(subRow !== undefined, "子智能体挂的 Monitor 也接上了（嵌套分支）");
  check(subRow?.taskId === "t1", "归属到同一个 ash 任务", String(subRow?.taskId));

  // ── 接管那条路：上一轮的投影还挂着 running，新开的流必须认回来再收它的终态。
  await db.update(monitors).set({ status: "running", endedAt: null, endedReason: null })
    .where(eq(monitors.nativeId, "bsub0001"));
  // **不重放 init**：真实接管是从已消费的 offset 之后接着读的，上一轮的 init 不会再来。
  // 身份靠 parseClaudeStream 的 cliSessionId 参数传进来（attach 路径就是这么调的）。
  await drain([
    { type: "system", subtype: "task_notification", task_id: "bsub0001", status: "completed", summary: "子智能体的哨兵跑完了", session_id: CLI_SESSION },
    { type: "result", subtype: "success", is_error: false, session_id: CLI_SESSION, num_turns: 1, result: "done" },
  ], CLI_SESSION);
  await new Promise((r) => setTimeout(r, 250));
  const afterReclaim = (await db.select().from(monitors).where(eq(monitors.nativeId, "bsub0001"))).at(0);
  check(afterReclaim?.status === "exited", "接管后的新流认回上一轮的投影并落了终态",
    `实际 ${afterReclaim?.status}（running/lost = 认领关系没恢复）`);

  if (failures) {
    console.error(`\n${failures} 条断言未通过`);
    process.exitCode = 1;
  } else {
    console.log("✓ claude 内置 Monitor 接线：parseClaudeStream 把顶层/嵌套 tool_use、生命周期事件、流收尾都喂到了投影层，接管后能认回上一轮");
  }
}

try {
  await main();
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
