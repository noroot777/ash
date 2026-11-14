// 内置 Monitor 投影的**旧期限纠偏**（db/migrations.ts 的 relaxUnfoundedClaudeMonitorLifetimes）。
//
// 旧版本算法推出来的期限没有来源回执（`lifetime_evidence IS NULL`），但行上照样写着 bounded、
// 起止差着几分钟。紧随其后的那条迁移拿 `expires_at - started_at` 回算时长、不看证据列 —— 少了
// 前面那一步降级，从更旧版本直升上来的库就会在卡片上写「总共盯 5 分钟」，而那 5 分钟从来没有
// 依据（第 1 轮审查 F2 实测）。这份回归钉三件事：
//
//   ① 没有回执的旧期限降回「期限未知」，对外不给时长；
//   ② 带 'receipt' 的行一个字不动，时长照常回算；
//   ③ 迁移每次启动都跑，重跑不改变结论。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-monitor-legacy-lifetime-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
requireTmpDb("monitor-legacy-lifetime");

const [{ db, dbClient, ensureSchema }, { monitors, projects, tasks }, { listMonitors }] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/monitors.js"),
]);
await ensureSchema();

const legacy = (id: string, lifetimeEvidence: "receipt" | null) => ({
  id, taskId: "t", command: "tail -F build.log", description: id, cwd: root, status: "lost",
  pid: null, pidStartedAt: null, logPath: "", offset: 0, events: 0, exitCode: null,
  startedAt: "2026-10-15T00:00:00.000Z", expiresAt: "2026-10-15T00:05:00.000Z",
  endedAt: "2026-10-15T00:06:00.000Z", endedReason: null, ownerUserId: null,
  kind: "claude", nativeId: `b-${id}`, cliSessionId: "cli", sourceLifetime: "bounded",
  lifetimeEvidence, startEvidence: "observed", startAnchorWidthMs: 20, timeoutMs: null,
});

try {
  const at = new Date().toISOString();
  await db.insert(projects).values({ id: "p", name: "p", repoPath: root, createdAt: at });
  await db.insert(tasks).values({ id: "t", projectId: "p", title: "t", body: "", status: "done",
    agentType: "claude", mode: "single", createdAt: at, updatedAt: at });
  await db.insert(monitors).values([legacy("unproved", null), legacy("receipt", "receipt")]);

  for (const pass of [1, 2]) {
    await ensureSchema();                  // 启动迁移：每次启动都跑一遍
    const tag = `（第 ${pass} 次启动）`;
    const row = async (id: string) => (await db.select().from(monitors).where(eq(monitors.id, id))).at(0);
    const unproved = await row("unproved");
    assert.equal(unproved?.sourceLifetime, "unknown", `①没有回执的旧期限降回「期限未知」${tag}`);
    assert.equal(unproved?.timeoutMs, null, `①也不给它回算时长${tag}`);
    const receipt = await row("receipt");
    assert.equal(receipt?.sourceLifetime, "bounded", `②带回执的行不动${tag}`);
    assert.equal(receipt?.timeoutMs, 300_000, `②它的时长照常回算${tag}`);

    const cards = new Map((await listMonitors("t")).map((m) => [m.id, m]));
    assert.equal(cards.get("unproved")?.lifetime, "unknown", `①对外是「期限未知」${tag}`);
    assert.equal(cards.get("unproved")?.timeoutMs, null, `①对外不给时长（卡片不会写「总共盯 5 分钟」）${tag}`);
    assert.equal(cards.get("receipt")?.timeoutMs, 300_000, `②有回执的那张照常说时长${tag}`);
  }
  console.log("✓ 内置 Monitor 旧期限纠偏：没有回执的降回「期限未知」且不回算时长 / 带回执的不动 / 重复启动结论不变 均受回归保护");
} finally {
  dbClient.close();
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
