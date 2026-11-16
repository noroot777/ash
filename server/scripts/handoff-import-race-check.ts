// test-handoff 第 8 节:并发导入互斥。从主文件拆出来只为压体积(700 行硬线),断言原样搬过来。
// 跑在**源机进程内**,所以按调用时机动态 import 那些吃 ASH_DB 的模块(同 handoff-state-check.ts)。
//
// 缺陷形态(第 2 轮审查实测):两个并发 import 都过了 existing 预检,输家撞
// tasks.id UNIQUE 后补偿回滚按公共 task id 把赢家的行也删了(req1 200、req2 500、
// 最终 GET 404)。进程内直调本机(源库)的 importHandoff:互斥闸是入口处的同步
// 前缀,两个调用必然重叠,后到者在任何副作用之前就被挡下。
import assert from "node:assert/strict";

export async function checkConcurrentImport(projectId: string): Promise<void> {
  const { db } = await import("../src/db/index.js");
  const { sessions, tasks } = await import("../src/db/schema.js");
  const { eq } = await import("drizzle-orm");
  const { HandoffError } = await import("../src/handoff-types.js");
  const { importHandoff } = await import("../src/handoff-import.js");
  const raceManifest = (transferId: string, sessionId: string) => ({
    version: 1, sourceHost: "test-src", sourceWorkspace: null,
    targetProjectId: projectId, autoResume: false, git: null, files: [] as unknown[],
    transferId,
    task: {
      id: "handoff-e2e-task-04", title: "并发导入用例", body: "race",
      status: "paused", createdAt: "2026-08-19T10:00:00.000Z",
    },
    sessions: [{
      id: sessionId, role: "implementer", agentType: "claude", executor: "claude",
      startedAt: "2026-08-19T10:01:00.000Z",
    }],
  });
  const [race1, race2] = await Promise.allSettled([
    importHandoff(raceManifest("transfer-race-1", "handoffrace1")),
    importHandoff(raceManifest("transfer-race-2", "handoffrace2")),
  ]);
  assert.equal(race1.status, "fulfilled", "先到的导入应正常落库");
  assert.equal(race2.status, "rejected", "同 id 的并发导入必须被互斥闸挡下");
  const raceErr = (race2 as PromiseRejectedResult).reason as InstanceType<typeof HandoffError>;
  assert.ok(raceErr instanceof HandoffError && raceErr.status === 409, "互斥闸应 409(稍后原样重试),而不是 500");
  assert.match(raceErr.message, /另一次导入还在本机进行中/);
  const raceTask = (await db.select().from(tasks).where(eq(tasks.id, "handoff-e2e-task-04"))).at(0);
  assert.ok(raceTask, "输家被挡下后,赢家的任务行必须毫发无损");
  const raceSessions = await db.select().from(sessions).where(eq(sessions.taskId, "handoff-e2e-task-04"));
  assert.equal(raceSessions.length, 1, "只该留下赢家那一条会话行");
  assert.equal(raceSessions[0]!.id, "handoffrace1");
}
