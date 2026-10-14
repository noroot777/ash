// **检查点要两半一起成立**（第 9 轮审查的类问题）。
//
// 内存上限会把一个任务的配对状态（`pending`/`byToolUse`/`found`/孤儿缓冲）丢掉。第 8 轮为此
// 把「读到第几字节」停好，但位置之前建立的**关联**仍然没了：那段前缀里起的监听，它在后缀里
// 的回执/终态通知配不上任何东西，而扫描照旧读到文件尾、照旧销账——面板上是一张漏掉的卡 +
// 一条写着 running 的已完成监听，刷新也不改（审查用生产服务 + 真页面实测）。
//
// 这份测试钉的是修好之后的两半（见 server/src/claude-monitor-commit.ts 文件头）：
// ① 位置只停在**没有悬着的关联**处（`cursor.safe`），所以被跳过的调用会被重放到；
// ② 位置之前已经成行的那些，后缀的事实按 `native_id` / `tool_use_id` 配回那一行；
// ③ 两半都配不上时**不许销账**：回到确定可重放的位置（从零）重读，然后才干净收尾。
//
// 为什么单独一个脚本：这几条要在「制造内存压力」和「往下读」之间精确卡一刀，而自动推进的
// 退避定时器会抢在压力构造之前把文件读完（本轮自测：加了 debug 才发现 converge 里这两组是
// **假通过**——定时器先读完了，检查点那条路一次都没走到）。所以这里把退避阶梯拉到 10 分钟，
// 整份测试自己手动驱动每一轮。
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-mon-checkpoint-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
/** 单次只读 32 KiB：检查点要卡在某两行之间，而上限是按字节算的。 */
const LIMIT = 32_768;
process.env.ASH_MONITOR_SCAN_MAX_BYTES = String(LIMIT);
// **退避阶梯拉长到 10 分钟**：这份测试要自己控制每一轮的时机，不许定时器插队（见文件头）。
process.env.ASH_MONITOR_BACKOFF_MS = "600000,600000";
requireTmpDb("monitor-checkpoint");

const [
  { db, ensureSchema, dbClient }, schema, { backfillClaudeMonitors, monitorScanTracked },
  recovery, { listMonitors },
] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/claude-monitor-backfill.js"),
  import("../src/claude-monitor-recovery.js"),
  import("../src/monitors.js"),
]);
const { monitorRecoveryOf, stopAllMonitorRecovery } = recovery;
const { projects, sessions, tasks } = schema;
await ensureSchema();

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  if (ok) return;
  failures += 1;
  console.error(`✗ ${label}${detail ? ` —— ${detail}` : ""}`);
};
const now = () => new Date().toISOString();
const line = (ev: unknown) => JSON.stringify(ev) + "\n";

let seq = 0;
async function fixture(name: string) {
  const taskId = `t-${name}-${seq++}`;
  const cli = `cli-${taskId}`;
  const dir = join(root, "runs", taskId);
  mkdirSync(dir, { recursive: true });
  await db.insert(tasks).values({ id: taskId, projectId: "p", title: name, body: "", status: "running",
    agentType: "claude", mode: "single", createdAt: now(), updatedAt: now() });
  await db.insert(sessions).values({
    id: `s-${taskId}`, taskId, role: "single", agentType: "claude", executor: "claude@x",
    cliSessionId: cli, cwd: root, startedAt: now(),
    agentOutPath: join(dir, `s-${taskId}-20261015T010000000Z.agent-out.jsonl`),
    agentPid: null, agentStartedAt: null,
  });
  return { taskId, cli, file: join(dir, `s-${taskId}-20261015T010000000Z.agent-out.jsonl`) };
}

/**
 * 用一条填充事件把 `body` 顶到正好 `target` **字节**（检查点要落在指定两行之间）。
 *
 * **必须按字节算**：扫描的单次上限和游标都是字节，而夹具里有中文描述（一个字 3 字节）。
 * 按字符串长度算的那一版把检查点挪到了前一行之前，于是「停好的位置」正好等于「可重放
 * 位置」，整组断言变成免费的（本轮自测用 debug 才看出来）。
 */
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

function padTo(body: string, target: number): string {
  const head = '{"type":"assistant","timestamp":"2026-10-15T01:00:00.000Z","message":{"content":[{"type":"text","text":"';
  const tail = '"}]}}\n';
  const need = target - bytes(body) - bytes(head) - bytes(tail);
  if (need < 0) throw new Error(`夹具装不下：还差 ${-need} 字节`);
  return body + head + "x".repeat(need) + tail;  // 填充只用 ASCII，字节数 = 字符数
}

