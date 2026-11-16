import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  api, db, dbClient, hits, now, runs, scenario, schema, settled, taskOf, tasks, until,
} from "./checkpoint-recovery-fixture.js";
import { mountGroupRoutes } from "../src/group-routes.js";
import { runGroup } from "../src/scheduler.js";
import { takeResumePrompt } from "../src/task-resume-prompt.js";
import { MAX_START_ATTEMPTS, setLaunchRetryBase, sweepLaunchRequests } from "../src/launch-request.js";
import { sessionTranscriptPath } from "../src/transcript.js";
import { isDiagnosticSession } from "../src/turn-failure.js";
import { id } from "../src/util.js";

const groupApi = new Hono();
mountGroupRoutes(groupApi);

async function transcript(taskId: string): Promise<string> {
  const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.taskId, taskId));
  return sessions.map((session) => {
    const path = sessionTranscriptPath(taskId, session.id);
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }).join("\n");
}

function calledFrom(name: string): boolean {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 100;
  try {
    return new RegExp(`\\b${name}\\b`).test(new Error().stack ?? "");
  } finally {
    Error.stackTraceLimit = limit;
  }
}

const launchOf = async (taskId: string) => (await db.select().from(schema.taskPrerequisiteLaunches)
  .where(eq(schema.taskPrerequisiteLaunches.taskId, taskId))).at(0);

