// resume_prompt 变了必须能到客户端。
//
// 这一列是前端的门禁：非空 = 「任务在等续跑」，自由工作流工具条据此把派审 / 预约 / 修复 /
// 打开预览整排按钮禁掉。SSE 里没有一种局部事件带得动它（task.status / task.question /
// task.stage / task.title 都不带），任务列表也只在首次加载和断线重连时整表拉一次，所以改了
// 不广播整行，长开的页面就永久停在旧值 —— 接力移回实测：导入写下「接力前言」并广播了，
// 0.13 秒后自动续跑把它取走却没广播，按钮一直灰到用户手动刷新。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "@ash/shared";
import { eq } from "drizzle-orm";

const root = mkdtempSync(join(tmpdir(), "ash-resume-prompt-broadcast-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

try {
  const { bus } = await import("../src/bus.js");
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks } = await import("../src/db/schema.js");
  const { announceResumePrompt, restoreResumePrompt, takeResumePrompt } =
    await import("../src/task-resume-prompt.js");
  await ensureSchema();

  const at = "2026-08-01T00:00:00.000Z";
  await db.insert(projects).values({ id: "project", name: "test", repoPath: root, createdAt: at });
  await db.insert(tasks).values({
    id: "task",
    projectId: "project",
    title: "task",
    body: "",
    mode: "single",
    status: "running",
    workflowMode: "free",
    labels: "[]",
    dependsOn: "[]",
    resumeDependsOn: "[]",
    resumePrompt: "【任务接力】从另一台机器接力过来，先核对工作目录再继续。",
    createdAt: at,
    updatedAt: at,
  });

  const events: ServerEvent[] = [];
  const unsubscribe = bus.subscribe((event) => events.push(event));
  const updates = () => events.filter((e): e is Extract<ServerEvent, { type: "task.updated" }> =>
    e.type === "task.updated" && e.task.id === "task");

  // ① 取走检查点 → 整行广播，且广播出去的那份 resumePrompt 已经是空的。
  const taken = await takeResumePrompt("task", "【任务接力】从另一台机器接力过来，先核对工作目录再继续。");
  assert.equal(taken, true, "CAS 应该取走这段续跑指令");
  assert.equal(updates().length, 1, "清空 resume_prompt 必须广播整行，否则前端的派审/预约入口一直灰着");
  assert.equal(updates()[0]!.task.resumePrompt, null, "广播出去的那一行必须已经是清空后的状态");

  // ② CAS 没抢到（别人先取走了）→ 不广播，也不改库。
  events.length = 0;
  assert.equal(await takeResumePrompt("task", "别人那一段"), false, "指令已被取走时 CAS 应该失败");
  assert.equal(updates().length, 0, "什么都没改就不该广播");

  // ③ 回填（回合被抢，指令一个字都没送出去）→ 同样要广播，否则按钮该灰不灰、点下去吃 409。
  events.length = 0;
  assert.equal(await restoreResumePrompt("task", "回填的检查点"), true, "空位应该允许回填");
  assert.equal(updates().length, 1, "写回 resume_prompt 必须广播整行");
  assert.equal(updates()[0]!.task.resumePrompt, "回填的检查点");

  // ④ 已经挂着别的指令时不覆盖，也不广播（agent 可能刚 pause_task 写下新的一段）。
  events.length = 0;
  assert.equal(await restoreResumePrompt("task", "旧指令"), false, "非空位不该被旧指令盖掉");
  assert.equal(updates().length, 0, "没写进去就不该广播");
  assert.equal(
    (await db.select({ resumePrompt: tasks.resumePrompt }).from(tasks).where(eq(tasks.id, "task"))).at(0)?.resumePrompt,
    "回填的检查点",
  );

  // ⑤ 复合更新（结算、原生引导清场）自己改完这一列，靠 announceResumePrompt 补广播。
  events.length = 0;
  await db.update(tasks).set({ resumePrompt: null, updatedAt: at }).where(eq(tasks.id, "task"));
  await announceResumePrompt("task");
  assert.equal(updates().length, 1, "复合更新也要把整行推出去");
  assert.equal(updates()[0]!.task.resumePrompt, null);

  unsubscribe();
  console.log("resume-prompt broadcast test passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
