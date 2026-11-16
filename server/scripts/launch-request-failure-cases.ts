// test-launch-request.ts 的后半：放行口在出岔子时的那几档（第 1 轮审查 R1–R4、N1）。
//
//  L9  认领回合之后、交给启动器之前抛的错（锁里那一问读库失败）也算一次起不来：退避、到顶只留一句交代，
//      不是放锁补扫 200ms 一轮地原样再撞；
//  L10 到顶那句交代写不进时间线：请求留着（页面上照样看得见那句话），不会再起它；下一次扫描写成了才撤掉；
//  L11 起不来的那次尝试收尾之前，又被要求了一次开工（新的一代）：旧尝试记不到新一代头上、也撤不掉它；
//  L12 数名额读回占锁那几条的分组之后、认领之前分组被删了：按删组之后的归属数，不会多放一条；
//  N1  运行分组时前置还没站齐：页面马上收到「在等」，不用刷新。
import {
  db, hasStarted, project, release, request, row, runs, schema, sleep, started, tasks, until,
} from "./prerequisite-fixture.js";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { eq } from "drizzle-orm";

const { dbClient } = await import("../src/db/index.js");
const { bus } = await import("../src/bus.js");
const { runGroup } = await import("../src/scheduler.js");
const { MAX_START_ATTEMPTS, requestLaunch, setLaunchRetryBase, sweepLaunchRequests } = await import("../src/launch-request.js");
const { claimLaunchTurn, PARALLEL_LIMIT } = await import("../src/launch-capacity.js");
const { launchRecord } = await import("../src/prerequisite-store.js");
const { sessionTranscriptPath } = await import("../src/transcript.js");

async function transcript(taskId: string): Promise<string> {
  const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.taskId, taskId));
  return sessions.map((session) => {
    const path = sessionTranscriptPath(taskId, session.id);
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }).join("\n");
}
const notices = async (taskId: string) => (await transcript(taskId)).split("没能自动开工").length - 1;

/** 只在这条任务已经认领了回合、正在锁里问前置那一下（attemptGate）抛错；`onFail` 在抛之前调。 */
function failGateAfterClaim(taskId: string, onFail?: (count: number) => Promise<void>) {
  const execute = dbClient.execute;
  let count = 0;
  let armed = true;
  dbClient.execute = async function (statement) {
    if (armed && typeof statement !== "string" && statement.sql.includes('from "task_prerequisites"')
      && runs.isTurnClaimed(taskId) && new Error().stack?.includes("attemptGate")) {
      count += 1;
      await onFail?.(count);
      throw new Error("INJECT_GATE_READ_AFTER_CLAIM");
    }
    return execute.call(dbClient, statement);
  };
  return { count: () => count, disarm: () => { armed = false; }, restore: () => { dbClient.execute = execute; } };
}

