// claude 自带 `Monitor` 的只读投影：认得出、列得全、停不掉、不被 ash 的进程管理碰。
//
// 这份回归钉的是**两种哨兵共用一张表之后，边界有没有守住**。投影行的 pid 是 null、
// log_path 是空串，一旦漏过某一道 `kind` 过滤，症状都很安静：
//
// - `reattachMonitors` 把它们当自己的进程去认 → 一重启就整批误判成 lost（它们明明还在
//   agent 那边跑着）；
// - `liveMonitorsOf` 把它们算进每任务 4 个的配额 → agent 挂了 4 个内置 Monitor 之后，
//   ash 这边一个哨兵都起不了，而拒绝理由完全看不懂；
// - `stopMonitor` 假装停掉 → 进程还在跑、还会继续唤醒任务，界面上却写着「已停止」。
//
// 认人那一侧（哪些 local_bash 是 Monitor 起的）用真实录下的 stream 回放验证，见
// test-claude-monitor-parse.ts。
import {
  db, monitors, listMonitors, makeTask, now, reattachMonitors, startMonitor, teardown,
} from "./monitors-fixture.js";
import { and, eq } from "drizzle-orm";

const { stopMonitorChecked, readMonitorTail } = await import("../src/monitors.js");
const { loseOrphanClaudeMonitors } = await import("../src/claude-monitors.js");

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  if (ok) return;
  failures += 1;
  console.error(`✗ ${label}${detail ? ` —— ${detail}` : ""}`);
};

// fixture 的 `uniq` 只在建任务时递增，同一个任务里连着插几行会撞主键。投影行自己记数。
let projected = 0;

/** 手写一行 claude 投影，模拟 ClaudeMonitorTrace 落的库。 */
async function projectClaudeMonitor(taskId: string, nativeId: string, status = "running"): Promise<string> {
  const id = `cm-${++projected}`;
  await db.insert(monitors).values({
    id, taskId, command: `until grep -q DONE /tmp/x; do sleep 5; done`,
    description: `内置 Monitor ${nativeId}`, cwd: "/tmp",
    status, pid: null, pidStartedAt: null, logPath: "", offset: 0, events: 0, exitCode: null,
    startedAt: now(), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    endedAt: null, endedReason: null, ownerUserId: null, kind: "claude", nativeId,
  });
  return id;
}

