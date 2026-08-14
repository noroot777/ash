// 调度台离线时收到 `/compact`:必须原样告诉用户「没送出去」,而不是把它拼进唤醒语
// 发给模型。
//
// 为什么这条会回归:普通任务那条线已经认得原生命令了(skills.ts),团队任务却在
// continueTask 顶部就分流去了 deliverToLead,走的是另一套投递。调度台**在线**时
// push() 原样发出去,一切正常;它一旦被空闲回收/重启/还没开过台,openLead() 就会在
// 前面拼上 LEAD_RESUMED 或整段前言 —— claude 的原生命令要求自己是消息的第一个字,
// 前面多一个字就退化成一次普通模型请求。同一个菜单命令因此会随「它在不在线」随机
// 成功或失败,而失败那次没有任何提示。
//
// 跑法:
//   HARNESS_DB=/tmp/test-team-native-$RANDOM.db npx tsx server/scripts/test-team-native-command.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "@harness/shared";

const root = mkdtempSync(join(tmpdir(), "harness-team-native-"));
process.env.HARNESS_DB = join(root, "harness.db");
process.env.HARNESS_RUNS_DIR = join(root, "runs");

try {
  const { bus } = await import("../src/bus.js");
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks } = await import("../src/db/schema.js");
  const { deliverToLead, teamIsLive } = await import("../src/team/session.js");
  const { eq } = await import("drizzle-orm");
  await ensureSchema();

  const at = "2026-08-12T00:00:00.000Z";
  await db.insert(projects).values({ id: "project", name: "team-native", repoPath: root, createdAt: at });
  await db.insert(tasks).values({
    id: "team-offline",
    projectId: "project",
    title: "调度台",
    body: "带一队人干活",
    mode: "team",
    status: "idle",
    team: JSON.stringify({ lead: "claude", worker: "claude" }),
    labels: "[]",
    dependsOn: "[]",
    resumeDependsOn: "[]",
    agentType: "claude",
    autoTitle: false,
    createdAt: at,
    updatedAt: at,
  });

  const events: ServerEvent[] = [];
  const unsubscribe = bus.subscribe((event) => events.push(event));

  // 调度台此刻不在线(从没开过台)。这条消息**不该**把它拉起来。
  await deliverToLead("team-offline", "/compact");
  assert.equal(teamIsLive("team-offline"), false, "原生命令不该顺带把调度台开起来");

  const note = events.find(
    (event) => event.type === "agent.event" && event.taskId === "team-offline" && event.event.kind === "error",
  );
  assert.ok(note, "没送出去这件事必须有反馈,不能静默吞掉");
  assert.match(
    note.event.kind === "error" ? note.event.message : "",
    /\/compact/,
    "反馈里要点明是哪条命令没送出去",
  );

  const row = (await db.select().from(tasks).where(eq(tasks.id, "team-offline"))).at(0)!;
  assert.equal(row.status, "idle", "只是没送出去,任务状态不该被动过");

  // 「没送出去」必须一路传回调用方。以前这里返回 void,上层照样 onDelivered() 把排队
  // /定时的那条标成 sent —— 托盘里没了、会话里也没有,用户的话凭空蒸发。
  assert.equal(await deliverToLead("team-offline", "/compact"), false, "明确拒收要返回 false");
  await assert.rejects(
    () => deliverToLead("team-offline", "/compact", { throwOnOpenFailure: true }),
    /compact/,
    "定时/排队消息要能拿到「送不出去」这个失败,才好落成 canceled",
  );

  const { continueTask } = await import("../src/orchestrator.js");
  let delivered = 0;
  const passed = await continueTask("team-offline", "/compact", { onDelivered: async () => { delivered++; } });
  assert.equal(passed, false, "上层同样要返回 false(跟抢不到单飞锁一个口径)");
  assert.equal(delivered, 0, "一个字都没送出去时,绝不能记账成已送达");

  // 普通消息不受影响:它会把调度台开起来(这里没有真 CLI,能开到哪一步不重要 ——
  // 要钉的是「拒收只针对原生命令」,别把整条投递路径一起判死)。
  assert.equal(teamIsLive("team-offline"), false, "前面这些都不该顺手开台");

  // ── HTTP 那一层:拒收要当场答成失败,且**不留下任何排队消息** ──────────────────
  // /reply 有一条兜底:continueTask 返回 false 就把这句话落成 pending,等任务空下来再
  // 发。原生命令不适用 —— 它必须是消息的第一个字,而调度台离线后接回来一定带唤醒前言。
  // 排进队里只会有两个结果:被 scheduler 标成 canceled(用户先收到「已发送」再被打脸),
  // 或者用户按提示先发一句普通消息把台接回来、这条 pending 随即被暗中送出并标 sent ——
  // 跟系统刚写下的「没有送出,请接回后再单独发」正面矛盾(第 2 轮审查 finding 5)。
  const { api } = await import("../src/routes.js");
  const reply = async (text: string) =>
    api.request(`/tasks/team-offline/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });

  const rejected = await reply("/compact");
  assert.equal(rejected.status, 409, "调度台接不住时要当场答成失败,不能先答 202 再暗中排队");
  assert.match(
    ((await rejected.json()) as { error?: string }).error ?? "",
    /compact/,
    "错误里要点明是哪条命令没送出去(前端原样显示在输入框下面)",
  );

  const pendingAfter = await (await api.request("/tasks/team-offline/scheduled-messages")).json();
  assert.deepEqual(pendingAfter, [], "拒收的原生命令绝不能留在托盘里等着被暗中补发");

  unsubscribe();
  console.log("test:team-native ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
