// **恢复责任本身要确认落地** + **起点证据要能重验**：第 7 轮审查复现出来的那几条。
//
// 这一轮的共同形状是**「我这一步做完了」被当成「这一轮全做完了」**：
//
// · 扫描读完了 ⇒ 销账（而死活裁决还没跑，它失败了也只 warn）；
// · 恢复账本记下了 ⇒ 以为前端会知道（而状态变化根本不发事件，前端只订阅行变化）；
// · 两个请求都返回了 ⇒ 以为是一份完成快照（而它们来自两个不同时刻）；
// · 自动重试排上了 ⇒ 以为退避在走（而公共入口每次都把预算还原，永远停在第一档）；
// · 起点标着 observed ⇒ 以为它准（而那是个无法重验的结论字符串，旧行里就有偏 2.2 秒的）。
//
// 所以这份测试盯的是**「完成」的定义**和**「证据」的可重验性**。
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-mon-complete-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
requireTmpDb("monitor-completeness");

const [
  { db, ensureSchema, dbClient }, schema, { ClaudeMonitorTrace }, { backfillClaudeMonitors },
  recovery, { listMonitors }, { bus }, shared,
] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/claude-monitors.js"),
  import("../src/claude-monitor-backfill.js"),
  import("../src/claude-monitor-recovery.js"),
  import("../src/monitors.js"),
  import("../src/bus.js"),
  import("@ash/shared/monitor"),
]);
const { monitorRecoveryOf, stopAllMonitorRecovery } = recovery;
const { monitorExactExpiry, monitorStartTrusted } = shared;
const { monitors, projects, sessions, tasks } = schema;
await ensureSchema();

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  if (ok) return;
  failures += 1;
  console.error(`✗ ${label}${detail ? ` —— ${detail}` : ""}`);
};
const now = () => new Date().toISOString();
const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

let seq = 0;
async function fixture(name: string, pid: number | null = null) {
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
    agentPid: pid, agentStartedAt: null,
  });
  return { taskId, cli, file: join(dir, `s-${taskId}-20261015T010000000Z.agent-out.jsonl`) };
}

const write = (path: string, events: unknown[]) =>
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

