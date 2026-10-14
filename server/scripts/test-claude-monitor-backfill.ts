// 历史回填：升级之前跑过的内置 Monitor 要能补进面板。
//
// 这条路是整个功能的起点：用户打开一个任务，agent 在对话里反复说「等 Monitor 通知」，
// 面板却写着「这个任务上还没有哨兵」。实时投影只管之后发生的事，对那个任务本身一个字都
// 答不了（第 2 轮审查实测：旧任务打开仍是空面板）。
//
// 这份测试钉的几条，每条都对应一次实测踩中的坑：
// ① `sessions.agent_out_path` 只记**最后一次** run 的文件（每回合覆盖一次）。照它扫只能
//    扫到最后一回合，而 Monitor 多半起在中间某轮——实测用户那个任务 12 个 Monitor 全在
//    前几个文件里，照字段扫一条都补不到。
// ② 普通后台 Bash 同样是 `local_bash`，混进来会把面板变成一份后台命令流水账。
// ③ **没读到终态 ≠ 已经死了。** 来源还活着就得写 running。第 3 轮审查实测：来源
//    sourceAlive=true 的卡片写着 lost，而且真 completed 到了也改不回来。
// ④ 会话 id 含 `-`（nanoid 字母表里有）时文件仍要匹配得上。
// ⑤ `cli_session_id` 为空的存量行要被补上归属——不补，开机清扫和流收尾都认不出它。
// ⑥ 跨文件的 started / 通知要关联得上（状态不能每个文件重置）。
// ⑦ 写失败不能当成「唯一索引撞上了」静静忽略，而且不能记成「扫过了」。
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
    { type: "assistant", timestamp: "2026-10-14T01:00:05.000Z", message: { model: "m", content: [
      { type: "tool_use", name: "Monitor", id: "tu1", input: { command: "until grep -q OK /tmp/a; do sleep 5; done", description: "第一轮的哨兵", timeout_ms: 900_000 } },
      { type: "tool_use", name: "Bash", id: "tb1", input: { command: "pytest -q", run_in_background: true } },
    ] } },
    { type: "system", subtype: "task_started", task_id: "bh001", tool_use_id: "tu1", task_type: "local_bash", session_id: CLI },
    { type: "system", subtype: "task_started", task_id: "bbash1", tool_use_id: "tb1", task_type: "local_bash", session_id: CLI },
    { type: "user", timestamp: "2026-10-14T01:00:06.000Z", message: { role: "user", content: [
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
  // 起点取**起手回执**那条事件的时刻（01:00:06），不是 tool_use 那条（01:00:05）：工具调用
  // 可能卡在权限确认上，两者能差很久，而回执是启动后立刻返回的。
  check(first?.startedAt === "2026-10-14T01:00:06.000Z", "起点用起手回执那条事件的时刻", String(first?.startedAt));
  const span = first?.expiresAt ? Date.parse(first.expiresAt) - Date.parse(first.startedAt) : -1;
  check(Math.abs(span - 600_000) < 2_000, "期限按回执的 10 分钟，不是请求的 15 分钟", `${span}ms`);

  const second = rows.find((r) => r.nativeId === "bh002");
  // 没读到终态**且来源确实已经不在**（这个任务名下没有活着的 claude agent）才补 lost。
  // 判据是来源死活，不是「我没读到」——另一半（来源还活着）在下面 aliveSource() 里钉。
  check(second?.status === "lost", "没读到终态、来源也确实没了 → lost", String(second?.status));
  check(/历史记录/.test(second?.endedReason ?? ""), "并说明为什么不知道它的结局", second?.endedReason ?? "");


  // ── ③ 来源还活着：没读到终态**不等于**已经死了 ──────────────────────────────
  // 第 3 轮审查实测的那一幕：卡片写着 lost、说「那一轮的进程早已结束」，而起它的 agent
  // 就在旁边跑着。判据必须是来源死活，不是「我有没有读到」。
  async function aliveSource(): Promise<void> {
    const dir = join(root, "runs", "t-live");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "sessLive-20261014T040000000Z.agent-out.jsonl");
    writeFileSync(path, [
      { type: "system", subtype: "init", session_id: "cli-live" },
      { type: "assistant", timestamp: "2026-10-14T04:00:01.000Z", message: { model: "m", content: [
        { type: "tool_use", name: "Monitor", id: "tuL", input: { command: "tail -F /tmp/live", description: "还在盯着", timeout_ms: 600_000 } },
      ] } },
      { type: "system", subtype: "task_started", task_id: "bLive", tool_use_id: "tuL", task_type: "local_bash", session_id: "cli-live" },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");

    await db.insert(tasks).values({ id: "t-live", projectId: "p", title: "来源还活着", body: "", status: "running",
      agentType: "claude", mode: "single", createdAt: now(), updatedAt: now() });
    // agent_pid 指向一个**真的活着**的进程（就是本测试进程）：isSameProcess 在没记启动
    // 时刻时退化成存在性检查，所以这就是一个真实存活的来源。
    await db.insert(sessions).values({
      id: "sessLive", taskId: "t-live", role: "single", agentType: "claude", executor: "claude@x",
      cliSessionId: "cli-live", cwd: root, startedAt: now(), agentOutPath: path,
      agentPid: process.pid, agentStartedAt: null,
    });

    check(await backfillClaudeMonitors("t-live") === 1, "来源还活着的也补进来");
    const row = (await listMonitors("t-live")).at(0);
    check(row?.status === "running", "没读到终态但来源还活着 → running，不宣告死亡", String(row?.status));
    check(!row?.endedAt, "还在盯着的没有结束时刻", String(row?.endedAt));
    check(row?.lifetime === "unknown", "没读到回执 → 期限未知，不拿请求值冒充", String(row?.lifetime));

    // 起始时刻取事件自报的 timestamp，不是「回填运行的这一刻」（相差可能是几天）。
    check(row?.startedAt === "2026-10-14T04:00:01.000Z", "起始时刻用事件自报的时刻", String(row?.startedAt));
  }
  await aliveSource();

  // ── ④ 会话 id 含 `-`：nanoid 的字母表里有它（实测 `-0123456789A-Za-z_`）─────────
  //
  // 前一版按「**文件名**截到第一个 `-`」推前缀，两种 id 各有一种坏法，这组各钉一条：
  //   (a) `-` 在开头 → 截出来的前缀是整个文件名，于是**只扫到 agent_out_path 指的那一个**
  //       文件。而回填存在的全部理由就是那个字段只记最后一回合——Monitor 起在前面某轮就
  //       一条都补不到（第 3 轮审查实测 added=0）。所以 fixture 必须把 Monitor 放在
  //       **不是**字段指向的那个文件里，否则两种实现都能过。
  //   (b) `-` 在中间 → 前缀短得只剩第一段，会把**别的会话**的文件一起吃进来。
  async function dashedSessionId(): Promise<void> {
    const sid = "-abcDEF12345";          // (a) 以 `-` 开头
    const other = "-abcDEF99999";        // 同目录下的另一条会话，前缀与 sid 几乎一样
    const dir = join(root, "runs", "t-dash");
    mkdirSync(dir, { recursive: true });

    const ev = (stamp: string, nativeId: string, tu: string, desc: string) => [
      { type: "system", subtype: "init", session_id: "cli-dash" },
      { type: "assistant", timestamp: stamp, message: { model: "m", content: [
        { type: "tool_use", name: "Monitor", id: tu, input: { command: "tail -F /tmp/d", description: desc, timeout_ms: 600_000 } },
      ] } },
      { type: "system", subtype: "task_started", task_id: nativeId, tool_use_id: tu, task_type: "local_bash", session_id: "cli-dash" },
      { type: "system", subtype: "task_notification", task_id: nativeId, status: "completed", summary: "跑完了", session_id: "cli-dash" },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n";

    // 第 1 个文件：Monitor 在这儿。字段**不**指向它。
    writeFileSync(join(dir, `${sid}-20261014T050000000Z.agent-out.jsonl`), ev("2026-10-14T05:00:01.000Z", "bDash", "tuD", "带横线的会话"));
    // 第 2 个文件：这一轮没起 Monitor —— 而 agent_out_path 指向的就是它。
    const last = join(dir, `${sid}-20261014T053000000Z.agent-out.jsonl`);
    writeFileSync(last, JSON.stringify({ type: "result", subtype: "success", session_id: "cli-dash" }) + "\n");
    // (b) 另一条会话的文件，它的 Monitor **不该**被算进这个任务。
    writeFileSync(join(dir, `${other}-20261014T060000000Z.agent-out.jsonl`), ev("2026-10-14T06:00:01.000Z", "bOther", "tuX", "别的会话"));

    await db.insert(tasks).values({ id: "t-dash", projectId: "p", title: "带横线的会话 id", body: "", status: "done",
      agentType: "claude", mode: "single", createdAt: now(), updatedAt: now() });
    await db.insert(sessions).values({
      id: sid, taskId: "t-dash", role: "single", agentType: "claude", executor: "claude@x",
      cliSessionId: "cli-dash", cwd: root, startedAt: now(), agentOutPath: last,
    });

    const n = await backfillClaudeMonitors("t-dash");
    const rows = await listMonitors("t-dash");
    check(n === 1, "以 `-` 开头的会话 id：字段没指向的那个文件也扫到了（前缀取 sessions.id）", `实际 ${n}`);
    check(rows.some((r) => r.nativeId === "bDash"), "补的是自己那条");
    check(!rows.some((r) => r.nativeId === "bOther"), "没把前缀相近的另一条会话的 Monitor 吃进来");

    // (b) `-` 在**中间**：截断后前缀只剩 `mid-`，同目录里 `mid-` 开头的别家文件会被一起
    // 吃掉。上面那个 fixture 触发不了这一条（它的 `-` 在开头，截出来的前缀反而过长）。
    const mid = "mid-DEF12345";
    const midDir = join(root, "runs", "t-mid");
    mkdirSync(midDir, { recursive: true });
    writeFileSync(join(midDir, `${mid}-20261014T070000000Z.agent-out.jsonl`), ev("2026-10-14T07:00:01.000Z", "bMid", "tuM", "自己的"));
    writeFileSync(join(midDir, `mid-ZZZ99999-20261014T080000000Z.agent-out.jsonl`), ev("2026-10-14T08:00:01.000Z", "bNeighbor", "tuN", "邻居的"));
    await db.insert(tasks).values({ id: "t-mid", projectId: "p", title: "横线在中间", body: "", status: "done",
      agentType: "claude", mode: "single", createdAt: now(), updatedAt: now() });
    await db.insert(sessions).values({
      id: mid, taskId: "t-mid", role: "single", agentType: "claude", executor: "claude@x",
      cliSessionId: "cli-dash", cwd: root, startedAt: now(),
      agentOutPath: join(midDir, `${mid}-20261014T070000000Z.agent-out.jsonl`),
    });
    const midRows = await listMonitors("t-mid");
    await backfillClaudeMonitors("t-mid");
    const after = await listMonitors("t-mid");
    check(midRows.length === 0 && after.length === 1,
      "`-` 在中间时只补自己那条，不把 `mid-` 开头的邻居会话吃进来", `实际 ${after.length} 条：${after.map((r) => r.nativeId).join(",")}`);
  }
  await dashedSessionId();

  // ── ⑤ 存量行缺会话归属：回填要补上，不是整行跳过 ────────────────────────────
  // 不补的后果：开机清扫和流收尾都按 cli_session_id 认人，这行从此谁都管不了，永远 running
  // （第 3 轮审查实测它穿过 sweep、回填、真 completed 和 finishAll 全程没变）。
  async function adoptOrphanRow(): Promise<void> {
    const dir = join(root, "runs", "t-orphan");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "sessOrph-20261014T060000000Z.agent-out.jsonl");
    writeFileSync(path, [
      { type: "system", subtype: "init", session_id: "cli-orph" },
      { type: "assistant", timestamp: "2026-10-14T06:00:01.000Z", message: { model: "m", content: [
        { type: "tool_use", name: "Monitor", id: "tuO", input: { command: "tail -F /tmp/o", description: "存量行", timeout_ms: 600_000 } },
      ] } },
      { type: "system", subtype: "task_started", task_id: "bOrph", tool_use_id: "tuO", task_type: "local_bash", session_id: "cli-orph" },
      { type: "user", timestamp: "2026-10-14T06:00:02.000Z", message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "tuO", content: "Monitor started (task bOrph, expires in 1m 30s unless the source ends first)." },
      ] } },
      { type: "system", subtype: "task_notification", task_id: "bOrph", status: "completed", summary: "结束了", session_id: "cli-orph" },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");

    await db.insert(tasks).values({ id: "t-orphan", projectId: "p", title: "存量行", body: "", status: "done",
      agentType: "claude", mode: "single", createdAt: now(), updatedAt: now() });
    await db.insert(sessions).values({
      id: "sessOrph", taskId: "t-orphan", role: "single", agentType: "claude", executor: "claude@x",
      cliSessionId: "cli-orph", cwd: root, startedAt: now(), agentOutPath: path,
    });
    // 一条「升级前落下」的行：没有归属、期限声称未知、ash 推断成了 lost。
    await db.insert(monitors).values({
      id: "m-orphan", taskId: "t-orphan", command: "tail -F /tmp/o", description: "存量行", cwd: "",
      status: "lost", pid: null, pidStartedAt: null, logPath: "", offset: 0, events: 0, exitCode: null,
      startedAt: "2026-10-14T06:00:01.000Z", expiresAt: "2026-10-14T06:00:01.000Z",
      endedAt: now(), endedReason: "推断的", ownerUserId: null,
      kind: "claude", nativeId: "bOrph", cliSessionId: null, sourceLifetime: "unknown",
    });

    const n = await backfillClaudeMonitors("t-orphan");
    check(n === 0, "已有行不重复插入", `实际新增 ${n}`);
    const row = (await db.select().from(monitors).where(eq(monitors.id, "m-orphan"))).at(0);
    check(row?.cliSessionId === "cli-orph", "存量行的会话归属被补上了", String(row?.cliSessionId));
    check(row?.status === "exited", "ash 推断的 lost 被来源事实纠正成 exited", String(row?.status));
    check(row?.sourceLifetime === "bounded", "期限从未知升级成来源回执说的那个", String(row?.sourceLifetime));
    const span = row ? Date.parse(row.expiresAt) - Date.parse(row.startedAt) : -1;
    check(span === 90_000, "`1m 30s` 读成 90 秒整，不是 60 秒（复合时长）", `${span}ms`);
  }
  await adoptOrphanRow();

  // ── ⑥ 跨文件：started 在前一个文件、通知在后一个 ───────────────────────────
  // 状态每个文件重置的话，后一个文件里的通知找不到对应的 found 行，于是又回到写 lost。
  async function acrossFiles(): Promise<void> {
    const dir = join(root, "runs", "t-span");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sessSpan-20261014T070000000Z.agent-out.jsonl"), [
      { type: "system", subtype: "init", session_id: "cli-span" },
      { type: "assistant", timestamp: "2026-10-14T07:00:01.000Z", message: { model: "m", content: [
        { type: "tool_use", name: "Monitor", id: "tuS", input: { command: "tail -F /tmp/s", description: "跨文件", timeout_ms: 600_000 } },
      ] } },
      { type: "system", subtype: "task_started", task_id: "bSpan", tool_use_id: "tuS", task_type: "local_bash", session_id: "cli-span" },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const second = join(dir, "sessSpan-20261014T080000000Z.agent-out.jsonl");
    writeFileSync(second, [
      // 回执和终态都落在**下一回合**的文件里。
      { type: "user", timestamp: "2026-10-14T08:00:01.000Z", message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "tuS", content: "Monitor started (task bSpan, expires in 29m 50s unless the source ends first)." },
      ] } },
      { type: "system", subtype: "task_notification", task_id: "bSpan", status: "completed", summary: "跨文件跑完了", session_id: "cli-span" },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");

    await db.insert(tasks).values({ id: "t-span", projectId: "p", title: "跨文件", body: "", status: "done",
      agentType: "claude", mode: "single", createdAt: now(), updatedAt: now() });
    await db.insert(sessions).values({
      id: "sessSpan", taskId: "t-span", role: "single", agentType: "claude", executor: "claude@x",
      cliSessionId: "cli-span", cwd: root, startedAt: now(), agentOutPath: second,
    });
    check(await backfillClaudeMonitors("t-span") === 1, "跨文件的那条补上了");
    const row = (await listMonitors("t-span")).at(0);
    check(row?.status === "exited", "后一个文件里的通知关联到了前一个文件里的 started", String(row?.status));
    check(row?.endedAt === "2026-10-14T08:00:01.000Z", "结束时刻用通知附近那条事件的时刻，不是 now()", String(row?.endedAt));
    const span2 = row?.expiresAt ? Date.parse(row.expiresAt) - Date.parse(row.startedAt) : -1;
    check(span2 === 1_790_000, "`29m 50s` 读成 1790 秒，不是 1740 秒", `${span2}ms`);
  }
  await acrossFiles();

  // ── ⑥b 没有事件时刻、只有 run 文件名上那个时刻 → 不编到期时刻 ────────────────
  // 文件名上的时刻是**这一轮进程开始**的时刻，不是 Monitor 开始的时刻：agent 可能先干了
  // 20 分钟活才挂上一个 10 分钟的哨兵，拿它当锚点算出来的「盯到 X」会早得离谱。报告原话是
  // 「历史缺乏真实监听起点时应保留未知，不能用 run 时间制造精确到期时刻」。
  async function fileTimeIsNotAnAnchor(): Promise<void> {
    const dir = join(root, "runs", "t-anchor");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "sessAnc-20261014T110000000Z.agent-out.jsonl");
    writeFileSync(path, [
      // 刻意一条 timestamp 都不给（旧版本的 CLI 输出、或日志被改写过）。
      { type: "system", subtype: "init", session_id: "cli-anc" },
      { type: "assistant", message: { model: "m", content: [
        { type: "tool_use", name: "Monitor", id: "tuA", input: { command: "tail -F /tmp/a", description: "没有时间锚点", timeout_ms: 600_000 } },
      ] } },
      { type: "system", subtype: "task_started", task_id: "bAnc", tool_use_id: "tuA", task_type: "local_bash", session_id: "cli-anc" },
      { type: "user", message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "tuA", content: "Monitor started (task bAnc, expires in 10m unless the source ends first)." },
      ] } },
      { type: "system", subtype: "task_notification", task_id: "bAnc", status: "completed", summary: "好了", session_id: "cli-anc" },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
    await db.insert(tasks).values({ id: "t-anchor", projectId: "p", title: "没有锚点", body: "", status: "done",
      agentType: "claude", mode: "single", createdAt: now(), updatedAt: now() });
    await db.insert(sessions).values({
      id: "sessAnc", taskId: "t-anchor", role: "single", agentType: "claude", executor: "claude@x",
      cliSessionId: "cli-anc", cwd: root, startedAt: now(), agentOutPath: path,
    });
    check(await backfillClaudeMonitors("t-anchor") === 1, "照样补进来");
    const row = (await listMonitors("t-anchor")).at(0);
    check(row?.status === "exited", "终态照常落（那是来源说的事实）", String(row?.status));
    check(row?.lifetime === "unknown", "读到了回执也不编到期时刻：起点不可信", String(row?.lifetime));
    check(row?.expiresAt === null, "对外不给到期时刻", String(row?.expiresAt));
    check(row?.startedAt === "2026-10-14T11:00:00.000Z", "起点退回文件时刻，只作显示", String(row?.startedAt));
  }
  await fileTimeIsNotAnAnchor();

  // ── ⑦ 写失败：不能当成「唯一索引撞上了」静静忽略，也不能记成「扫过了」────────────
  // 前一版 catch 里是空的，于是一次 SQLITE_BUSY 之后那张卡永久消失，日志里一个字都没有，
  // 而且因为「扫过了」在扫描一开始就记下，本进程内再也不会重试（第 3 轮审查实测
  // injected=1、rows=[]、warnings=[]）。
  async function writeFailureRetries(): Promise<void> {
    const dir = join(root, "runs", "t-fail");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "sessFail-20261014T090000000Z.agent-out.jsonl");
    writeFileSync(path, [
      { type: "system", subtype: "init", session_id: "cli-fail" },
      { type: "assistant", timestamp: "2026-10-14T09:00:01.000Z", message: { model: "m", content: [
        { type: "tool_use", name: "Monitor", id: "tuF", input: { command: "tail -F /tmp/f", description: "写失败那条", timeout_ms: 600_000 } },
      ] } },
      { type: "system", subtype: "task_started", task_id: "bFail", tool_use_id: "tuF", task_type: "local_bash", session_id: "cli-fail" },
      { type: "system", subtype: "task_notification", task_id: "bFail", status: "completed", summary: "跑完了", session_id: "cli-fail" },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");

    await db.insert(tasks).values({ id: "t-fail", projectId: "p", title: "写失败", body: "", status: "done",
      agentType: "claude", mode: "single", createdAt: now(), updatedAt: now() });
    await db.insert(sessions).values({
      id: "sessFail", taskId: "t-fail", role: "single", agentType: "claude", executor: "claude@x",
      cliSessionId: "cli-fail", cwd: root, startedAt: now(), agentOutPath: path,
    });

    // 注入一次写失败：**不是**唯一索引冲突，所以必须被当成真失败。
    const realInsert = db.insert.bind(db);
    let injected = 0;
    (db as any).insert = (table: unknown) => {
      if (table === monitors && injected === 0) {
        injected += 1;
        return { values: async () => { throw Object.assign(new Error("INJECTED_SQLITE_BUSY"), { errcode: 5 }); } };
      }
      return realInsert(table as never);
    };
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(" ")); };
    let first = -1;
    try { first = await backfillClaudeMonitors("t-fail"); } finally { console.warn = realWarn; (db as any).insert = realInsert; }

    check(injected === 1, "注入生效了", `实际 ${injected}`);
    check(first === 0, "写失败那一次没谎报补了几条", `实际 ${first}`);
    check(warnings.some((w) => /回填失败/.test(w)), "留下了线索，不是静静吞掉", warnings.join(" | ") || "(没有任何日志)");

    // 恢复之后**必须还能再试**——「扫过了」不该在失败时记下。
    const second = await backfillClaudeMonitors("t-fail");
    check(second === 1, "写失败后下一次调用重试并补上了", `实际 ${second}`);
    check((await listMonitors("t-fail")).some((r) => r.nativeId === "bFail"), "那张卡最终出现在面板上");
  }
  await writeFailureRetries();

  // ── ⑧ 并发：面板和 SSE 可能同时触发，两边必须共享同一次工作 ──────────────────
  // 各扫一遍不只是浪费读盘：先到的那次还没写完库，后到的那次会读到一份空的「已有行」名单，
  // 两边都认为该插入（第 3 轮审查列为非拦截项，建议共享 in-flight Promise）。
  async function concurrentFirstRead(): Promise<void> {
    const dir = join(root, "runs", "t-conc");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "sessConc-20261014T100000000Z.agent-out.jsonl");
    writeFileSync(path, [
      { type: "system", subtype: "init", session_id: "cli-conc" },
      { type: "assistant", timestamp: "2026-10-14T10:00:01.000Z", message: { model: "m", content: [
        { type: "tool_use", name: "Monitor", id: "tuC", input: { command: "tail -F /tmp/c", description: "并发", timeout_ms: 600_000 } },
      ] } },
      { type: "system", subtype: "task_started", task_id: "bConc", tool_use_id: "tuC", task_type: "local_bash", session_id: "cli-conc" },
      { type: "system", subtype: "task_notification", task_id: "bConc", status: "completed", summary: "好了", session_id: "cli-conc" },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
    await db.insert(tasks).values({ id: "t-conc", projectId: "p", title: "并发", body: "", status: "done",
      agentType: "claude", mode: "single", createdAt: now(), updatedAt: now() });
    await db.insert(sessions).values({
      id: "sessConc", taskId: "t-conc", role: "single", agentType: "claude", executor: "claude@x",
      cliSessionId: "cli-conc", cwd: root, startedAt: now(), agentOutPath: path,
    });

    const [a, b, c] = await Promise.all([
      backfillClaudeMonitors("t-conc"), backfillClaudeMonitors("t-conc"), backfillClaudeMonitors("t-conc"),
    ]);
    check(a === 1 && b === 1 && c === 1, "三路并发共享同一次工作，都拿到同一个结果", `实际 ${a}/${b}/${c}`);
    const rows = await listMonitors("t-conc");
    check(rows.length === 1, "只落了一行，没有重复插入", `实际 ${rows.length} 行`);
  }
  await concurrentFirstRead();

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
    console.log("✓ 内置 Monitor 历史回填：扫同会话全部文件 / 排除普通后台 Bash / 终态与回执期限"
      + " / 没终态时按来源死活定 running|lost / 会话 id 含 `-`（两种坏法）/ 补存量行归属与纠正推断"
      + " / 跨文件关联 / 真实时间锚点（文件时刻不算锚点）/ 写失败不吞且可重试 / 并发共享 / 幂等 均受回归保护");
  }
}

try {
  await main();
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
