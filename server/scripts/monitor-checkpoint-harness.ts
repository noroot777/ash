// 这份检查点测试的**环境与夹具层**（断言本体在 test-claude-monitor-checkpoint.ts）。
//
// 分出来的理由只有一个:单文件 700 行上限。所以这里只放「造数据、驱动一轮、记一条失败」,
// 不放任何断言——读断言的人不必读这个文件,改这个文件的人要跑那份测试。
//
// **注意加载顺序**:环境变量(`ASH_DB` / 扫描上限 / 退避阶梯)必须在 `../src/**` 被加载之前
// 落位。ESM 会先把这份模块整个跑完再跑导入方的语句,所以把 import 放在这里是**必要的**,
// 不是顺手——挪回测试文件里就会变成「先 import 了 db 再设 ASH_DB」。
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

export const root = mkdtempSync(join(tmpdir(), "ash-mon-checkpoint-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
/** 单次只读 32 KiB：检查点要卡在某两行之间，而上限是按字节算的。 */
export const LIMIT = 32_768;
process.env.ASH_MONITOR_SCAN_MAX_BYTES = String(LIMIT);
// **退避阶梯拉长到 10 分钟**：这份测试要自己控制每一轮的时机，不许定时器插队（见文件头）。
process.env.ASH_MONITOR_BACKOFF_MS = "600000,600000";
requireTmpDb("monitor-checkpoint");

const [
  { db, ensureSchema, dbClient }, schema, { backfillClaudeMonitors, monitorScanTracked },
  recovery, { listMonitors }, { inspectProcess },
] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/claude-monitor-backfill.js"),
  import("../src/claude-monitor-recovery.js"),
  import("../src/monitors.js"),
  import("../src/proc.js"),
]);
export const { monitorRecoveryOf, stopAllMonitorRecovery } = recovery;
export const { monitors, projects, sessions, tasks } = schema;
export { db, dbClient, schema, backfillClaudeMonitors, monitorScanTracked, listMonitors, releaseTmpDb };
await ensureSchema();

let failures = 0;
/** 记一条不通过（整份测试的唯一计数口径，收尾用 `failureCount()` 取）。 */
export const check = (ok: boolean, label: string, detail = "") => {
  if (ok) return;
  failures += 1;
  console.error(`✗ ${label}${detail ? ` —— ${detail}` : ""}`);
};
export const failureCount = () => failures;
export const now = () => new Date().toISOString();
export const line = (ev: unknown) => JSON.stringify(ev) + "\n";

/** 一个**真的活着**的进程，以及它真实的启动时刻（代次那几组要证明「不是退回判死」）。 */
export function liveProcess(): { pid: number; startedAt: string | null; kill: () => void } {
  const child = spawn("sleep", ["600"], { stdio: "ignore" });
  const pid = child.pid!;
  return { pid, startedAt: inspectProcess(pid)?.startedAt ?? null, kill: () => child.kill("SIGTERM") };
}

let seq = 0;
export async function fixture(name: string, pid: number | null = null, pidStartedAt: string | null = null) {
  const taskId = `t-${name}-${seq++}`;
  const cli = `cli-${taskId}`;
  const dir = join(root, "runs", taskId);
  mkdirSync(dir, { recursive: true });
  const runFile = (stamp = "20261015T010000000Z") => join(dir, `s-${taskId}-${stamp}.agent-out.jsonl`);
  await db.insert(tasks).values({ id: taskId, projectId: "p", title: name, body: "", status: "running",
    agentType: "claude", mode: "single", createdAt: now(), updatedAt: now() });
  await db.insert(sessions).values({
    id: `s-${taskId}`, taskId, role: "single", agentType: "claude", executor: "claude@x",
    cliSessionId: cli, cwd: root, startedAt: now(),
    agentOutPath: runFile(), agentPid: pid, agentStartedAt: pidStartedAt,
  });
  return { taskId, cli, file: runFile(), runFile };
}

/** 一组**完整、顺序正常**的普通后台 Bash 生命周期（调用 → 开始 → 回执 → 完成）。 */
export const plainBash = (cli: string, n: number) => [
  line({ type: "assistant", timestamp: "2026-10-15T05:00:00.000Z", message: { content: [
    { type: "tool_use", name: "Bash", id: `tb${n}`, input: { command: `pytest -q shard${n}`, run_in_background: true } },
  ] } }),
  line({ type: "system", subtype: "task_started", task_id: `bbash${n}`, tool_use_id: `tb${n}`, task_type: "local_bash", session_id: cli }),
  line({ type: "user", timestamp: "2026-10-15T05:00:01.000Z", message: { content: [
    { type: "tool_result", tool_use_id: `tb${n}`, content: `Running in background (bbash${n})` },
  ] } }),
  line({ type: "system", subtype: "task_notification", task_id: `bbash${n}`, status: "completed", summary: "跑完了", session_id: cli }),
].join("");

