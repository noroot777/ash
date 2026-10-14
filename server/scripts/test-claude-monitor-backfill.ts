// 历史回填：升级之前跑过的内置 Monitor 要能补进面板。
//
// 这条路是整个功能的起点：用户打开一个任务，agent 在对话里反复说「等 Monitor 通知」，
// 面板却写着「这个任务上还没有哨兵」。实时投影只管之后发生的事，对那个任务本身一个字都
// 答不了（第 2 轮审查实测：旧任务打开仍是空面板）。
//
// 两个最容易写错的地方，这份测试各钉一条：
// ① `sessions.agent_out_path` 只记**最后一次** run 的文件（每回合覆盖一次）。照它扫只能
//    扫到最后一回合，而 Monitor 多半起在中间某轮——实测用户那个任务 12 个 Monitor 全在
//    前几个文件里，照字段扫一条都补不到。
// ② 普通后台 Bash 同样是 `local_bash`，混进来会把面板变成一份后台命令流水账。
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, and } from "drizzle-orm";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-backfill-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
requireTmpDb("backfill");

const [{ db, ensureSchema }, schema, { backfillClaudeMonitors }, { listMonitors }] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/claude-monitor-backfill.js"),
  import("../src/monitors.js"),
]);
const { monitors, projects, sessions, tasks } = schema;
await ensureSchema();

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  if (ok) return;
  failures += 1;
  console.error(`✗ ${label}${detail ? ` —— ${detail}` : ""}`);
};

const now = () => new Date().toISOString();
const CLI = "cli-history";
const runs = join(root, "runs", "t-hist");
mkdirSync(runs, { recursive: true });

/** 写一份 agent-out.jsonl（stream-json，一行一个事件）。 */
function writeStream(stamp: string, events: unknown[]): string {
  const path = join(runs, `sess1-${stamp}.agent-out.jsonl`);
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return path;
}

async function main(): Promise<void> {
  await db.insert(projects).values({ id: "p", name: "p", repoPath: root, createdAt: now() });
  await db.insert(tasks).values({ id: "t-hist", projectId: "p", title: "历史任务", body: "", status: "done",
    agentType: "claude", mode: "single", createdAt: now(), updatedAt: now() });

  // 第 1 个文件：一个 Monitor（带回执）+ 一个普通后台 Bash。
  writeStream("20261014T010000000Z", [
    { type: "system", subtype: "init", session_id: CLI },
    { type: "assistant", message: { model: "m", content: [
      { type: "tool_use", name: "Monitor", id: "tu1", input: { command: "until grep -q OK /tmp/a; do sleep 5; done", description: "第一轮的哨兵", timeout_ms: 900_000 } },
      { type: "tool_use", name: "Bash", id: "tb1", input: { command: "pytest -q", run_in_background: true } },
    ] } },
    { type: "system", subtype: "task_started", task_id: "bh001", tool_use_id: "tu1", task_type: "local_bash", session_id: CLI },
    { type: "system", subtype: "task_started", task_id: "bbash1", tool_use_id: "tb1", task_type: "local_bash", session_id: CLI },
    { type: "user", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "tu1", content: "Monitor started (task bh001, expires in 10m unless the source ends first)." },
    ] } },
    { type: "system", subtype: "task_notification", task_id: "bh001", tool_use_id: "tu1", status: "completed", summary: "第一轮跑完了", session_id: CLI },
  ]);
  // 第 2 个文件：又一个 Monitor，**没有**终态（那一轮进程被杀）。
  writeStream("20261014T020000000Z", [
    { type: "system", subtype: "init", session_id: CLI },
    { type: "assistant", message: { model: "m", content: [
      { type: "tool_use", name: "Monitor", id: "tu2", input: { command: "tail -F /tmp/b", description: "第二轮的哨兵", timeout_ms: 600_000 } },
    ] } },
    { type: "system", subtype: "task_started", task_id: "bh002", tool_use_id: "tu2", task_type: "local_bash", session_id: CLI },
  ]);
  // 第 3 个文件：这一轮没起 Monitor —— 而 sessions 字段指向的就是它。
  const last = writeStream("20261014T030000000Z", [
    { type: "system", subtype: "init", session_id: CLI },
    { type: "result", subtype: "success", is_error: false, session_id: CLI },
  ]);

  await db.insert(sessions).values({
    id: "sess1", taskId: "t-hist", role: "single", agentType: "claude", executor: "claude@x",
    cliSessionId: CLI, cwd: root, startedAt: now(), agentOutPath: last,
  });

  check((await listMonitors("t-hist")).length === 0, "回填前面板是空的");

  const added = await backfillClaudeMonitors("t-hist");
  check(added === 2, "两轮的 Monitor 都补上了（字段只指向最后一个文件，必须扫同会话全部）", `实际 ${added}`);

  const rows = await listMonitors("t-hist");
  check(rows.length === 2, "面板上就是这两条", `实际 ${rows.length}`);
  check(!rows.some((r) => r.nativeId === "bbash1"), "普通后台 Bash 没被当成哨兵补进来");
  check(rows.every((r) => r.kind === "claude"), "补出来的都是 claude 投影");

  const first = rows.find((r) => r.nativeId === "bh001");
  check(first?.status === "exited", "有终态的按终态补", String(first?.status));
  check(first?.lifetime === "bounded", "回执里的期限也补上了", String(first?.lifetime));
  const span = first?.expiresAt ? Date.parse(first.expiresAt) - Date.parse(first.startedAt) : -1;
  check(Math.abs(span - 600_000) < 2_000, "期限按回执的 10 分钟，不是请求的 15 分钟", `${span}ms`);

  const second = rows.find((r) => r.nativeId === "bh002");
  // 历史文件里没有它的结局 = 那一轮的进程早已不在。补成 running 会凭空多一张「正在盯着」
  // 的历史卡，比不补更误导。
  check(second?.status === "lost", "没读到终态的补成 lost，不冒充还在盯", String(second?.status));
  check(/历史记录/.test(second?.endedReason ?? ""), "并说明为什么不知道它的结局", second?.endedReason ?? "");

  // 幂等：再扫一次不该长出第二份。
  const again = await backfillClaudeMonitors("t-hist");
  check(again === 0, "同一进程内不重复扫", `实际 ${again}`);
  check((await listMonitors("t-hist")).length === 2, "行数没变");

  // 实时投影优先：库里已有的那条不被历史覆盖。
  await db.update(monitors).set({ description: "实时写的，更新" })
    .where(and(eq(monitors.taskId, "t-hist"), eq(monitors.nativeId, "bh001")));
  const { backfillClaudeMonitors: fresh } = await import(`../src/claude-monitor-backfill.js?v=${Date.now()}`);
  await fresh("t-hist");
  const kept = (await listMonitors("t-hist")).find((r) => r.nativeId === "bh001");
  check(kept?.description === "实时写的，更新", "已存在的行不被历史回填覆盖", String(kept?.description));

  if (failures) {
    console.error(`\n${failures} 条断言未通过`);
    process.exitCode = 1;
  } else {
    console.log("✓ 内置 Monitor 历史回填：扫同会话全部文件 / 排除普通后台 Bash / 终态与回执期限 / 无结局补 lost / 幂等 / 不覆盖实时投影 均受回归保护");
  }
}

try {
  await main();
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
