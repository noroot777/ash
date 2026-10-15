// **检查点要两半一起成立**（第 9 轮审查的类问题）。
//
// 内存上限会把一个任务的配对状态（`pending`/`byToolUse`/`found`/孤儿缓冲）丢掉。第 8 轮为此
// 把「读到第几字节」停好，但位置之前建立的**关联**仍然没了：那段前缀里起的监听，它在后缀里
// 的回执/终态通知配不上任何东西，而扫描照旧读到文件尾、照旧销账——面板上是一张漏掉的卡 +
// 一条写着 running 的已完成监听，刷新也不改（审查用生产服务 + 真页面实测）。
//
// 这份测试钉的是修好之后的几半（见 server/src/claude-monitor-commit.ts 文件头）：
// ① 还没成行的那条调用由 `monitor_pending_calls` **独立恢复**，所以位置只管单调往前；
// ② 位置之前已经成行的那些，后缀的事实按 `native_id` / `tool_use_id` 配回那一行；
// ③ 两半都配不上时**不许销账**：回到确定可重放的位置（从零）重读，然后才干净收尾。
//
// ①那一条第 11 轮审查之前是靠「位置绝不越过一条还悬着的调用」做的，于是一条**永远不会完结**
// 的调用（启动被拒、进程在那一行之后被杀）就把位置钉死了 —— 见 ⑦⑧ 两组。
//
// 为什么单独一个脚本：这几条要在「制造内存压力」和「往下读」之间精确卡一刀，而自动推进的
// 退避定时器会抢在压力构造之前把文件读完（本轮自测：加了 debug 才发现 converge 里这两组是
// **假通过**——定时器先读完了，检查点那条路一次都没走到）。所以这里把退避阶梯拉到 10 分钟，
// 整份测试自己手动驱动每一轮。
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
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
  recovery, { listMonitors }, { inspectProcess },
] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/claude-monitor-backfill.js"),
  import("../src/claude-monitor-recovery.js"),
  import("../src/monitors.js"),
  import("../src/proc.js"),
]);
const { monitorRecoveryOf, stopAllMonitorRecovery } = recovery;
const { monitors, projects, sessions, tasks } = schema;
await ensureSchema();

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  if (ok) return;
  failures += 1;
  console.error(`✗ ${label}${detail ? ` —— ${detail}` : ""}`);
};
const now = () => new Date().toISOString();
const line = (ev: unknown) => JSON.stringify(ev) + "\n";

/** 一个**真的活着**的进程，以及它真实的启动时刻（代次那几组要证明「不是退回判死」）。 */
function liveProcess(): { pid: number; startedAt: string | null; kill: () => void } {
  const child = spawn("sleep", ["600"], { stdio: "ignore" });
  const pid = child.pid!;
  return { pid, startedAt: inspectProcess(pid)?.startedAt ?? null, kill: () => child.kill("SIGTERM") };
}