/** 一个 Monitor 的调用 + 启动 + 回执（可分段放，用来把检查点卡在中间）。 */
const call = (cli: string, tu: string, desc: string, at: string) => line({
  type: "assistant", timestamp: at, message: { content: [
    { type: "tool_use", name: "Monitor", id: tu, input: { command: "sleep 1800", description: desc, timeout_ms: 600_000 } },
  ] },
});
const started = (cli: string, tu: string, native: string) => line({
  type: "system", subtype: "task_started", task_id: native, tool_use_id: tu,
  task_type: "local_bash", session_id: cli,
});
const receipt = (tu: string, native: string, at: string) => line({
  type: "user", timestamp: at, message: { content: [
    { type: "tool_result", tool_use_id: tu, content: `Monitor started (task ${native}, expires in 1m 30s unless the source ends first).` },
  ] },
});
const notice = (cli: string, native: string) => line({
  type: "system", subtype: "task_notification", task_id: native,
  status: "completed", summary: "来源确认完成", session_id: cli,
});

/**
 * 造一批「同样处于恢复中」的任务，把被测任务挤出快照表。
 *
 * 软上限豁免恢复中的游标，所以压力只能压到硬上限（64）上——那一支正是「只停好位置、丢掉
 * 配对状态」的入口。
 */
async function makeSqueeze(tag: string): Promise<() => Promise<void>> {
  const ids: string[] = [];
  for (let i = 0; i < 70; i += 1) {
    const other = await fixture(`${tag}-filler${i}`);
    writeFileSync(other.file, line({ type: "system", subtype: "init", session_id: other.cli }));
    chmodSync(other.file, 0o000); // 读不开 → 立刻 pending（恢复中），而且扫描很便宜
    ids.push(other.taskId);
  }
  return async () => { for (const taskId of ids) await backfillClaudeMonitors(taskId); };
}

/** 手动往下读，顺便记下期间出现过哪些恢复原因。 */
async function driveUntil(taskId: string, done: () => Promise<boolean>, seen: Set<string>): Promise<number> {
  let rounds = 0;
  for (; rounds < 20; rounds += 1) {
    for (const r of monitorRecoveryOf(taskId)?.reasons ?? []) seen.add(r);
    if (await done()) break;
    await backfillClaudeMonitors(taskId);
  }
  for (const r of monitorRecoveryOf(taskId)?.reasons ?? []) seen.add(r);
  return rounds;
}