export async function launchRequestFailureCases(): Promise<void> {
  setLaunchRetryBase(20);
  try {
    // ── L9 认领之后的错也记账；L10 交代写不进去就留着请求 ──────────────────────
    {
      const p = await project();
      const id = await p.task("l9", { useWorktree: false });
      started.push(id);
      const gate = failGateAfterClaim(id);
      const execute = dbClient.execute;
      let noticeFailed = 0;
      let noticeBroken = true;
      // 到顶那句交代写不进去（找诊断会话那一下读库失败），直到用例放开。
      dbClient.execute = async function (statement) {
        if (noticeBroken && typeof statement !== "string" && /from "sessions"/.test(statement.sql)
          && new Error().stack?.includes("reportLaunchGiveUp")) {
          noticeFailed += 1;
          throw new Error("INJECT_GIVE_UP_NOTICE_FAILURE");
        }
        return execute.call(dbClient, statement);
      };
      try {
        await runGroup(p.group);
        await until("连着起不来到顶", async () => !!(await launchRecord(id))?.giveUp, 10_000);
        await until("交代没写成", () => noticeFailed > 0);
        await sleep(400);
        assert.equal(gate.count(), MAX_START_ATTEMPTS, "认领之后抛的错记进退避，到顶为止，不在放锁补扫里打转");
        const record = await launchRecord(id);
        assert.ok(record?.requestedAt, "交代没写成：请求留着，下次接着写");
        assert.equal(record?.startFailures, MAX_START_ATTEMPTS);
        assert.equal(await notices(id), 0);
        const waiting = (await request("GET", `/tasks/${id}`).then((res) => res.json())) as { prerequisites?: { waiting: boolean; holdup: string | null } };
        assert.equal(waiting.prerequisites?.waiting, true, "页面上还看得见它");
        assert.match(waiting.prerequisites?.holdup ?? "", /不再自动重试/);
        await sweepLaunchRequests();
        assert.ok((await launchRecord(id))?.requestedAt, "还是写不进去：接着留着");
        noticeBroken = false;
        await sweepLaunchRequests();
        await until("下一次扫描把交代写成、撤掉请求", async () => !(await launchRecord(id))?.requestedAt);
        assert.equal(await notices(id), 1, "交代只留一条");
        await sweepLaunchRequests();
        await sleep(200);
        assert.equal(gate.count(), MAX_START_ATTEMPTS, "到顶之后再扫也不再起它");
        assert.equal(await notices(id), 1);
        assert.equal(hasStarted(id), false);
        assert.equal((await row(id)).status, "backlog");
        assert.equal(runs.isTurnClaimed(id), false);
      } finally {
        dbClient.execute = execute;
        gate.restore();
      }
      console.log("PASS L9/L10: errors after the claim count toward backoff; the give-up notice keeps the request until it is written");
    }

    // ── L11 旧尝试碰不到新一代请求 ─────────────────────────────────────────────
    {
      const p = await project();
      const id = await p.task("l11", { useWorktree: false });
      started.push(id);
      await requestLaunch([id], { source: "group" });
      // 旧那一代已经起不来过两次：这一次再失败就该到顶。
      await db.update(schema.taskPrerequisiteLaunches).set({ startFailures: MAX_START_ATTEMPTS - 1 })
        .where(eq(schema.taskPrerequisiteLaunches.taskId, id));
      const before = (await launchRecord(id))!.requestId;
      // 这一次失败收尾时，读完这笔请求、还没把次数记上去的那一刻，用户又点了一次运行分组：新的一代。
      const gate = failGateAfterClaim(id, async () => gate.disarm());
      const execute = dbClient.execute;
      let renewed = false;
      let charged: number | null = null; // 旧尝试记完之后，新一代头上的次数
      dbClient.execute = async function (statement) {
        const result = await execute.call(dbClient, statement);
        if (typeof statement !== "string" && new Error().stack?.includes("noteStartFailure")) {
          if (!renewed && /from "task_prerequisite_launches"/.test(statement.sql)) {
            renewed = true;
            await requestLaunch([id], { source: "group" });
          } else if (renewed && charged === null && /^update "task_prerequisite_launches"/.test(statement.sql)) {
            charged = (await launchRecord(id))?.startFailures ?? null;
          }
        }
        return result;
      };
      try {
        await sweepLaunchRequests();
        await until("新一代照常起跑", () => hasStarted(id), 10_000);
        assert.equal(gate.count(), 1);
        assert.equal(renewed, true);
        assert.equal(charged, 0, "旧尝试那一次起不来没记到新一代头上");
        assert.notEqual((await launchRecord(id))?.requestId, before, "重新要求换了一代");
        assert.equal(await notices(id), 0, "旧尝试的第三次失败没记到新一代头上");
        await until("起了的这一代了结", async () => !(await launchRecord(id))?.requestedAt);
      } finally {
        dbClient.execute = execute;
        gate.restore();
      }
      release(id);
      await until(`${id} 跑完`, async () => (await row(id)).status === "done" && !runs.turnIdentity(id));
      console.log("PASS L11: a stale attempt cannot count against or settle a request that was renewed meanwhile");
    }

    // ── L12 读完分组之后分组被删：按删组之后数 ─────────────────────────────────
    {
      const p = await project();
      const holders: string[] = [];
      for (let index = 0; index < PARALLEL_LIMIT; index++) holders.push(await p.task(`l12-${index}`, { useWorktree: false }));
      const loose = await p.task("l12-loose", { useWorktree: false });
      await db.update(tasks).set({ groupId: null }).where(eq(tasks.id, loose));
      const turns = holders.map((id) => runs.claimTurn(id, "single") && runs.turnIdentity(id)!);
      const execute = dbClient.execute;
      let deleted = false;
      dbClient.execute = async function (statement) {
        const result = await execute.call(dbClient, statement);
        if (!deleted && typeof statement !== "string" && /^select "id", "group_id" from "tasks"/.test(statement.sql)
          && Array.isArray(statement.args) && holders.every((id) => statement.args.includes(id))) {
          deleted = true;
          assert.equal((await request("DELETE", `/groups/${p.group}`)).status, 200);
        }
        return result;
      };
      try {
        const claim = await claimLaunchTurn(loose, null);
        assert.equal(deleted, true, "删组落在读完分组之后、认领之前");
        assert.deepEqual(claim, { ok: false, why: "full", running: PARALLEL_LIMIT }, "摘出来的四条算进不在分组里的那一桶");
        assert.equal(runs.isTurnClaimed(loose), false);
      } finally {
        dbClient.execute = execute;
        holders.forEach((id, index) => runs.releaseTurn(id, turns[index]!));
      }
      console.log("PASS L12: deleting a group between the holder read and the claim invalidates the count");
    }

    // ── N1 运行分组时前置没站齐：马上收到「在等」 ──────────────────────────────
    {
      const p = await project();
      const pre = await p.task("n1-pre");
      const id = await p.task("n1", { prerequisites: [pre] });
      await db.update(tasks).set({ groupId: null }).where(eq(tasks.id, pre));
      let pushed = false;
      const unsubscribe = bus.subscribe((event) => {
        if (event.type === "task.updated" && event.task.id === id && event.task.prerequisites?.waiting) pushed = true;
      });
      try {
        await runGroup(p.group);
        await until("页面收到「在等」", () => pushed, 5_000);
        assert.ok((await launchRecord(id))?.requestedAt);
        assert.equal(hasStarted(id), false);
      } finally {
        unsubscribe();
      }
      assert.equal((await request("POST", `/tasks/${id}/stop`)).status, 200);
      console.log("PASS N1: a group run that has to wait for prerequisites publishes the waiting view at once");
    }
  } finally {
    setLaunchRetryBase(30_000);
  }
}