export async function checkpointGroupFailureCases(): Promise<void> {
  // 分组里一位成员起不来：只是它自己的事。`give-up`：每一次起跑都在拉起执行器之前抛错 —— 退避再试，连着到顶
  // 就撤掉请求、留一句交代（不是每扫一次刷一条）；`guarded-stop`：起跑途中用户点了停止 —— 这一次冻住、请求撤回，
  // 之后腾出名额也不再起它。两档里其余成员（含超过名额、靠回填起的第 5/6 位）和关联队列都照常跑。
  setLaunchRetryBase(20);
  for (const failure of ["give-up", "guarded-stop"]) {
    const members = [];
    for (let index = 0; index < 6; index++) {
      const test = await scenario(0);
      const body = `GROUP_MEMBER_${id()}`;
      await takeResumePrompt(test.taskId, test.checkpoint);
      await db.update(tasks).set({ status: "backlog", body }).where(eq(tasks.id, test.taskId));
      members.push({ ...test, body });
    }
    const first = await taskOf(members[0]!.taskId);
    const groupId = id();
    const queueId = id();
    await db.insert(schema.groups).values({ id: groupId, projectId: first.projectId, name: failure, mode: "parallel", createdAt: now() });
    const follower = await scenario(0);
    for (const member of [...members, follower]) await db.update(tasks).set({ groupId }).where(eq(tasks.id, member.taskId));
    await db.insert(schema.queueItems).values({ taskId: follower.taskId, queueId, position: 0, createdAt: now() });
    const failedId = members[1]!.taskId;
    const execute = dbClient.execute;
    let injected = 0;
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on("unhandledRejection", onUnhandled);
    // 起跑读任务头那一下（task-run.ts runHeldTask）：回合已经认领、执行器还没拉起。
    dbClient.execute = async function (statement) {
      if (typeof statement !== "string" && /^select "mode", "handoff" from "tasks"/i.test(statement.sql)
        && Array.isArray(statement.args) && statement.args.includes(failedId)) {
        injected += 1;
        if (failure === "guarded-stop") {
          if (injected === 1) assert.equal((await api.request(`/tasks/${failedId}/stop`, { method: "POST" })).status, 200);
        } else {
          throw new Error("INJECT_MEMBER_START_FAILURE");
        }
      }
      return execute.call(dbClient, statement);
    };
    try {
      await runGroup(groupId);
      if (failure === "give-up") {
        await until("连着起不来到顶后撤掉请求、留下交代", async () => !(await launchOf(failedId))?.requestedAt
          && /没能自动开工/.test(await transcript(failedId)));
        assert.equal(injected, MAX_START_ATTEMPTS, "退避重试到顶为止，不多试一次");
      } else {
        assert.equal(injected, 1);
      }
      for (const member of members) {
        await settled(member.taskId);
        assert.equal((await taskOf(member.taskId)).queueSeatToken, null);
        const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.taskId, member.taskId));
        if (member.taskId === failedId) {
          assert.equal(hits(member.body), 0);
          assert.equal(runs.isTurnClaimed(failedId), false);
          assert.equal((await launchOf(failedId))?.requestedAt ?? null, null);
          if (failure === "give-up") {
            assert.equal((await taskOf(failedId)).status, "backlog");
            assert.equal(sessions.filter(isDiagnosticSession).length, 1, "交代只留一条");
            const said = await transcript(failedId);
            assert.equal(said.split("没能自动开工").length - 1, 1);
            assert.match(said, /INJECT_MEMBER_START_FAILURE/);
          } else {
            assert.equal((await taskOf(failedId)).status, "canceled");
            // 冻在拉起执行器之前：没有执行会话，只有那一句「停过」（刷新后仍看得见）。
            assert.ok(sessions.length > 0 && sessions.every(isDiagnosticSession));
            assert.match(await transcript(failedId), /停止/);
          }
        } else {
          assert.ok(hits(member.body) > 0, "超过并发上限的第5/6项也到达执行器");
          assert.equal(sessions.filter((session) => !isDiagnosticSession(session)).length, 1);
        }
      }
      await until("并行分组收尾仍推进关联队列", async () => hits(follower.checkpoint) === 1);
      await settled(follower.taskId);
      // 再扫一遍、再等过最长的退避：撤掉的请求不会把它重新起出来。
      await sweepLaunchRequests();
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(injected, failure === "give-up" ? MAX_START_ATTEMPTS : 1);
      assert.equal(hits(members[1]!.body), 0);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
    } finally {
      dbClient.execute = execute;
      process.off("unhandledRejection", onUnhandled);
      await db.delete(schema.queueItems).where(eq(schema.queueItems.queueId, queueId));
    }
    console.log(`PASS: parallel group ${failure} stays local, later members and linked queues still run, one durable statement`);
  }
  setLaunchRetryBase(30_000);

  {
    const test = await scenario(0);
    await takeResumePrompt(test.taskId, test.checkpoint);
    await db.update(tasks).set({ status: "backlog" }).where(eq(tasks.id, test.taskId));
    const task = await taskOf(test.taskId);
    const groupId = id();
    await db.insert(schema.groups).values({ id: groupId, projectId: task.projectId, name: "background-error", mode: "parallel", createdAt: now() });
    // 旁观者:跟这次启动毫无关系的三种成员。早先失败交代按 `groupId` 全捞一遍、一个条件都
    // 不加,数据库抖一下它们各收一条「这一轮没能起跑」,已完成那位还被追加进正常对话、刷新
    // 后仍在(第 2 轮审查必须修 2;复现见审查目录的 group-failure-fanout.mts)。这个用例
    // 此前只放了 1 个成员,扇出范围因此整条漏出去 —— 所以旁观者必须在场。
    const bystanders: { label: string; taskId: string }[] = [];
    const finished = await scenario(0);
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, finished.taskId));
    bystanders.push({ label: "早已完成", taskId: finished.taskId });
    const archived = await scenario(0);
    await db.update(tasks).set({ status: "done", archived: true }).where(eq(tasks.id, archived.taskId));
    bystanders.push({ label: "已归档", taskId: archived.taskId });
    const team = await scenario(0, "team");
    bystanders.push({ label: "团队调度台", taskId: team.taskId });
    const owner = await scenario(0);
    await db.update(tasks).set({ status: "idle" }).where(eq(tasks.id, owner.taskId));
    await db.update(schema.groups).set({ ownerTaskId: owner.taskId }).where(eq(schema.groups.id, groupId));
    for (const member of [test, ...bystanders.map((one) => ({ taskId: one.taskId }))]) {
      await db.update(tasks).set({ groupId }).where(eq(tasks.id, member.taskId));
    }
    const before = new Map<string, number>();
    for (const one of bystanders) {
      before.set(one.taskId, (await db.select().from(schema.sessions)
        .where(eq(schema.sessions.taskId, one.taskId))).length);
    }
    const execute = dbClient.execute;
    let reads = 0;
    let injected = false;
    dbClient.execute = async function (statement) {
      if (typeof statement !== "string" && /from "groups" where/i.test(statement.sql)
        && Array.isArray(statement.args) && statement.args.includes(groupId) && ++reads === 2) {
        injected = true;
        throw new Error("INJECT_BACKGROUND_GROUP_READ_FAILURE");
      }
      return execute.call(dbClient, statement);
    };
    try {
      assert.equal((await groupApi.request(`/groups/${groupId}/run`, { method: "POST" })).status, 202);
      await until("后台恢复失败留下持久时间线", async () => /INJECT_BACKGROUND_GROUP_READ_FAILURE/.test(await transcript(test.taskId)));
      assert.equal(injected, true);
      const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.taskId, test.taskId));
      assert.equal(sessions.length, 1);
      assert.ok(isDiagnosticSession(sessions[0]!));
      assert.equal(runs.isTurnClaimed(test.taskId), false);
      // 发起这次启动的调度台也要听见:它是「谁在等这个结果」的那一位。
      await until("发起这次启动的调度台收到交代", async () => /INJECT_BACKGROUND_GROUP_READ_FAILURE/.test(await transcript(owner.taskId)));
      // 旁观者一个字都不许收到,也不许被插诊断会话行。
      for (const one of bystanders) {
        assert.equal(/分组本次启动未完成/.test(await transcript(one.taskId)), false,
          `${one.label}的时间线里不该冒出不属于它的失败`);
        assert.equal((await db.select().from(schema.sessions)
          .where(eq(schema.sessions.taskId, one.taskId))).length, before.get(one.taskId),
          `${one.label}不该为这次启动失败多出一条会话行`);
      }
    } finally {
      dbClient.execute = execute;
    }
    console.log("PASS: background group failure reaches only this run's launch targets and the owner, never bystanders");
  }
  {
    // 成员全部**成功起跑**之后、收尾那一步(推关联队列)才抛的那一档。
    // 第 1 轮审查发现 4:名单此刻正该是空的,早先却在这里回头按 `groupId` 重算一遍,
    // 等于把一批正在跑(或已跑完)的任务重新算成「这一轮没能起跑」。上面那个
    // background-error 用例只证明了**静态旁观者**不连坐 —— 它们从头到尾没被挑中;
    // 这里要证的是另一半:**本次挑中且确实起来了**的成员也必须退出名单。
    const members = [];
    for (let index = 0; index < 2; index++) {
      const test = await scenario(0);
      const body = `LAUNCHED_MEMBER_${id()}`;
      await takeResumePrompt(test.taskId, test.checkpoint);
      await db.update(tasks).set({ status: "backlog", body }).where(eq(tasks.id, test.taskId));
      members.push({ ...test, body });
    }
    const first = await taskOf(members[0]!.taskId);
    const groupId = id();
    await db.insert(schema.groups).values({ id: groupId, projectId: first.projectId, name: "after-launch-error", mode: "parallel", createdAt: now() });
    const owner = await scenario(0);
    await db.update(tasks).set({ status: "idle" }).where(eq(tasks.id, owner.taskId));
    await db.update(schema.groups).set({ ownerTaskId: owner.taskId }).where(eq(schema.groups.id, groupId));
    const follower = await scenario(0);
    const queueId = id();
    for (const member of [...members, owner, follower]) {
      await db.update(tasks).set({ groupId }).where(eq(tasks.id, member.taskId));
    }
    await db.insert(schema.queueItems).values({ taskId: follower.taskId, queueId, position: 0, createdAt: now() });
    const execute = dbClient.execute;
    let injected = false;
    // 运行分组收尾推这条关联队列那一下（runParallel 先等齐放行口、成员各自拿到启动回执，再推队列）：推进意图
    // 落不了库、临界区读队列项也失败 —— advanceQueue 这时才会把错抛回给运行分组（只失败一笔它自己兜得住）。
    // 意图那一笔认调用栈：页面那边展开动作、别处的推进也会碰同一条队列。
    let armed = false;
    dbClient.execute = async function (statement) {
      if (!injected && typeof statement !== "string" && Array.isArray(statement.args) && statement.args.includes(queueId)) {
        if (!armed && /^insert into "queue_advance_intents"/i.test(statement.sql) && calledFrom("runParallel")) {
          armed = true;
          throw new Error("INJECT_GROUP_TEARDOWN_INTENT_FAILURE");
        }
        if (armed && /^select "task_id", "queue_id", "position", "created_at" from "queue_items"/i.test(statement.sql)) {
          injected = true;
          throw new Error("INJECT_GROUP_TEARDOWN_FAILURE");
        }
      }
      return execute.call(dbClient, statement);
    };
    try {
      assert.equal((await groupApi.request(`/groups/${groupId}/run`, { method: "POST" })).status, 202);
      await until("收尾失败交代给发起这次启动的调度台", async () => /INJECT_GROUP_TEARDOWN_FAILURE/.test(await transcript(owner.taskId)));
      assert.equal(injected, true);
      for (const member of members) {
        await settled(member.taskId);
        assert.ok(hits(member.body) > 0, "成员这一轮确实起跑了");
        assert.equal(/分组本次启动未完成/.test(await transcript(member.taskId)), false,
          "已经拿到启动回执的成员不该收到「这一轮没能起跑」");
        const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.taskId, member.taskId));
        assert.equal(sessions.some(isDiagnosticSession), false, "起跑成功的成员不该为收尾失败多出一条诊断会话行");
      }
    } finally {
      dbClient.execute = execute;
      await settled(follower.taskId);
      await db.delete(schema.queueItems).where(eq(schema.queueItems.queueId, queueId));
    }
    console.log("PASS: post-launch group teardown failure tells only the owner, never the members that already started");
  }
}