/** 一段合法的「起了一个 Monitor」事件序列。 */
const startSeq = (cli: string, nativeId: string, receipt?: string, gapMs = 1_000) => [
  { type: "system", subtype: "init", session_id: cli },
  { type: "assistant", timestamp: "2026-10-15T01:00:05.000Z", message: { model: "m", content: [
    { type: "tool_use", name: "Monitor", id: `tu-${nativeId}`, input: { command: "tail -F /tmp/x", description: `盯 ${nativeId}`, timeout_ms: 600_000 } },
  ] } },
  { type: "system", subtype: "task_started", task_id: nativeId, tool_use_id: `tu-${nativeId}`, task_type: "local_bash", session_id: cli },
  ...(receipt ? [{
    type: "user",
    timestamp: new Date(Date.parse("2026-10-15T01:00:05.000Z") + gapMs).toISOString(),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tu-${nativeId}`, content: receipt }] },
  }] : []),
];

const legacyRow = (over: Record<string, unknown>) => ({
  id: `row-${seq++}`, taskId: "", command: "sleep 1800", description: "存量行", cwd: "",
  status: "running", pid: null, pidStartedAt: null, logPath: "", offset: 0, events: 0, exitCode: null,
  startedAt: now(), expiresAt: now(), endedAt: null, endedReason: null, ownerUserId: null,
  kind: "claude", nativeId: null, cliSessionId: null, sourceLifetime: "unknown",
  lifetimeEvidence: null, startEvidence: null, timeoutMs: null, sourcePid: null,
  sourcePidStartedAt: null, startAnchorWidthMs: null,
  ...over,
});

async function main(): Promise<void> {
  await db.insert(projects).values({ id: "p", name: "p", repoPath: root, createdAt: now() });

  // ── ① 旧 observed 起点：无法重验 ⇒ 只给时长；而且不再挡住历史锚点把它改对 ──────
  //
  // 第 6 轮之前的实时投影在写库队列积压之后才取时刻，照样标 `observed`（实测偏 2205ms）。
  // 第 6 轮把取点提前了，但库里已有的旧行还是同一个字符串，于是「修好了新写入、修不到旧
  // 数据」。证据改成「档位 + 误差界」之后两类自动分开。
  {
    const f = await fixture("legacy-observed");
    // 形状和数值直接取第 6 轮真实注入的那一行（round-6/production-proof.json liveQueueDelay）。
    const trueStart = "2026-10-14T14:52:01.859Z";
    const wrongStart = "2026-10-14T14:52:04.064Z"; // 晚 2205ms
    await db.insert(monitors).values(legacyRow({
      id: "row-legacy-observed", taskId: f.taskId, nativeId: "legacyobs", cliSessionId: f.cli,
      description: "旧实时投影写的起点", sourceLifetime: "bounded", lifetimeEvidence: "receipt",
      startEvidence: "observed", startAnchorWidthMs: null, timeoutMs: 90_000,
      startedAt: wrongStart, expiresAt: new Date(Date.parse(wrongStart) + 90_000).toISOString(),
    }) as never);

    const dto = (await listMonitors(f.taskId)).find((m) => m.nativeId === "legacyobs");
    check(dto?.expiresAt === null,
      "①旧 observed 没有误差界 → 无法重验 → 对外不给精确到期时刻", String(dto?.expiresAt));
    check(dto?.timeoutMs === 90_000, "①时长仍然给（那一半是回执证明过的）", String(dto?.timeoutMs));
    check(Math.abs(Date.parse(wrongStart) - Date.parse(trueStart)) === 2_205,
      "①（口径）旧行的起点就是偏这 2205ms");

    // 历史里有一个**窄区间**锚点：它应该能把这个旧起点改对。旧判据只看字符串，于是
    // `observed` 永远优先、永远改不了（第 7 轮审查指出的就是这一条）。
    write(f.file, startSeq(f.cli, "legacyobs",
      "Monitor started (task legacyobs, expires in 1m 30s unless the source ends first).", 40));
    await backfillClaudeMonitors(f.taskId);
    const fixed = (await db.select().from(monitors).where(eq(monitors.id, "row-legacy-observed"))).at(0);
    check(fixed?.startEvidence === "receipt-window",
      "①窄区间的历史锚点把那个不可重验的起点换掉了", String(fixed?.startEvidence));
    check(fixed?.startAnchorWidthMs === 40, "①并且记下了它的误差界", String(fixed?.startAnchorWidthMs));
    const after = (await listMonitors(f.taskId)).find((m) => m.nativeId === "legacyobs");
    check(after?.expiresAt !== null, "①有可重验的证据之后又能给精确到期时刻了", String(after?.expiresAt));

    // 口径自检：同一行，只把误差界拿掉就不可信。
    check(monitorStartTrusted({ startEvidence: "observed", startAnchorWidthMs: null, timeoutMs: 90_000 }) === false
      && monitorStartTrusted({ startEvidence: "observed", startAnchorWidthMs: 40, timeoutMs: 90_000 }) === true
      && monitorStartTrusted({ startEvidence: "observed", startAnchorWidthMs: 2_205, timeoutMs: 90_000 }) === false,
      "①判据就是「档位 + 误差界 ≤ 容差」，三种输入分别为 false/true/false");
    check(monitorExactExpiry({
      sourceLifetime: "bounded", startEvidence: "observed", startAnchorWidthMs: null,
      startedAt: wrongStart, timeoutMs: 90_000,
    }) === null, "①现算那一步同样拒绝没有误差界的起点");
  }

  // ── ② 死活裁决失败：扫描读完了 ≠ 这一轮做完了 ─────────────────────────────────
  //
  // 上一版 clear 排在 reconcileLiveness 之前，而后者抛错只 warn。于是注入一次死活 UPDATE
  // 失败之后：行停在 running、账本是空的、一条事件都没发，要等人再调一次回填才变 lost。
  {
    const f = await fixture("liveness-failed", null); // 会话没有活进程 → 该判 lost
    await db.insert(monitors).values(legacyRow({
      id: "row-live1", taskId: f.taskId, nativeId: "live1", cliSessionId: f.cli,
      description: "来源已经没了", status: "running", sourcePid: 0, // 0 = 那一代确认已结束
    }) as never);
    write(f.file, startSeq(f.cli, "live1")); // 有内容，扫描本身干净

    const realExecute = dbClient.execute.bind(dbClient);
    let hit = 0;
    (dbClient as any).execute = async (stmt: any) => {
      const sql = typeof stmt === "string" ? stmt : String(stmt?.sql ?? "");
      // 只拦死活裁决那一发（SET status='lost' …）。
      if (hit === 0 && /update\s+"?monitors"?/i.test(sql) && /'lost'|\?/.test(sql)
        && /ended_reason/i.test(sql) && /in\s*\(/i.test(sql)) {
        hit += 1;
        throw new Error("INJECTED_SQLITE_BUSY");
      }
      return realExecute(stmt);
    };
    try {
      await backfillClaudeMonitors(f.taskId);
    } finally {
      (dbClient as any).execute = realExecute;
    }
    check(hit === 1, "②注入真的命中了死活裁决那一发 UPDATE", String(hit));
    const pending = monitorRecoveryOf(f.taskId);
    check(pending?.reasons.includes("liveness-failed") === true,
      "②死活裁决失败留了账（不是只 warn 一句就当这一轮做完了）", JSON.stringify(pending));

    // 不碰它：自动推进应该把它推完。
    for (let i = 0; i < 40 && monitorRecoveryOf(f.taskId); i += 1) await settle(100);
    check(monitorRecoveryOf(f.taskId) === null, "②自动续推之后账销了", JSON.stringify(monitorRecoveryOf(f.taskId)));
    const row = (await db.select().from(monitors).where(eq(monitors.id, "row-live1"))).at(0);
    check(row?.status === "lost", "②而且那条纠正最终落地了（没人再手动调一次）", String(row?.status));
  }

  // ── ③ 恢复状态变化要发事件：不然前端永远不知道 ───────────────────────────────
  //
  // 「文件一直读不开」不产生任何行变化，而前端只订阅 `task.monitors`。少了这条推送，第一次
  // 打开时拿到的 `pending:false` 会永远留在页面上，面板一直写「这个任务上还没有哨兵」。
  {
    const f = await fixture("notify-change");
    write(f.file, startSeq(f.cli, "notify1"));
    chmodSync(f.file, 0o000); // 读不开 → scan.failed

    const seen: string[] = [];
    const off = bus.subscribe((ev: any) => {
      if (ev.type === "task.monitors" && ev.taskId === f.taskId) seen.push("note");
    });
    try {
      await backfillClaudeMonitors(f.taskId);
      await settle(50);
      check(seen.length > 0, "③留账时发了 task.monitors（前端据此重读）", `${seen.length} 条`);
      const before = seen.length;
      // 同一个原因重复记账**不该**再推一次：每秒重试一次不能把前端也拖着每秒重读。
      await backfillClaudeMonitors(f.taskId);
      await settle(50);
      check(seen.length === before, "③原因没变时不重复推送", `${before} → ${seen.length}`);
      // 读得开了 → 销账也要推一次，否则页面上那句「还没读完」撤不掉。
      chmodSync(f.file, 0o644);
      await backfillClaudeMonitors(f.taskId);
      await settle(50);
      check(monitorRecoveryOf(f.taskId) === null, "③修好后账销了");
      check(seen.length > before, "③销账也发了事件（反方向同样要能撤）", `${before} → ${seen.length}`);
    } finally {
      off();
      chmodSync(f.file, 0o644);
    }
  }

  // ── ④ 两条端点必须反映同一轮扫描 ─────────────────────────────────────────────
  //
  // 前端并行发「列表」和「恢复状态」两个请求。恢复那条原来是纯内存读，可以在扫描记账之前
  // 就返回 `pending:false`，而列表随后返回 `[]`——两份不同时刻的快照被当成一份完成结果，
  // 页面于是写着「这个任务上还没有哨兵」（第 7 轮审查用真实页面复现）。
  {
    const f = await fixture("same-round");
    write(f.file, startSeq(f.cli, "round1"));
    chmodSync(f.file, 0o000);
    try {
      // 和前端一样并行发起，而且**恢复那条先发**（最坏顺序）。
      const [pending, rows] = await Promise.all([
        (async () => {
          await backfillClaudeMonitors(f.taskId); // 路由里就是这一句（见 monitor-routes.ts）
          return monitorRecoveryOf(f.taskId);
        })(),
        (async () => {
          await backfillClaudeMonitors(f.taskId);
          return listMonitors(f.taskId);
        })(),
      ]);
      check(rows.length === 0, "④这一轮列表确实是空的（文件读不开）", `${rows.length} 条`);
      check(pending?.pending === true,
        "④同一时刻的恢复状态是 pending —— 两份快照对得上，页面不会说「没有哨兵」",
        JSON.stringify(pending));
    } finally {
      chmodSync(f.file, 0o644);
    }
  }

  // ── ⑤ 持续失败时退避真的在走（不是每次都回到第一档）──────────────────────────
  //
  // 自动推进调的是公共入口，而公共入口把退避预算当「外部真实请求」还原了。实测 4 次自动
  // 重试间隔全是 ~1003ms、attempts 恒为 1、永远到不了 exhausted。
  {
    const f = await fixture("budget");
    write(f.file, startSeq(f.cli, "budget1"));
    chmodSync(f.file, 0o000);
    try {
      await backfillClaudeMonitors(f.taskId);
      const first = monitorRecoveryOf(f.taskId);
      check(first?.attempts === 1, "⑤第一次失败排在第一档", JSON.stringify(first));
      // 等自动推进跑几轮（1s + 2s + 5s 已经超过 7 秒，取 4 秒看前两档就够）。
      await settle(4_000);
      const later = monitorRecoveryOf(f.taskId);
      check((later?.attempts ?? 0) >= 3,
        "⑤自动推进不还原预算 → attempts 在涨（退避真的在走）", JSON.stringify(later));
      // **外部真实请求也不该在退避进行中把预算还原**——那是不拦项 1 的同一个陷阱换个入口：
      // 用户每点开一次面板就把阶梯清零，退避照样永远走不到后面。还原只发生在「退避已经停下
      // 来」（预算用完）之后，让下一次真实请求能把它重新推起来。
      const before = later?.attempts ?? 0;
      await backfillClaudeMonitors(f.taskId);
      const after = monitorRecoveryOf(f.taskId);
      check((after?.attempts ?? 0) >= before,
        "⑤退避进行中，外部请求不把阶梯清零", `${before} → ${after?.attempts}`);
      // 「用完预算之后由下一次真实请求重新推起来」那一支要走完整个阶梯（1+2+5+15+30+60+
      // 120+300 秒 ≈ 9 分钟），这里不等它；那一支的判据是 `arm` 里的
      // `attempts >= BACKOFF_MS.length` 与 `resetMonitorRecoveryBudget` 的 `entry.timer` 守卫，
      // 读代码可判，没有快速的自然复现。本条只钉住「进行中不被清零」这个可复现的部分。
    } finally {
      chmodSync(f.file, 0o644);
    }
  }

  // ── ⑥ 正在恢复中的游标不许被当普通缓存挤掉 ──────────────────────────────────
  //
  // 快照里记着「这个文件读到第几字节」。被挤掉之后下一轮从零开始，而单次只读 128 MiB，于是
  // 「超过上限、Monitor 在末尾」那种任务会反复重读同一段前缀、永远到不了末尾。
  {
    const stuck = await fixture("cursor-kept");
    write(stuck.file, startSeq(stuck.cli, "stuck1"));
    chmodSync(stuck.file, 0o000);
    try {
      await backfillClaudeMonitors(stuck.taskId);
      check(monitorRecoveryOf(stuck.taskId)?.pending === true, "⑥这个任务进了恢复中");
      // 再过 40 个别的任务（上限 32）：旧实现会把它的游标一起挤掉。
      for (let i = 0; i < 40; i += 1) {
        const other = await fixture(`filler${i}`);
        write(other.file, startSeq(other.cli, `fill${i}`));
        await backfillClaudeMonitors(other.taskId);
      }
      const { monitorScanTracked } = await import("../src/claude-monitor-backfill.js");
      check(monitorScanTracked(stuck.taskId) === true,
        "⑥恢复中的任务的扫描游标还在（没被 40 个别的任务挤掉）");
    } finally {
      chmodSync(stuck.file, 0o644);
    }
  }

  // ── ⑦ 孤儿事实溢出不许静默丢弃 ──────────────────────────────────────────────
  //
  // 缓冲里装的是一次性事实（来源不会重发），游标已经越过它了。超界就把快照丢掉、留账、
  // 重读那一段；「淘汰不会造成错误显示」这句注释不能当成来源契约。
  {
    const f = await fixture("orphan-overflow");
    // 600 条「还配不上任何 Monitor」的终态通知（普通后台 Bash 的通知就长这样），超过 512。
    const noise: unknown[] = [{ type: "system", subtype: "init", session_id: f.cli }];
    for (let i = 0; i < 600; i += 1) {
      noise.push({ type: "system", subtype: "task_notification", task_id: `bnoise${i}`,
        status: "completed", summary: "普通后台 Bash", session_id: f.cli });
    }
    write(f.file, noise);
    await backfillClaudeMonitors(f.taskId);
    const pending = monitorRecoveryOf(f.taskId);
    check(pending?.reasons.includes("orphan-overflow") === true,
      "⑦挤掉一次性事实时留了账，不是静默丢弃", JSON.stringify(pending));
  }

  if (failures === 0) {
    console.log("✓ 内置 Monitor 的「完成」定义与证据可重验：旧 observed 降级且可被窄锚点纠正 / "
      + "死活裁决失败留账并自动补上 / 恢复状态变化双向推送且不刷屏 / 两条端点同一轮 / "
      + "持续失败时退避真的在走 / 恢复中的游标不被挤掉 / 孤儿溢出不静默丢弃 均受回归保护");
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
