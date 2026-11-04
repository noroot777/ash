// 生成物并发裁决的**证据本身**靠不靠得住（承接 test-task-artifacts-concurrent.ts，那边钉的是判法）。
//
// 这里钉四件事：
//   1. 写入记录按**这一步操作开始的时刻**记：claude 工具调用发出那一刻、codex 条目 started 那一刻
//      （或完成时自报的耗时）——于是裁决只需要给时钟精度留余量，一份半分钟后才写的无关说明不能
//      回头认领早先的成品；
//   2. 同一条路径的记录乱序到达时，「最早」「最晚」两端都只往外扩；
//   3. 在隔壁目录开工、用绝对路径写进来的任务也是对手（按写入记录找，不只按工作目录找）；
//   4. 按时间找到的提交，只有它落下的内容就是磁盘上这一份时才作数：合并提交改成了别人那版、
//      回拨了日期的提交、同一条路径先在精确区间后在推断区间各提交一次，都不能被当成确定。
// 跑：npm -w server run test:task-artifacts-evidence
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { releaseTmpDb, requireTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-artifacts-evidence-"));
process.env.ASH_DB = join(stage, "ash.db");
requireTmpDb("task-artifacts-evidence");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  const { db, ensureSchema } = await import("../src/db/index.js");
  await ensureSchema();
  const { ClaudeWriteLedger, CodexWriteClock } = await import("../src/executors/tool-writes.js");

  // ── 1a. 执行器这一侧：交出这一步花了多久 ─────────────────────────────────────
  const ledger = new ClaudeWriteLedger("/w");
  ledger.toolUse("Write", { file_path: "out/a.html", content: "x" }, "t1");
  await sleep(60);
  const claudeWrite = ledger.toolResult("t1", false);
  assert.ok(claudeWrite?.kind === "writes" && (claudeWrite.tookMs ?? 0) >= 50,
    `claude 写文件从工具调用发出那一刻算起：${JSON.stringify(claudeWrite)}`);
  assert.deepEqual(claudeWrite?.kind === "writes" && claudeWrite.paths, ["/w/out/a.html"]);

  const clock = new CodexWriteClock("/w");
  clock.start({ id: "f1", type: "fileChange", status: "inProgress" });
  await sleep(60);
  const change = clock.complete({ id: "f1", type: "fileChange", status: "completed", changes: [{ path: "b.md" }] }, "change");
  assert.ok(change?.kind === "writes" && (change.tookMs ?? 0) >= 50, `codex 改文件从 started 那一刻算起：${JSON.stringify(change)}`);
  clock.start({ id: "c1", type: "commandExecution" });
  const command = clock.complete({ id: "c1", status: "completed", cwd: "/w/sub", durationMs: 600_000 }, "command");
  assert.equal(command?.kind === "writes" && command.tookMs, 600_000, "命令自报了耗时就以它为准");
  assert.deepEqual(clock.complete({ id: "nope", status: "completed", cwd: "/w/sub" }, "command"),
    { kind: "writes", paths: ["/w/sub"], cwd: true }, "没见过开始、也没自报耗时：不编一个");

  // ── 2. 记录端：乱序到达只往外扩 ──────────────────────────────────────────────
  const { projects, sessions, sessionTurns, tasks, taskWrites } = await import("../src/db/schema.js");
  const { recordTaskWrites } = await import("../src/task-writes.js");
  const { readTaskArtifacts } = await import("../src/task-artifacts.js");
  const iso = (at: Date) => at.toISOString();
  const minutes = (base: Date, n: number) => new Date(base.getTime() + n * 60 * 1000);
  const T = new Date(Date.now() - 3 * 60 * 60 * 1000);

  const shared = join(stage, "empty");
  mkdirSync(shared, { recursive: true });
  await db.insert(projects).values({ id: "pc", name: "empty", repoPath: shared, createdAt: iso(T) });
  const runTask = async (id: string, start: Date, end: Date, dir = shared, project = "pc") => {
    await db.insert(tasks).values({
      id, projectId: project, title: id, body: "-", mode: "single", status: "done",
      agentType: "claude", useWorktree: false, createdAt: iso(start), updatedAt: iso(end),
    });
    await db.insert(sessions).values({
      id: `s-${id}`, taskId: id, role: "main", agentType: "claude", executor: "claude",
      cwd: dir, startedAt: iso(start), endedAt: iso(end), turnStartedAt: iso(start), exitStatus: 0,
      cliSessionId: `cli-${id}`, commandLine: "claude -p", activeMs: end.getTime() - start.getTime(),
      turnsStarted: 1, turnsBase: 0, turnsBaseApprox: false, turnsLost: 0,
    });
    await db.insert(sessionTurns).values({
      id: `t-${id}`, sessionId: `s-${id}`, taskId: id, cwd: dir, startedAt: iso(start), endedAt: iso(end),
    });
  };
  const write = (id: string, abs: string, at: Date, tookMs?: number) =>
    recordTaskWrites(id, `s-${id}`, { kind: "writes", paths: [abs], ...(tookMs ? { tookMs } : {}) }, iso(at));

  await runTask("Order0000001", T, minutes(T, 40));
  const ordered = join(shared, "order/render.py");
  await write("Order0000001", ordered, minutes(T, 20));
  // 一条跑了十分钟的命令，比上面那条晚到、却早开始。
  await write("Order0000001", ordered, minutes(T, 18), 10 * 60 * 1000);
  await write("Order0000001", ordered, minutes(T, 15));
  const [orderRow] = await db.select().from(taskWrites).where(eq(taskWrites.taskId, "Order0000001"));
  assert.equal(orderRow?.firstAt, iso(minutes(T, 8)), "晚到的记录开始得更早：最早那一端要往前扩");
  assert.equal(orderRow?.lastAt, iso(minutes(T, 20)), "晚到的记录结束得更早：最晚那一端不能往回拨");

  const place = (rel: string, at: Date, content: string | Buffer = "x") => {
    mkdirSync(join(shared, rel, ".."), { recursive: true });
    writeFileSync(join(shared, rel), content);
    utimesSync(join(shared, rel), at, at);
  };
  const root = { path: shared, branch: null, gitRepo: false, source: "repo" as const, repo: null, projectId: "pc" };
  const conf = async (id: string, rel: string, at = root) => {
    const got = await readTaskArtifacts(id, at);
    assert.equal(got.error, null, `${id} 读得通：${got.error}`);
    return got.artifacts.find((artifact) => artifact.path === rel)?.confidence ?? null;
  };

  // ── 1b. 半分钟后才写的说明不能回头认领 ─────────────────────────────────────
  // A、B 同时在跑。A 早先在 deliver/ 写过构建脚本，T+20 出了网页；B 一直在 notes/ 干活，网页出来
  // 半分钟后才在网页旁边写了一份说明。按 B 的那条记录比，B 离得更近——可那一刻它还没写。
  await runTask("SkewA0000002", T, minutes(T, 40));
  await runTask("SkewB0000003", minutes(T, 10), minutes(T, 50));
  await write("SkewA0000002", join(shared, "deliver/build.py"), minutes(T, 12));
  await write("SkewB0000003", join(shared, "notes/b.md"), minutes(T, 11));
  place("deliver/site/index.html", minutes(T, 20));
  await write("SkewB0000003", join(shared, "deliver/site/NOTES.md"), new Date(minutes(T, 20).getTime() + 30_000));
  assert.equal(await conf("SkewA0000002", "deliver/site/index.html"), "exact",
    "网页落下的那一刻，离它最近的写入是 A 的；B 半分钟后的说明不参赛");
  assert.equal(await conf("SkewB0000003", "deliver/site/index.html"), null);

  // ── 3. 在隔壁目录开工、写进来的任务也是对手 ────────────────────────────────
  // B 的工作目录在 shared 外面，却用绝对路径往 shared/charts 里写。按工作目录找对手的话它根本
  // 不在名单里，A 就会把 B 的图当成「那一刻只有自己在」认成确定。
  const sibling = join(stage, "sibling");
  mkdirSync(sibling, { recursive: true });
  await db.insert(projects).values({ id: "ps", name: "sibling", repoPath: sibling, createdAt: iso(T) });
  await runTask("NearA0000004", minutes(T, 60), minutes(T, 100));
  await runTask("FarB00000005", minutes(T, 70), minutes(T, 110), sibling, "ps");
  await write("NearA0000004", join(shared, "near/build.py"), minutes(T, 61));
  await write("FarB00000005", join(shared, "charts/data.csv"), minutes(T, 71));
  place("charts/chart.png", minutes(T, 80));
  assert.equal(await conf("NearA0000004", "charts/chart.png"), null,
    "B 的工作目录不沾这里，但它的写入记录指进了这里：B 是对手，而且离图更近");

  // ── 4. 按时间找到的提交要对得上磁盘上这一份 ─────────────────────────────────
  const gitRepoAt = (name: string) => {
    const repo = join(stage, name);
    mkdirSync(repo, { recursive: true });
    const git = (args: string[], at?: Date) => execFileSync("git", ["-C", repo, ...args], {
      env: { ...process.env, ...(at ? { GIT_AUTHOR_DATE: iso(at), GIT_COMMITTER_DATE: iso(at) } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "t@t"]);
    git(["config", "user.name", "t"]);
    const commit = (rel: string, content: string, at: Date, message = rel) => {
      mkdirSync(join(repo, rel, ".."), { recursive: true });
      writeFileSync(join(repo, rel), content);
      git(["add", rel]);
      git(["commit", "-q", "-m", message], at);
    };
    return { repo, git, commit, root: { path: repo, branch: "main", gitRepo: true, source: "repo" as const, repo, projectId: name } };
  };

  // 4a. 合并时把冲突解成了别人那一版：合并提交默认不列路径，按时间只找得到 A 的那次提交。
  const merge = gitRepoAt("merge");
  await db.insert(projects).values({ id: "merge", name: "merge", repoPath: merge.repo, createdAt: iso(T) });
  merge.commit("a/v.html", "base", minutes(T, -120));
  merge.git(["checkout", "-q", "-b", "side"]);
  merge.commit("a/v.html", "B version", minutes(T, -60));
  merge.git(["checkout", "-q", "main"]);
  await runTask("MergeA000006", T, minutes(T, 40), merge.repo, "merge");
  merge.commit("a/v.html", "A version", minutes(T, 5));
  try {
    merge.git(["merge", "-q", "--no-edit", "side"], minutes(T, 20));
  } catch {
    // 冲突是预期内的：手工解成 B 那一版。
  }
  writeFileSync(join(merge.repo, "a/v.html"), "B version");
  merge.git(["add", "a/v.html"]);
  merge.git(["commit", "-q", "--no-edit"], minutes(T, 20));
  assert.equal(await conf("MergeA000006", "a/v.html", merge.root), "approx",
    "A 在区间里提交过这条路径，可磁盘上是合并时解成的 B 那一版：不能按「最晚那次是 A 的」认成确定");

  // 4b. 之后有人提交了另一版、日期却回拨到 A 开工之前。
  const back = gitRepoAt("backdated");
  await db.insert(projects).values({ id: "backdated", name: "backdated", repoPath: back.repo, createdAt: iso(T) });
  await runTask("BackA0000007", T, minutes(T, 40), back.repo, "backdated");
  back.commit("a/w.html", "A version", minutes(T, 5));
  back.commit("a/w.html", "replaced later", minutes(T, -100));
  utimesSync(join(back.repo, "a/w.html"), minutes(T, 10), minutes(T, 10));
  assert.equal(await conf("BackA0000007", "a/w.html", back.root), "approx",
    "磁盘上这份是回拨了日期的那次提交落下的：A 区间里那次提交替它作不了保");

  // 4c. 同一条路径先在精确区间、后在推断区间各提交一次，磁盘上是后一次那份。
  const mix = gitRepoAt("mixed");
  await db.insert(projects).values({ id: "mixed", name: "mixed", repoPath: mix.repo, createdAt: iso(T) });
  await runTask("MixA00000008", T, minutes(T, 20), mix.repo, "mixed");
  // 第二条会话没有逐回合记录：它的区间是从会话起止推断出来的（approx）。
  await db.insert(sessions).values({
    id: "s-MixA00000008-2", taskId: "MixA00000008", role: "main", agentType: "claude", executor: "claude",
    cwd: mix.repo, startedAt: iso(minutes(T, 30)), endedAt: iso(minutes(T, 40)), exitStatus: 0,
    cliSessionId: "cli-mix-2", commandLine: "claude -p", turnsStarted: 0, turnsBase: 0, turnsBaseApprox: false, turnsLost: 0,
  });
  mix.commit("c/z.html", "first", minutes(T, 5));
  mix.commit("c/z.html", "second", minutes(T, 35));
  assert.equal(await conf("MixA00000008", "c/z.html", mix.root), "approx",
    "磁盘上是推断区间里那次提交落下的：精确区间里另一版的提交不能替它作保");
  mix.commit("c/y.html", "only exact", minutes(T, 6));
  assert.equal(await conf("MixA00000008", "c/y.html", mix.root), "exact", "对照：磁盘上就是精确区间里那一版");

  console.log("✓ task writes: 写入记录按操作开始时刻记、乱序到达只往外扩");
  console.log("✓ task artifacts: 后来的说明不回头认领、隔壁目录写进来的也是对手、提交的内容要对得上磁盘这一份");
} finally {
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