async function main(): Promise<void> {
  await db.insert(projects).values({ id: "p", name: "p", repoPath: root, createdAt: now() });

  // ── ① 位置之前建立的关联也要还在（审查实测的那个形状）───────────────────────────
  //
  // 一号：调用+启动+回执都在前缀，**完成通知在后缀** → 只能按 native_id 配回那一行。
  // 三号：调用+启动在前缀，**回执在后缀**         → 只能按 tool_use_id 配回那一行。
  // 二号：调用正好压在单次上限上，**启动在后缀**   → 只能靠「位置停在可重放处」把它重放到。
  {
    const f = await fixture("checkpoint");
    let body = line({ type: "system", subtype: "init", session_id: f.cli });
    body += call(f.cli, "tu-bfirst", "一号监听", "2026-10-15T03:00:00.000Z");
    body += started(f.cli, "tu-bfirst", "bfirst");
    body += receipt("tu-bfirst", "bfirst", "2026-10-15T03:00:00.040Z");
    body += call(f.cli, "tu-bthird", "三号监听", "2026-10-15T03:05:00.000Z");
    body += started(f.cli, "tu-bthird", "bthird");
    const call2 = call(f.cli, "tu-bsecond", "二号监听", "2026-10-15T03:10:00.000Z");
    body = padTo(body, LIMIT - bytes(call2)) + call2;
    check(bytes(body) === LIMIT,
      "①夹具把二号的调用正好顶在单次上限上（按字节）", `${bytes(body)}/${LIMIT}`);
    body += started(f.cli, "tu-bsecond", "bsecond");
    body += receipt("tu-bsecond", "bsecond", "2026-10-15T03:10:00.040Z");
    body += receipt("tu-bthird", "bthird", "2026-10-15T03:05:00.040Z");
    body += notice(f.cli, "bfirst");
    body += notice(f.cli, "bsecond");
    writeFileSync(f.file, body);

    await backfillClaudeMonitors(f.taskId);
    const first = await listMonitors(f.taskId);
    check(first.length === 2 && first.every((r) => r.nativeId !== "bsecond"),
      "①第一轮读到一号三号（二号的启动还在后缀）",
      `${first.length} 条：${first.map((r) => r.nativeId).join(",")}`);
    check(monitorRecoveryOf(f.taskId)?.pending === true, "①而且留了账（没读完）");

    const squeeze = await makeSqueeze("cp");
    await squeeze();
    check(monitorScanTracked(f.taskId) === false, "①配对状态确实被硬上限挤掉了");

    const seen = new Set<string>();
    const rounds = await driveUntil(f.taskId,
      async () => (await listMonitors(f.taskId)).length >= 3 && !monitorRecoveryOf(f.taskId), seen);
    const rows = await listMonitors(f.taskId);
    const byId = new Map(rows.map((r) => [r.nativeId, r]));
    check(rows.length === 3, "①三张卡都在（二号的调用被重放到了）",
      `${rounds} 轮后 ${rows.length} 条：${rows.map((r) => r.nativeId).join(",")}`);
    check(byId.get("bfirst")?.status === "exited",
      "①一号的完成通知按 native_id 配回了它那一行", String(byId.get("bfirst")?.status));
    check(byId.get("bthird")?.timeoutMs === 90_000,
      "①三号的回执按 tool_use_id 配回了它那一行", String(byId.get("bthird")?.timeoutMs));
    check(byId.get("bsecond")?.status === "exited" && byId.get("bsecond")?.timeoutMs === 90_000,
      "①二号整条生命周期都在（终态 + 来源说的时长）",
      `${byId.get("bsecond")?.status}/${byId.get("bsecond")?.timeoutMs}`);
    check(!seen.has("checkpoint-incomplete"),
      "①检查点够用：没走「回头从零重读」那条兜底路", [...seen].join(","));
    check(monitorRecoveryOf(f.taskId) === null, "①并且销了账",
      JSON.stringify(monitorRecoveryOf(f.taskId)));
  }

  // ── ② 被淘汰的「不是 Monitor」结论：退成孤儿时不许销账 ──────────────────────────
  //
  // 审查点名的同类位置：`notMonitorTools`/`confirmedForeign` 是**结论**，随配对状态一起被
  // 丢掉，而前缀已经越过——普通后台 Bash 的迟到通知又退成孤儿，没有重新获取那个结论的通道。
  // 契约不是「把结论存起来」，而是**配不上的事实不许当成读完了**：回到确定可重放的位置重读，
  // 结论自然回来，然后才干净销账。
  {
    const f = await fixture("foreign-late");
    let body = line({ type: "system", subtype: "init", session_id: f.cli });
    body += line({ type: "assistant", timestamp: "2026-10-15T04:00:00.000Z", message: { content: [
      { type: "tool_use", name: "Bash", id: "tb-late", input: { command: "pytest -q", run_in_background: true } },
    ] } });
    body += started(f.cli, "tb-late", "blate");
    body = padTo(body, LIMIT); // 检查点落在这儿：它的终态通知在后缀
    body += notice(f.cli, "blate");
    body += call(f.cli, "tu-breal", "真监听", "2026-10-15T04:10:00.000Z");
    body += started(f.cli, "tu-breal", "breal01");
    body += receipt("tu-breal", "breal01", "2026-10-15T04:10:00.040Z");
    body += notice(f.cli, "breal01");
    writeFileSync(f.file, body);

    await backfillClaudeMonitors(f.taskId);
    check((await listMonitors(f.taskId)).length === 0, "②第一轮只有普通 Bash，没有卡");
    const squeeze = await makeSqueeze("fl");
    await squeeze();
    check(monitorScanTracked(f.taskId) === false, "②结论连同配对状态被挤掉了");

    const seen = new Set<string>();
    const rounds = await driveUntil(f.taskId,
      async () => (await listMonitors(f.taskId)).length >= 1 && !monitorRecoveryOf(f.taskId), seen);
    check(seen.has("checkpoint-incomplete"),
      "②配不上的事实没被当成读完（留了账、回头重读）", [...seen].join(","));
    const rows = await listMonitors(f.taskId);
    check(rows.length === 1 && rows[0]?.nativeId === "breal01",
      "②普通 Bash 没留下假卡，真 Monitor 照样补出来",
      `${rounds} 轮后 ${rows.length} 条：${rows.map((r) => r.nativeId).join(",")}`);
    check(rows[0]?.status === "exited" && rows[0]?.timeoutMs === 90_000,
      "②而且带着来源报的终态与时长", `${rows[0]?.status}/${rows[0]?.timeoutMs}`);
    check(monitorRecoveryOf(f.taskId) === null, "②最终干净销账（不是永远 pending）",
      JSON.stringify(monitorRecoveryOf(f.taskId)));
  }

  if (failures === 0) {
    console.log("✓ 内置 Monitor 的检查点：位置只停在可重放处（被跳过的调用会重放）/ "
      + "位置之前已成行的按 native_id 与 tool_use_id 配回去 / "
      + "两半都配不上时不销账而是回头重读 均受回归保护");
  }
}

try {
  await main();
} finally {
  stopAllMonitorRecovery();
  releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
process.exit(failures === 0 ? 0 : 1);
