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
import { eq } from "drizzle-orm";

const { stopMonitorChecked, readMonitorTail } = await import("../src/monitors.js");

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
