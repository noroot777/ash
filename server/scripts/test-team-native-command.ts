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

  unsubscribe();
  console.log("test:team-native ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