let seq = 0;
async function fixture(name: string, pid: number | null = null, pidStartedAt: string | null = null) {
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
const plainBash = (cli: string, n: number) => [
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
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/**
 * 用**一串**填充事件把 `body` 顶过 `target` 字节。
 *
 * 跟 `padTo` 的区别只在「一条还是多条」，但这件事很要紧：单次读取窗口是按字节切的，**一条
 * 比窗口还长的记录现在读不过去**（见扫描层 `eachLine`：窗口内找不到换行 ⇒ 这一轮零进展）。
 * 要跨窗口的夹具必须用这个，否则测的是「超长记录卡住」而不是「跨窗口续读」（本轮自测：
 * ⑦⑧ 第一版用 padTo 造了一条 37 KiB 的行，于是两组都停在第一个窗口里）。
 */
function padLines(body: string, target: number): string {
  let out = body;
  while (bytes(out) < target) {
    out += line({ type: "assistant", timestamp: "2026-10-15T01:00:00.000Z",
      message: { content: [{ type: "text", text: "x".repeat(400) }] } });
  }
  return out;
}

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

  // ── ② 被淘汰的「不是 Monitor」结论：当场重新裁决，位置照常前进 ────────────────────
  //
  // 普通后台 Bash 的调用与启动在前缀里（已经跳过），它的终态通知落在后缀。上一版把这条通知
  // 当成「还配不上的孤儿」：它既钉住可重放位置、又让整轮不许销账，于是每一轮都退回同一处、
  // 重读同一个窗口，固定输入永远读不完（第 10 轮审查实测连续 24 轮同点停滞）。
  //
  // 新契约不是「把结论存起来」，而是**当场裁决**：行序严格因果 ⇒ 它的 `task_started` 必然在
  // 它之前 ⇒ 库里没有这一行就说明它不是 Monitor 起的，丢掉，位置照常往前。
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
    check(!seen.has("checkpoint-incomplete"),
      "②这条通知当场就裁决了（不必回头重读整个前缀）", [...seen].join(","));
    check(rounds <= 2, "②而且位置是往前走的：一轮读完剩下那段就收尾", `${rounds} 轮`);
    const rows = await listMonitors(f.taskId);
    check(rows.length === 1 && rows[0]?.nativeId === "breal01",
      "②普通 Bash 没留下假卡，真 Monitor 照样补出来",
      `${rounds} 轮后 ${rows.length} 条：${rows.map((r) => r.nativeId).join(",")}`);
    check(rows[0]?.status === "exited" && rows[0]?.timeoutMs === 90_000,
      "②而且带着来源报的终态与时长", `${rows[0]?.status}/${rows[0]?.timeoutMs}`);
    check(monitorRecoveryOf(f.taskId) === null, "②最终干净销账（不是永远 pending）",
      JSON.stringify(monitorRecoveryOf(f.taskId)));
  }

  // ── ③ **每一轮都被挤掉**的固定输入必须读完（第 10 轮审查那条阻塞项的形状）────────
  //
  // 150 组顺序完整的普通后台 Bash + 末尾一个真 Monitor，单次只读 32 KiB ⇒ 要三个窗口才读完。
  // 每一轮都把配对状态挤掉：于是每一轮都是「从停好的位置接着读」，而那个窗口里一定有普通
  // Bash 的迟到通知。上一版就停在这儿 —— 通知钉住可重放位置，位置每轮退回同一点，读取窗口
  // 24 轮一动不动，末尾那个 Monitor 永远缺卡（审查用导出的生产扫描器确定性复现）。
  //
  // 这一组**自己手动驱动**、退避阶梯拉到 10 分钟，所以「到底读完没有」不依赖任何定时器抢跑。
  {
    const f = await fixture("evict-every-round");
    let body = line({ type: "system", subtype: "init", session_id: f.cli });
    for (let i = 0; i < 150; i += 1) body += plainBash(f.cli, i);
    const tailAt = bytes(body);
    body += call(f.cli, "tu-btail", "末尾那个哨兵", "2026-10-15T05:10:00.000Z");
    body += started(f.cli, "tu-btail", "btail");
    body += receipt("tu-btail", "btail", "2026-10-15T05:10:00.040Z");
    body += notice(f.cli, "btail");
    writeFileSync(f.file, body);
    check(tailAt > 2 * LIMIT,
      "③夹具里那个 Monitor 在第三个窗口以后（单轮读不到）", `${tailAt} > ${2 * LIMIT}`);

    const squeeze = await makeSqueeze("ev");
    const seen = new Set<string>();
    let rounds = 0;
    for (; rounds < 12; rounds += 1) {
      await backfillClaudeMonitors(f.taskId);
      for (const r of monitorRecoveryOf(f.taskId)?.reasons ?? []) seen.add(r);
      if ((await listMonitors(f.taskId)).length) break;
      await squeeze();                                   // 每一轮都把配对状态挤掉
      check(monitorScanTracked(f.taskId) === false, "③每一轮都确实被挤出了快照表");
    }
    const rows = await listMonitors(f.taskId);
    check(rows.length === 1 && rows[0]?.nativeId === "btail",
      "③每轮都被挤掉，读取位置仍单调前进、最终读到末尾那个 Monitor",
      `${rounds + 1} 轮后 ${rows.length} 条：${rows.map((r) => r.nativeId).join(",")}`);
    check(rounds + 1 <= 5, "③而且是按窗口数收敛的（没有反复重读同一段）", `${rounds + 1} 轮`);
    check(rows[0]?.status === "exited" && rows[0]?.timeoutMs === 90_000,
      "③终态与来源说的时长都在", `${rows[0]?.status}/${rows[0]?.timeoutMs}`);
    check(!seen.has("checkpoint-incomplete"),
      "③一路上没走「回头从零重读」那条兜底路", [...seen].join(","));
  }

  // ── ④ 前缀已跳过时，**新起的一轮 run** 仍要把旧监听判死 ────────────────────────
  //
  // 代次结论上一版只从内存里的 `found` 重算：配对状态被挤掉之后 `found` 是空的，于是新回合
  // 刚建的那个空 run 文件无从落回旧行，而死活裁决退回「这条会话现在有活进程」——拿下一代人的
  // 凭据给上一代续命，卡片一直写着「正在盯着」，刷新也不改（第 10 轮审查用生产服务 + 真页面
  // 实测：检查点恢复的那条 running、从前缀读的对照 lost）。
  //
  // 这里的会话挂着一个**真活着**的进程，所以「判死」只可能来自代次，不可能是退回判死。
  {
    const live = liveProcess();
    try {
      const f = await fixture("generation-evicted", live.pid, live.startedAt);
      let body = line({ type: "system", subtype: "init", session_id: f.cli });
      body += call(f.cli, "tu-bgen", "上一代起的监听", "2026-10-15T06:00:00.000Z");
      body += started(f.cli, "tu-bgen", "bgen");
      body += receipt("tu-bgen", "bgen", "2026-10-15T06:00:00.040Z");
      // **夹具必须撑过单次上限**：读完就销账的任务，软上限（32）直接把快照丢掉、根本不会去
      // 「停好位置」，于是下一轮从零重读、内存里那份 `found` 又回来了 —— 这一组就测不到「前缀
      // 已跳过、found 是空的」那条路（本轮自测：注入「代次只认内存」照样全绿，加了 debug 打印
      // 才看出 parked 是空的）。撑过上限 ⇒ 留账 ⇒ 软上限豁免它 ⇒ 压力落到硬上限那一支。
      body = padTo(body, LIMIT + 2_000);
      writeFileSync(f.file, body);

      await backfillClaudeMonitors(f.taskId);
      check((await listMonitors(f.taskId)).at(0)?.status === "running",
        "④这一刻来源确实还活着（是 running，不是一开始就判死）",
        String((await listMonitors(f.taskId)).at(0)?.status));
      const first = (await db.select().from(monitors).where(eq(monitors.nativeId, "bgen"))).at(0);
      check(first?.sourceRun === f.file, "④行上记着它起在哪个 run 文件里", String(first?.sourceRun));

      check(monitorRecoveryOf(f.taskId)?.pending === true,
        "④第一轮没读完（所以软上限会豁免它，压力落到会停好位置的那一支）");
      const squeeze = await makeSqueeze("ge");
      await squeeze();
      check(monitorScanTracked(f.taskId) === false, "④配对状态被挤掉了（found 现在是空的）");

      writeFileSync(f.runFile("20261015T020000000Z"), "");  // 新回合建了文件，零字节
      await backfillClaudeMonitors(f.taskId);
      const row = (await listMonitors(f.taskId)).at(0);
      check(row?.status === "lost",
        "④空的新 run 文件照样是「上一代已结束」的证据（不被当前活进程续命）", String(row?.status));
      const raw = (await db.select().from(monitors).where(eq(monitors.nativeId, "bgen"))).at(0);
      check(raw?.sourcePid === 0, "④这个结论落了库（下一轮不必再算一遍）", String(raw?.sourcePid));

      const after = (await db.select().from(monitors).where(eq(monitors.nativeId, "bgen"))).at(0);
      check(after?.sourceRun === f.file,
        "④判死靠的是行上那一列和这一轮的文件清单（不是内存里的 found）", String(after?.sourceRun));

      // 对照：同样的活进程、同样被挤掉，但**没有**新 run ⇒ 必须仍是 running。
      const ctl = await fixture("generation-control", live.pid, live.startedAt);
      writeFileSync(ctl.file, body.replaceAll(f.cli, ctl.cli).replaceAll("bgen", "bctl"));
      await backfillClaudeMonitors(ctl.taskId);
      await squeeze();
      check(monitorScanTracked(ctl.taskId) === false, "④对照组同样被挤掉了");
      await backfillClaudeMonitors(ctl.taskId);
      check((await listMonitors(ctl.taskId)).at(0)?.status === "running",
        "④对照组（没有新 run）仍是 running —— 上面那条不是「一挤就判死」",
        String((await listMonitors(ctl.taskId)).at(0)?.status));
    } finally {
      live.kill();
    }
  }

  // ── ⑤ 迟到的起手回执要能**重建那个窄区间**（不拦项 1）────────────────────────────
  //
  // 起点是区间 [调用时刻, 回执时刻]。调用在前缀里、回执在后缀时，上一版包装迟到回执时把起点
  // 一律置空，于是时长补上了、精确到期时刻再也算不出来（审查实测 expiresAt/start_evidence
  // 双空）。区间的下界记在行上（`start_low_at`），这条就能重建。
  {
    const f = await fixture("late-receipt");
    const at0 = "2026-10-15T07:00:00.000Z";
    const at1 = "2026-10-15T07:00:00.040Z";
    let body = line({ type: "system", subtype: "init", session_id: f.cli });
    body += call(f.cli, "tu-blate", "回执在后缀的监听", at0);
    body += started(f.cli, "tu-blate", "blate2");
    body = padTo(body, LIMIT);
    body += receipt("tu-blate", "blate2", at1);
    writeFileSync(f.file, body);

    await backfillClaudeMonitors(f.taskId);
    const before = (await listMonitors(f.taskId)).at(0);
    check(before?.timeoutMs === null || before?.timeoutMs === undefined,
      "⑤第一轮还不知道时长（回执在后缀）", String(before?.timeoutMs));
    const rawBefore = (await db.select().from(monitors).where(eq(monitors.nativeId, "blate2"))).at(0);
    check(rawBefore?.startLowAt === at0, "⑤但起点区间的下界已经记在行上了", String(rawBefore?.startLowAt));

    const squeeze = await makeSqueeze("lr");
    await squeeze();
    check(monitorScanTracked(f.taskId) === false, "⑤配对状态被挤掉了");

    const seen = new Set<string>();
    await driveUntil(f.taskId, async () => !monitorRecoveryOf(f.taskId), seen);
    const after = (await listMonitors(f.taskId)).at(0);
    const raw = (await db.select().from(monitors).where(eq(monitors.nativeId, "blate2"))).at(0);
    check(after?.timeoutMs === 90_000, "⑤迟到回执把时长补上了", String(after?.timeoutMs));
    check(raw?.startEvidence === "receipt-window" && raw?.startAnchorWidthMs === 40,
      "⑤而且窄区间重建出来了（档位 + 误差界都在）",
      `${raw?.startEvidence}/${raw?.startAnchorWidthMs}`);
    check(after?.expiresAt === new Date(Date.parse(at1) + 90_000).toISOString(),
      "⑤于是对外仍给得出精确到期时刻", String(after?.expiresAt));
  }

  // ── ⑥ 唯一裁不清的那种：存量行没记 tool_use_id ⇒ 重放一遍，但**不许无限重放** ──────
  //
  // 这一列是后加的，存量行是空的。后缀里一条起手回执配不上任何行时，不能断言它与我们无关
  // （它可能正属于某个存量行）——那就回到从零重放一遍。而重放完还是配不上的话**必须收手**，
  // 否则就是另一种不收敛（每一轮都回到零，永远销不了账）。
  {
    const live = liveProcess();
    try {
      const f = await fixture("legacy-receipt", live.pid, live.startedAt);
      await db.insert(monitors).values({
        id: "m-legacy", taskId: f.taskId, command: "tail -F /tmp/legacy", description: "存量行",
        cwd: "", status: "running", logPath: "", startedAt: now(), expiresAt: now(),
        kind: "claude", nativeId: "blegacy", cliSessionId: f.cli,
        sourceLifetime: "unknown", toolUseId: null,   // ← 这一列是空的：裁不清就来自这里
      });
      let body = line({ type: "system", subtype: "init", session_id: f.cli });
      body = padTo(body, LIMIT);
      body += receipt("tu-blegacy", "blegacy", "2026-10-15T08:00:00.040Z");
      writeFileSync(f.file, body);

      await backfillClaudeMonitors(f.taskId);     // 第一轮：前缀里什么都没有
      const squeeze = await makeSqueeze("lg");
      await squeeze();
      check(monitorScanTracked(f.taskId) === false, "⑥配对状态被挤掉了（下一轮从停好的位置接着读）");

      const seen = new Set<string>();
      const rounds = await driveUntil(f.taskId, async () => !monitorRecoveryOf(f.taskId), seen);
      check(seen.has("checkpoint-incomplete"),
        "⑥这条回执配不上任何行、又有没记 tool_use_id 的存量行 ⇒ 回头重放一遍",
        [...seen].join(","));
      check(monitorRecoveryOf(f.taskId) === null,
        "⑥但重放完还是配不上就收手（不是每轮都回到零、永远销不了账）",
        `${rounds} 轮后 ${JSON.stringify(monitorRecoveryOf(f.taskId))}`);
      check((await listMonitors(f.taskId)).length === 1,
        "⑥期间没有凭空多出一张卡", String((await listMonitors(f.taskId)).length));
    } finally {
      live.kill();
    }
  }


  // ── ⑦ **起不来的那条调用**不许把位置钉死（第 11 轮审查那条阻塞项的形状）───────────
  //
  // 开头一条 Monitor 调用**启动被拒**：有 `is_error` 回执、永远不会有 `task_started`。上一版
  // 的可重放位置「绝不越过一条还悬着的调用」，于是它永久悬着、位置每轮退回它之前，读取窗口
  // 一动不动 —— 已完成的一号一直写着 running，末尾的二号永远不出现（审查用导出的生产回填
  // + 真页面确定性复现 12 轮）。
  //
  // 判据必须是「配不上 task_started 且这条回执没说起成了」，**不是回执里的错误文案**：
  // 换一句措辞就漏一类。所以这一组的回执文本刻意不含任何 Monitor 字样。
  {
    const f = await fixture("rejected-call");
    let body = line({ type: "system", subtype: "init", session_id: f.cli });
    body += call(f.cli, "tu-bad", "起不来的那个", "2026-10-15T07:00:00.000Z");
    body += line({ type: "user", timestamp: "2026-10-15T07:00:00.030Z", message: { content: [
      { type: "tool_result", tool_use_id: "tu-bad", is_error: true, content: "Error: command not permitted" },
    ] } });
    body += call(f.cli, "tu-bfirst", "一号监听", "2026-10-15T07:01:00.000Z");
    body += started(f.cli, "tu-bfirst", "bfirst");
    body += receipt("tu-bfirst", "bfirst", "2026-10-15T07:01:00.040Z");
    body = padLines(body, LIMIT + 5_000);                // 一号的完成通知落到第二个窗口
    body += notice(f.cli, "bfirst");
    body += call(f.cli, "tu-blast", "末尾的二号监听", "2026-10-15T07:30:00.000Z");
    body += started(f.cli, "tu-blast", "blast");
    body += receipt("tu-blast", "blast", "2026-10-15T07:30:00.040Z");
    body += notice(f.cli, "blast");
    writeFileSync(f.file, body);

    const squeeze = await makeSqueeze("rj");
    const seen = new Set<string>();
    let rounds = 0;
    for (; rounds < 12; rounds += 1) {
      await backfillClaudeMonitors(f.taskId);
      for (const r of monitorRecoveryOf(f.taskId)?.reasons ?? []) seen.add(r);
      if ((await listMonitors(f.taskId)).length >= 2 && !monitorRecoveryOf(f.taskId)) break;
      await squeeze();                                   // 每一轮都把配对状态挤掉
      check(monitorScanTracked(f.taskId) === false, "⑦每一轮都确实被挤出了快照表");
    }
    const rows = await listMonitors(f.taskId);
    check(rows.length === 2 && rows.some((r) => r.nativeId === "blast"),
      "⑦起不来的那条调用没把位置钉住，末尾的二号读到了",
      `${rounds + 1} 轮后 ${rows.length} 条：${rows.map((r) => `${r.nativeId}/${r.status}`).join(",")}`);
    check(rows.every((r) => r.status === "exited"),
      "⑦两条都带着来源说的终态（不再有一条永远 running）",
      rows.map((r) => `${r.nativeId}/${r.status}`).join(","));
    check(rounds + 1 <= 5, "⑦而且是按窗口数收敛的", `${rounds + 1} 轮`);
    check(!monitorRecoveryOf(f.taskId), "⑦账也销了", JSON.stringify(monitorRecoveryOf(f.taskId)));
    check(!seen.has("checkpoint-incomplete"), "⑦一路上没走「回头从零重读」那条兜底路", [...seen].join(","));
    const left = await db.select().from(schema.monitorPendingCalls)
      .where(eq(schema.monitorPendingCalls.taskId, f.taskId));
    check(left.length === 0, "⑦起不来的那条调用也从未决表里销掉了（不是永远留着）",
      left.map((r) => r.toolUseId).join(","));
  }

  // ── ⑧ 跨窗口 + 跨淘汰的调用：**入参靠落盘接回来**，不靠把位置退回那一行 ───────────
  //
  // 一条 Monitor 调用在第一个窗口里，它的 `task_started` 在后面的窗口里，而每一轮都把配对
  // 状态挤掉。位置不回退之后，这条调用的入参（命令、说明）只能来自 `monitor_pending_calls`
  // ——落盘这一步要是没做，`task_started` 就配不上任何调用、按「那个工具不是 Monitor」被
  // 丢掉，这张卡永远不出现。
  {
    const f = await fixture("hanging-call");
    let body = line({ type: "system", subtype: "init", session_id: f.cli });
    body += call(f.cli, "tu-bhang", "跨窗口的那个哨兵", "2026-10-15T08:00:00.000Z");
    body = padLines(body, LIMIT + 5_000);                // 启动行落到第二个窗口
    body += started(f.cli, "tu-bhang", "bhang");
    body += receipt("tu-bhang", "bhang", "2026-10-15T08:00:00.050Z");
    body += notice(f.cli, "bhang");
    writeFileSync(f.file, body);

    const squeeze = await makeSqueeze("hg");
    await backfillClaudeMonitors(f.taskId);
    const parkedCall = await db.select().from(schema.monitorPendingCalls)
      .where(eq(schema.monitorPendingCalls.taskId, f.taskId));
    check(parkedCall.length === 1 && parkedCall[0]?.command === "sleep 1800"
      && parkedCall[0]?.description === "跨窗口的那个哨兵",
      "⑧第一轮把那条悬着的调用连入参一起落了盘",
      JSON.stringify(parkedCall.map((r) => [r.toolUseId, r.command, r.description])));
    const seen = new Set<string>();
    let rounds = 0;
    for (; rounds < 12; rounds += 1) {
      await squeeze();                                   // 配对状态（含内存里的 pending）丢掉
      check(monitorScanTracked(f.taskId) === false, "⑧每一轮都确实被挤出了快照表");
      await backfillClaudeMonitors(f.taskId);
      for (const r of monitorRecoveryOf(f.taskId)?.reasons ?? []) seen.add(r);
      if ((await listMonitors(f.taskId)).length) break;
    }
    const rows = await listMonitors(f.taskId);
    check(rows.length === 1 && rows[0]?.nativeId === "bhang",
      "⑧跨淘汰之后仍然成行（入参从未决表接回来的）",
      `${rounds + 1} 轮后 ${rows.length} 条：${rows.map((r) => r.nativeId).join(",")}`);
    check(rows[0]?.description === "跨窗口的那个哨兵" && rows[0]?.command === "sleep 1800",
      "⑧而且入参是原样的（不是编的占位）", `${rows[0]?.command} / ${rows[0]?.description}`);
    check(rows[0]?.status === "exited" && rows[0]?.timeoutMs === 90_000,
      "⑧终态与来源说的时长都在", `${rows[0]?.status}/${rows[0]?.timeoutMs}`);
    check(rounds + 1 <= 4, "⑧按窗口数收敛", `${rounds + 1} 轮`);
    const left = await db.select().from(schema.monitorPendingCalls)
      .where(eq(schema.monitorPendingCalls.taskId, f.taskId));
    check(left.length === 0, "⑧配上之后未决表就销账了", left.map((r) => r.toolUseId).join(","));
  }


  // ── ⑨ 一条**比读取窗口还长**的记录不许把整个文件卡死 ───────────────────────────
  //
  // 窗口内一个换行都没有 ⇒ 位置零进展，下一轮同样的输入同样读不出换行：这个文件之后的内容
  // 和后面所有 run 文件永远读不到（第 11 轮审查 N3 的上半；本轮自测时 ⑦⑧ 的第一版夹具正好
  // 造出了这一条，两组都停在第一个窗口里）。那条记录在这个窗口下无论如何都解析不了，所以
  // 跳过它、位置继续往前 —— 丢一条事件，换这个文件剩下的部分都读得到。
  {
    const f = await fixture("oversized-record");
    let body = line({ type: "system", subtype: "init", session_id: f.cli });
    // 一条 1.5 个窗口长的文本事件（合法 JSON，就是太长）
    body += line({ type: "assistant", timestamp: "2026-10-15T09:00:00.000Z",
      message: { content: [{ type: "text", text: "y".repeat(LIMIT + LIMIT / 2) }] } });
    const tailAt = bytes(body);
    body += call(f.cli, "tu-bover", "超长记录后面的哨兵", "2026-10-15T09:10:00.000Z");
    body += started(f.cli, "tu-bover", "bover");
    body += receipt("tu-bover", "bover", "2026-10-15T09:10:00.040Z");
    body += notice(f.cli, "bover");
    writeFileSync(f.file, body);
    check(tailAt > LIMIT, "⑨夹具里那条记录确实比窗口长", `${tailAt} > ${LIMIT}`);

    let rounds = 0;
    for (; rounds < 6; rounds += 1) {
      await backfillClaudeMonitors(f.taskId);
      if ((await listMonitors(f.taskId)).length) break;
    }
    const rows = await listMonitors(f.taskId);
    check(rows.length === 1 && rows[0]?.nativeId === "bover",
      "⑨跳过那条超长记录之后，它后面的 Monitor 读到了",
      `${rounds + 1} 轮后 ${rows.length} 条`);
    check(rows[0]?.status === "exited", "⑨终态也在", String(rows[0]?.status));
    check(rounds + 1 <= 3, "⑨而且没有反复重读同一段", `${rounds + 1} 轮`);
    check(!monitorRecoveryOf(f.taskId), "⑨账销了（不是永远「还没读完」）",
      JSON.stringify(monitorRecoveryOf(f.taskId)));
  }


  // ── ⑩ 删任务时未决行也要跟着走（没有别的入口能清它）─────────────────────────────
  {
    const f = await fixture("delete-cascade");
    let body = line({ type: "system", subtype: "init", session_id: f.cli });
    body += call(f.cli, "tu-bleft", "只剩调用的那条", "2026-10-15T10:00:00.000Z");
    writeFileSync(f.file, body);
    await backfillClaudeMonitors(f.taskId);
    const before = await db.select().from(schema.monitorPendingCalls)
      .where(eq(schema.monitorPendingCalls.taskId, f.taskId));
    check(before.length === 1, "⑩先确认库里真有一条未决行", String(before.length));
    const { deleteTaskAssociations } = await import("../src/task-delete-routes.js");
    await deleteTaskAssociations(f.taskId);
    const after = await db.select().from(schema.monitorPendingCalls)
      .where(eq(schema.monitorPendingCalls.taskId, f.taskId));
    check(after.length === 0, "⑩删任务把它一起带走了", String(after.length));
    // **再读一轮**：删除只清了库的话，按 taskId 缓着的那份扫描状态还留着上一轮悬着的调用，
    // 这一轮提交完就会把它重新插回去 —— 一条再也没有入口能清的孤儿行（第 12 轮审查 N5）。
    // 删除那一侧要连扫描状态、位置、恢复责任一起作废。
    await backfillClaudeMonitors(f.taskId);
    const revived = await db.select().from(schema.monitorPendingCalls)
      .where(eq(schema.monitorPendingCalls.taskId, f.taskId));
    check(revived.length === 0, "⑩删完之后再读一轮，旧桶里那条不会被写回来",
      JSON.stringify(revived));
    check(monitorRecoveryOf(f.taskId) === null, "⑩删除也把它的恢复责任作废了（不会一直自动重推）",
      JSON.stringify(monitorRecoveryOf(f.taskId)));
  }

  if (failures === 0) {
    console.log("✓ 内置 Monitor 的检查点：位置只停在可重放处（被跳过的调用会重放）/ "
      + "位置之前已成行的按 native_id 与 tool_use_id 配回去 / "
      + "配不上的当场裁决（位置照常前进）/ 每轮都被挤掉的固定输入按窗口数收敛 / "
      + "跳过前缀后新起的 run 仍把旧监听判死 / 迟到回执重建窄区间 / "
      + "唯一裁不清的那种重放一遍就收手 / "
      + "起不来的调用不钉位置、跨窗口的调用靠落盘接回来 / "
      + "装不进窗口的那条记录跳过而不是卡死 / 删任务连未决行和扫描状态一起带走 均受回归保护");
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
