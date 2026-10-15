// **空归属不是通配符**（第 14 轮审查 N2）。
//
// `monitors.cli_session_id` 是后加的列，升级前写进去的行上一律为空。四个认行的地方都曾把
// 这种行当成「跟谁都相等」的兜底证据，于是 null 的含义从「不知道是谁的」变成了「就是你」。
// 后果不是显示得丑，是**毁掉另一条会话的恢复依据**：审查实测里，一条无归属的旧投影把另一条
// 会话里还悬着的同号调用销了账 —— 那条调用的入参只存在于那一行，卡再也出不来。
//
// 这份测试盯两件事：
// ① 销账要有同来源的证据，证明不了就留着未决责任（`loadPendingCalls`）；
// ② 认行同理：说不清是谁的那一行不许被另一条会话认走（`matchBySource`，实时与历史共用）。
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-mon-identity-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
requireTmpDb("monitor-identity");

const [
  { db, ensureSchema }, schema, { loadPendingCalls }, { matchBySource }, { listMonitors },
] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/claude-monitor-pending.js"),
  import("../src/claude-monitor-identity.js"),
  import("../src/monitors.js"),
]);
const { monitorPendingCalls, monitors, projects, sessions, tasks } = schema;
await ensureSchema();

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  if (ok) return;
  failures += 1;
  console.error(`✗ ${label}${detail ? ` —— ${detail}` : ""}`);
};
const now = () => new Date().toISOString();

async function main(): Promise<void> {
  await db.insert(projects).values({ id: "p", name: "p", repoPath: root, createdAt: now() });
  mkdirSync(join(root, "runs"), { recursive: true });

  // ── ① 销账：无归属的旧投影不许把别人的未决调用带走 ─────────────────────────────
  {
    const taskId = "t-settle";
    await db.insert(tasks).values({ id: taskId, projectId: "p", title: "t", body: "", status: "running",
      agentType: "claude", mode: "single", createdAt: now(), updatedAt: now() });
    await db.insert(sessions).values({
      id: "s-b", taskId, role: "single", agentType: "claude", executor: "claude@x",
      cliSessionId: "cli-b", cwd: root, startedAt: now(),
      agentOutPath: join(root, "runs", "s-b-20261015T010000000Z.agent-out.jsonl"),
    });
    // 新会话里还悬着的调用（入参只存在于这一行）。
    await db.insert(monitorPendingCalls).values({
      taskId, sessionKey: "s-b", toolUseId: "tu-same", command: "tail -f b.log",
      description: "乙的调用", at: now(), sourceRun: null,
    });
    // 升级前写进去的旧投影：同号 tool_use，**没有归属**。
    await db.insert(monitors).values({
      id: "m-legacy", taskId, command: "tail -f a.log", description: "甲的旧投影", cwd: root,
      status: "running", pid: null, pidStartedAt: null, logPath: "", offset: 0, events: 0,
      exitCode: null, startedAt: now(), expiresAt: now(), endedAt: null, endedReason: null,
      ownerUserId: null, kind: "claude", nativeId: "bsame", cliSessionId: null,
      toolUseId: "tu-same", sourceLifetime: "unknown",
    });

    const loaded = await loadPendingCalls(taskId);
    check(loaded.get("s-b")?.length === 1,
      "①证明不了同来源 ⇒ 未决调用留着（恢复依据没被毁）",
      `${loaded.get("s-b")?.length ?? 0} 条`);
    const left = await db.select().from(monitorPendingCalls)
      .where(and(eq(monitorPendingCalls.taskId, taskId), eq(monitorPendingCalls.sessionKey, "s-b")));
    check(left.length === 1, "①库里那一行也还在（不是「读得出来但已经删了」）", `${left.length} 行`);
  }

  // ── ①(b) 对照：同来源的证据照常销账（自愈那条路不许被这次收紧弄没了）───────────
  {
    const taskId = "t-settle-same";
    await db.insert(tasks).values({ id: taskId, projectId: "p", title: "t", body: "", status: "running",
      agentType: "claude", mode: "single", createdAt: now(), updatedAt: now() });
    await db.insert(sessions).values({
      id: "s-c", taskId, role: "single", agentType: "claude", executor: "claude@x",
      cliSessionId: "cli-c", cwd: root, startedAt: now(),
      agentOutPath: join(root, "runs", "s-c-20261015T010000000Z.agent-out.jsonl"),
    });
    await db.insert(monitorPendingCalls).values({
      taskId, sessionKey: "s-c", toolUseId: "tu-done", command: "tail -f c.log",
      description: "已经成行的调用", at: now(), sourceRun: null,
    });
    await db.insert(monitors).values({
      id: "m-same", taskId, command: "tail -f c.log", description: "它自己的投影", cwd: root,
      status: "running", pid: null, pidStartedAt: null, logPath: "", offset: 0, events: 0,
      exitCode: null, startedAt: now(), expiresAt: now(), endedAt: null, endedReason: null,
      ownerUserId: null, kind: "claude", nativeId: "bdone", cliSessionId: "cli-c",
      toolUseId: "tu-done", sourceLifetime: "unknown",
    });
    const loaded = await loadPendingCalls(taskId);
    check(!loaded.get("s-c")?.length, "①(b) 同来源的证据照常销账", `${loaded.get("s-c")?.length ?? 0} 条`);
    const left = await db.select().from(monitorPendingCalls)
      .where(eq(monitorPendingCalls.taskId, taskId));
    check(left.length === 0, "①(b) 而且是就地清掉，不会越积越多", `${left.length} 行`);
  }

  // ── ② 认行：唯一候选才认，说不清是谁的不认 ──────────────────────────────────
  //
  // 四个认行的地方（实时 locate、open 的重复判定、历史 pick、销账）现在共用这一个判据，
  // 所以这里直接打在判据本身上。
  {
    const legacy = { id: "m-legacy", cliSessionId: null };
    const mine = { id: "m-mine", cliSessionId: "cli-b" };
    const other = { id: "m-other", cliSessionId: "cli-a" };
    check(matchBySource([mine, legacy], "cli-b")?.id === "m-mine", "②同来源优先");
    check(matchBySource([legacy], "cli-b")?.id === "m-legacy",
      "②唯一候选且它没有归属 ⇒ 认（存量行的升级路径）");
    check(matchBySource([legacy, other], "cli-b") === undefined,
      "②还有别的候选时，那条空归属的行说不清是谁的 ⇒ 不认",
      JSON.stringify(matchBySource([legacy, other], "cli-b")));
    check(matchBySource([other], "cli-b") === undefined, "②别人的行一律不认");
    check(matchBySource([legacy], null)?.id === "m-legacy", "②两边都不知道时按「都不知道」对上");
    check(matchBySource([], "cli-b") === undefined, "②没有候选就是没有");
  }

  // 收尾：库里那两条任务的卡各是各的（没被上面的判据串掉）。
  check((await listMonitors("t-settle")).length === 1, "③甲的旧投影自己那张卡还在");

  if (failures === 0) {
    console.log("✓ 内置 Monitor 的归属判据：空归属不当通配符（销账要同来源证据、认行要唯一候选）"
      + " / 同来源照常销账 / 存量行的升级路径仍在 均受回归保护");
  }
  process.exit(failures ? 1 : 0);
}

try {
  await main();
} finally {
  releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