async function main(): Promise<void> {
  // ── 两种一起列出来 ────────────────────────────────────────────────────────
  const taskId = await makeTask();
  const started = await startMonitor({ taskId, command: "echo ash-side; sleep 30", description: "ash 自己的" });
  check(started.ok, "ash 哨兵起得来", started.ok ? "" : started.error);
  const claudeId = await projectClaudeMonitor(taskId, "b69ym4qzv");

  const listed = await listMonitors(taskId);
  check(listed.length === 2, "两种哨兵都在列表里", `实际 ${listed.length} 条`);
  const shadow = listed.find((m) => m.id === claudeId);
  const native = listed.find((m) => m.kind === "ash");
  check(shadow?.kind === "claude", "投影行的 kind 是 claude");
  check(shadow?.nativeId === "b69ym4qzv", "投影行带着 claude 侧的原生 id");
  check(native?.kind === "ash" && native?.nativeId === null, "ash 那种 kind=ash 且没有原生 id");

  // ── 停不掉，而且要说明白为什么 ────────────────────────────────────────────
  const refused = await stopMonitorChecked(claudeId);
  check(!refused.ok, "投影行拒绝停止");
  if (!refused.ok) {
    check(refused.status === 409, "拒绝用 409 而不是 404", `实际 ${refused.status}`);
    check(/只能看不能停|进程树/.test(refused.error), "拒绝理由说清了它为什么停不掉", refused.error);
  }
  const afterRefuse = (await db.select().from(monitors).where(eq(monitors.id, claudeId))).at(0);
  check(afterRefuse?.status === "running", "被拒之后状态一个字没动", `实际 ${afterRefuse?.status}`);

  // ash 自己那种照常停得掉——别为了挡住投影把正常路也挡了。
  if (started.ok) {
    const stopped = await stopMonitorChecked(started.monitor.id);
    check(stopped.ok, "ash 哨兵照常停得掉", stopped.ok ? "" : stopped.error);
  }

  // ── 没有日志文件：返回空，不去读那个空路径 ────────────────────────────────
  const tail = await readMonitorTail(claudeId);
  check(tail !== null && tail.lines.length === 0 && !tail.truncated, "投影行的日志尾巴是空的，且不报错");

  // ── 重启接管绕开投影行 ────────────────────────────────────────────────────
  // 投影是 running、pid 为 null。漏过 kind 过滤的话它会被当成「进程没了」判 lost。
  const recovered = await reattachMonitors();
  const afterReattach = (await db.select().from(monitors).where(eq(monitors.id, claudeId))).at(0);
  check(afterReattach?.status === "running", "重启接管不碰投影行", `实际 ${afterReattach?.status}（lost 说明漏了 kind 过滤）`);
  check(recovered.lost === 0, "投影行没有被算进 lost 统计", `lost=${recovered.lost}`);

  // ── 投影不占 ash 的创建配额 ───────────────────────────────────────────────
  const quotaTask = await makeTask();
  for (let i = 0; i < 4; i += 1) await projectClaudeMonitor(quotaTask, `native-${i}`);
  const underQuota = await startMonitor({ taskId: quotaTask, command: "sleep 30", description: "配额不该被投影占掉" });
  check(underQuota.ok, "4 个投影之后 ash 照样起得了哨兵", underQuota.ok ? "" : underQuota.error);
  if (underQuota.ok) await stopMonitorChecked(underQuota.monitor.id);

  // ── 开机收拾上一轮留下的投影 ──────────────────────────────────────────────
  // 这些行没有 pid，reattach 按 kind 整批跳过了它们；没人收的话重启一次就永久留下
  // 一张「正在盯着」的僵尸卡（真机实测到的就是这个）。
  const orphanTask = await makeTask();
  const orphan = await projectClaudeMonitor(orphanTask, "borphaned");
  const liveAsh = await startMonitor({ taskId: orphanTask, command: "sleep 30", description: "ash 的不该被它碰" });
  // 它是**全库**扫描（开机那一刻的语义就是「把所有没人认领的都收了」），所以先数一下
  // 此刻到底有几个待收，再跟返回值对账——钉死绝对数的话，以后往这份测试里加一个用例
  // 就会无故变红。
  const due = (await db.select().from(monitors).where(and(eq(monitors.kind, "claude"), eq(monitors.status, "running")))).length;
  const swept = await loseOrphanClaudeMonitors();
  check(swept === due && due > 0, "把所有还挂着 running 的投影都收了，一个不漏", `待收 ${due} 个，实收 ${swept} 个`);
  check((await db.select().from(monitors).where(and(eq(monitors.kind, "claude"), eq(monitors.status, "running")))).length === 0,
    "收完之后没有投影还挂在 running 上");
  const sweptRow = (await db.select().from(monitors).where(eq(monitors.id, orphan))).at(0);
  check(sweptRow?.status === "lost", "遗留投影落 lost，不再冒充还在盯", String(sweptRow?.status));
  check(/接不回来|重启/.test(sweptRow?.endedReason ?? ""), "结束原因说明了它为什么失联", sweptRow?.endedReason ?? "");
  if (liveAsh.ok) {
    const ashRow = (await db.select().from(monitors).where(eq(monitors.id, liveAsh.monitor.id))).at(0);
    check(ashRow?.status === "running", "ash 自己的哨兵不受这轮收拾影响", String(ashRow?.status));
    await stopMonitorChecked(liveAsh.monitor.id);
  }

  if (failures) {
    console.error(`\n${failures} 条断言未通过`);
    process.exitCode = 1;
  } else {
    console.log("✓ claude 内置 Monitor 投影：两种并列 / 停不掉且说明原因 / 无日志 / 不被重启接管误判 / 不占创建配额 均受回归保护");
  }
}

try {
  await main();
} finally {
  await teardown();
}
