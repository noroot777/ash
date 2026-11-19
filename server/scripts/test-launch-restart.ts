// 重启之后名额照样数得对：名额数的是此刻占着执行回合的条数，重启接回的回合重新占上锁，就自然算在里面 ——
// 没有要在接回时补记的计数。
//
// 两个进程跑同一个库：`seed` 起四组、各六条，三组各起满四条之后进程直接退出（假执行器是 detached 起的，活过它）；
// 第四组只挂了请求、一条都没来得及起（运行分组写完请求就崩了）。`resume` 照开机的次序来：先按住放行口、
// 接回在跑的回合、再放开补办 —— 三种来路（运行分组 / 前置站齐 / 派活单）各自
//   · 接回之后另外两条不起（同组已经四条在跑）；
//   · 跑完一条只补一条，任何时刻同组都不超过四条，六条最后都起了；
// 崩在半路的那一组开机后照请求起四条、再逐条补上。
// 跑：npm -w server run test:launch-restart
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { tsxLoaderPath } from "./tsx-loader.js";

const phase = process.argv[2];
const SOURCES = ["group", "prerequisite", "dispatch", "crashed"] as const;
const PER_GROUP = 6;

if (!phase) {
  const root = mkdtempSync(join(tmpdir(), "navi-launch-restart-"));
  try {
    for (const name of ["seed", "resume"]) {
      const child = spawnSync(process.execPath, ["--import", tsxLoaderPath(), fileURLToPath(import.meta.url), name], {
        env: { ...process.env, NAVI_TEST_FIXTURE_ROOT: root }, encoding: "utf8", timeout: 400_000,
      });
      process.stdout.write(child.stdout ?? "");
      process.stderr.write(child.stderr ?? "");
      assert.ifError(child.error);
      assert.equal(child.status, 0, `${name} 阶段失败`);
    }
    console.log("launch restart: ok");
  } finally {
    // 假执行器都放走了才删台子（resume 收尾等过它们退干净）。
    rmSync(root, { recursive: true, force: true });
  }
  process.exit(0);
}

const fixture = await import("./prerequisite-fixture.js");
const { db, hasStarted, holdForPrerequisites, notePrerequisiteProgress, project, release, row, runs, schema, sleep, started, tasks, until } = fixture;
const { eq, inArray } = await import("drizzle-orm");
const { requestLaunch, sweepLaunchRequests } = await import("../src/launch-request.js");
const { runningInGroup, PARALLEL_LIMIT } = await import("../src/launch-capacity.js");
const { heldTurns } = await import("../src/turn-lock.js");
const { runGroup } = await import("../src/scheduler.js");

/** 每组的成员（resume 阶段按组从库里读回来）。 */
async function membersOf(group: string): Promise<string[]> {
  const rows = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.groupId, group));
  return rows.map((one) => one.id).filter((id) => !id.endsWith("-pre")).sort();
}
const startedOf = (ids: readonly string[]) => ids.filter((id) => hasStarted(id));
const groupOf = (source: string) => `p${SOURCES.indexOf(source as typeof SOURCES[number]) + 1}-g`;

if (phase === "seed") {
  await fixture.setup();
  for (const source of SOURCES) {
    const p = await project();
    assert.equal(p.group, groupOf(source));
    const worktree = source === "prerequisite"; // 下游要建在前置的代码上，前置和下游都得是独立工作区
    const pre = worktree ? await p.task("pre") : null;
    const ids: string[] = [];
    for (let index = 0; index < PER_GROUP; index++) {
      ids.push(await p.task(`m${index}`, { useWorktree: worktree, prerequisites: pre ? [pre] : [] }));
    }
    if (source === "group") await runGroup(p.group);
    if (source === "prerequisite") {
      for (const id of ids) assert.ok(await holdForPrerequisites(await row(id), { source: "run" }), "前置没站齐：记下请求");
      await p.finish(pre!);
      notePrerequisiteProgress(pre!);
    }
    if (source === "dispatch") {
      // 派活单派出：请求跟建任务同一笔事务落库，再走放行口（dispatch-plan-launch.ts 那一套）。
      await db.transaction(async (transaction) => requestLaunch(ids, { source: "run" }, transaction));
      await sweepLaunchRequests();
    }
    if (source === "crashed") await requestLaunch(ids, { source: "group" }); // 写完请求就崩了
  }
  for (const source of SOURCES.filter((one) => one !== "crashed")) {
    const ids = await membersOf(groupOf(source));
    await until(`${source}：先起满四条`, () => startedOf(ids).length === PARALLEL_LIMIT && ids.filter((id) => runs.isRunning(id)).length === PARALLEL_LIMIT, 30_000);
  }
  await sleep(500);
  for (const source of SOURCES) {
    const ids = await membersOf(groupOf(source));
    assert.equal(startedOf(ids).length, source === "crashed" ? 0 : PARALLEL_LIMIT, `${source}：退出前起了几条`);
  }
  console.log("SEED: three groups at four running, one group with requests only; exiting without stopping anything");
  process.exit(0); // 不收尾：假执行器留着，下一个进程来接
}