/**
 * 用一条填充事件把 `body` 顶到正好 `target` **字节**（检查点要落在指定两行之间）。
 *
 * **必须按字节算**：扫描的单次上限和游标都是字节，而夹具里有中文描述（一个字 3 字节）。
 * 按字符串长度算的那一版把检查点挪到了前一行之前，于是「停好的位置」正好等于「可重放
 * 位置」，整组断言变成免费的（本轮自测用 debug 才看出来）。
 *
 * 填充是**一条**事件，所以 `target` 超过一个窗口时它本身就装不进窗口、会被整条跳过
 * （见 ⑨）。要跨窗口的夹具用 `padLines`。
 */
export const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/**
 * 用**一串**填充事件把 `body` 顶过 `target` 字节。
 *
 * 跟 `padTo` 的区别只在「一条还是多条」，但这件事很要紧：单次读取窗口是按字节切的，**一条
 * 比窗口还长的记录现在读不过去**（见扫描层 `eachLine`：窗口内找不到换行 ⇒ 这一轮零进展）。
 * 要跨窗口的夹具必须用这个，否则测的是「超长记录卡住」而不是「跨窗口续读」（本轮自测：
 * ⑦⑧ 第一版用 padTo 造了一条 37 KiB 的行，于是两组都停在第一个窗口里）。
 */
export function padLines(body: string, target: number): string {
  let out = body;
  while (bytes(out) < target) {
    out += line({ type: "assistant", timestamp: "2026-10-15T01:00:00.000Z",
      message: { content: [{ type: "text", text: "x".repeat(400) }] } });
  }
  return out;
}

export function padTo(body: string, target: number): string {
  const head = '{"type":"assistant","timestamp":"2026-10-15T01:00:00.000Z","message":{"content":[{"type":"text","text":"';
  const tail = '"}]}}\n';
  const need = target - bytes(body) - bytes(head) - bytes(tail);
  if (need < 0) throw new Error(`夹具装不下：还差 ${-need} 字节`);
  return body + head + "x".repeat(need) + tail;  // 填充只用 ASCII，字节数 = 字符数
}

/** 一个 Monitor 的调用 + 启动 + 回执（可分段放，用来把检查点卡在中间）。 */
export const call = (cli: string, tu: string, desc: string, at: string) => line({
  type: "assistant", timestamp: at, message: { content: [
    { type: "tool_use", name: "Monitor", id: tu, input: { command: "sleep 1800", description: desc, timeout_ms: 600_000 } },
  ] },
});
export const started = (cli: string, tu: string, native: string) => line({
  type: "system", subtype: "task_started", task_id: native, tool_use_id: tu,
  task_type: "local_bash", session_id: cli,
});
export const receipt = (tu: string, native: string, at: string) => line({
  type: "user", timestamp: at, message: { content: [
    { type: "tool_result", tool_use_id: tu, content: `Monitor started (task ${native}, expires in 1m 30s unless the source ends first).` },
  ] },
});
export const notice = (cli: string, native: string) => line({
  type: "system", subtype: "task_notification", task_id: native,
  status: "completed", summary: "来源确认完成", session_id: cli,
});

/**
 * 造一批「同样处于恢复中」的任务，把被测任务挤出快照表。
 *
 * 软上限豁免恢复中的游标，所以压力只能压到硬上限（64）上——那一支正是「只停好位置、丢掉
 * 配对状态」的入口。
 */
export async function makeSqueeze(tag: string): Promise<() => Promise<void>> {
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
export async function driveUntil(taskId: string, done: () => Promise<boolean>, seen: Set<string>): Promise<number> {
  let rounds = 0;
  for (; rounds < 20; rounds += 1) {
    for (const r of monitorRecoveryOf(taskId)?.reasons ?? []) seen.add(r);
    if (await done()) break;
    await backfillClaudeMonitors(taskId);
  }
  for (const r of monitorRecoveryOf(taskId)?.reasons ?? []) seen.add(r);
  return rounds;
}