// ── resume：开机那一套次序 ──────────────────────────────────────────────────
const { ensureSchema } = fixture;
await ensureSchema();
const { holdLaunchesForBoot } = await import("../src/launch-request.js");
holdLaunchesForBoot();
const { reattachRunningTasks } = await import("../src/reattach.js");
const groups = new Map<string, string[]>();
for (const source of SOURCES) groups.set(source, await membersOf(groupOf(source)));
const all = [...groups.values()].flat();
started.push(...all);
let peakOver = 0;
const sampler = setInterval(() => {
  for (const ids of groups.values()) {
    const count = heldTurns().filter((turn) => ids.includes(turn.taskId) && (turn.role === "single" || turn.role === "duet")).length;
    peakOver = Math.max(peakOver, count);
  }
}, 5);
try {
  const adopted = await reattachRunningTasks();
  for (const source of SOURCES.filter((one) => one !== "crashed")) {
    const running = groups.get(source)!.filter((id) => adopted.has(id));
    assert.equal(running.length, PARALLEL_LIMIT, `${source}：接回四条`);
  }
  await fixture.startPrerequisiteLaunches(3_600_000);
  await until("崩在半路的那一组开机后起四条", () => startedOf(groups.get("crashed")!).length === PARALLEL_LIMIT, 30_000);
  await sleep(800);
  for (const [source, ids] of groups) {
    assert.equal(startedOf(ids).length, PARALLEL_LIMIT, `${source}：接回之后另外两条不起`);
    assert.equal(await runningInGroup(groupOf(source)), PARALLEL_LIMIT, `${source}：同组在跑四条`);
  }
  // 每组跑完一条：各补一条，只补一条。
  const first = new Map([...groups].map(([source, ids]) => [source, startedOf(ids)[0]!]));
  for (const id of first.values()) release(id);
  for (const id of first.values()) await until(`${id} 跑完`, async () => (await row(id)).status === "done" && !runs.turnIdentity(id), 120_000);
  for (const [source, ids] of groups) await until(`${source}：跑完一条补一条`, () => startedOf(ids).length === PARALLEL_LIMIT + 1, 60_000);
  await sleep(500);
  for (const [source, ids] of groups) assert.equal(startedOf(ids).length, PARALLEL_LIMIT + 1, `${source}：只补一条`);
  // 全部放走：六条最后都起了，过程中同组从没超过四条。
  for (const id of all) release(id);
  // 接回来的回合收口要证明后代收干净（lsof），这台机器上一条可能要十几秒，所以这一段等得长。
  for (const [source, ids] of groups) await until(`${source}：六条都起了`, () => startedOf(ids).length === PER_GROUP, 120_000);
  for (const id of all) await until(`${id} 跑完`, async () => (await row(id)).status === "done" && !runs.turnIdentity(id), 120_000);
  assert.ok(peakOver <= PARALLEL_LIMIT, `重启之后任何时刻同组都不超过四条（峰值 ${peakOver}）`);
  const left = await db.select().from(schema.taskPrerequisiteLaunches).where(inArray(schema.taskPrerequisiteLaunches.taskId, all));
  assert.ok(left.every((one) => one.requestedAt === null), "请求都了结了");
  console.log("PASS: after a restart each source keeps four running, backfills one per finish, and the crashed group run resumes");
} finally {
  clearInterval(sampler);
  await fixture.teardown();
}
process.exit(0);
