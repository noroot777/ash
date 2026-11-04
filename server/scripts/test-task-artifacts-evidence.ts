// 生成物归属的 git 那一半（非 git 共享目录那一半在 test-task-artifacts-concurrent.ts）。
//
// 共享仓库里的提交不自带归属：任务分支差异要核磁盘上这份是不是分支那一版；按时间找到的提交要核
// 磁盘上这份是其中哪一次落下的。按时间找到的提交在共享仓库里一律只是候选（谁提交的，时间证明
// 不了），区别只在卡片上说什么。这里钉：
//   1. 两个任务同时在主分支上提交：那一刻对方也在跑，点名；只有自己在跑时也只是候选；
//   2. 「它的提交动过这条路径」不等于「现在这份是它那一版」：之后被人提交改过、合并时解成了别人
//      那一版、回拨了日期的提交换了内容、同一条路径先在精确区间后在估出来的区间各提交一次——
//      都不能当成确定；
//   3. 任务分支差异只替分支那一版作保；
//   4. 亲手写下且一字未变的，在 git 仓库里一样直接认。
// 跑：npm -w server run test:task-artifacts-evidence
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseTmpDb, requireTmpDb } from "./tmp-db.js";

const tmp = mkdtempSync(join(tmpdir(), "ash-artifacts-evidence-"));
process.env.ASH_DB = join(tmp, "ash.db");
requireTmpDb("task-artifacts-evidence");
const stage = realpathSync(tmp);

try {
  const { db, ensureSchema } = await import("../src/db/index.js");
  await ensureSchema();
  const { projects, sessions, sessionTurns, tasks } = await import("../src/db/schema.js");
  const { recordTaskWrites } = await import("../src/task-writes.js");
  const { readTaskArtifacts } = await import("../src/task-artifacts.js");
  const { checkBranchVersions } = await import("../src/task-artifact-version.js");
  const { contentDigest } = await import("../src/file-digest.js");
  const iso = (at: Date) => at.toISOString();
  const minutes = (base: Date, n: number) => new Date(base.getTime() + n * 60 * 1000);
  const T = new Date(Date.now() - 3 * 60 * 60 * 1000);
  /** 第 k 个场景的起点。各场景错开两天：「那一刻还有没有别的任务在跑」问的是整台机器，不分仓库。 */
  const sceneAt = (k: number) => minutes(T, -k * 2 * 24 * 60);

  const runTask = async (id: string, start: Date, end: Date, dir: string, project: string, extra: Partial<typeof tasks.$inferInsert> = {}) => {
    await db.insert(tasks).values({
      id, projectId: project, title: id, body: "-", mode: "single", status: "done",
      agentType: "claude", useWorktree: false, createdAt: iso(start), updatedAt: iso(end), ...extra,
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
  /** 一个仓库：提交时可以指定提交时刻。 */
  const gitRepoAt = async (name: string) => {
    const repo = join(stage, name);
    mkdirSync(repo, { recursive: true });
    const git = (args: string[], at?: Date) => execFileSync("git", ["-C", repo, ...args], {
      env: { ...process.env, ...(at ? { GIT_AUTHOR_DATE: iso(at), GIT_COMMITTER_DATE: iso(at) } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "t@t"]);
    git(["config", "user.name", "t"]);
    const put = (rel: string, content: string) => {
      mkdirSync(join(repo, rel, ".."), { recursive: true });
      writeFileSync(join(repo, rel), content);
    };
    const commit = (rel: string, content: string, at: Date) => {
      put(rel, content);
      git(["add", rel]);
      git(["commit", "-q", "-m", rel], at);
    };
    await db.insert(projects).values({ id: name, name, repoPath: repo, createdAt: iso(T) });
    const root = { path: repo, branch: "main", gitRepo: true, source: "repo" as const, repo, projectId: name };
    const conf = async (id: string, rel: string) => {
      const got = await readTaskArtifacts(id, root, null);
      assert.equal(got.error, null, `${id} 读得通：${got.error}`);
      const hit = got.artifacts.find((artifact) => artifact.path === rel);
      return hit ? (hit.confidence === "exact" ? "exact" : hit.doubt ?? "approx") : null;
    };
    return { repo, git, put, commit, conf };
  };

  // ── 1. 两个任务同时在主分支上提交 ───────────────────────────────────────────
  const S0 = sceneAt(0);
  const both = await gitRepoAt("both");
  await runTask("GitA00000001", S0, minutes(S0, 40), both.repo, "both");
  await runTask("GitB00000002", minutes(S0, 10), minutes(S0, 50), both.repo, "both");
  both.commit("a/早.png", "A early", minutes(S0, 5));
  both.commit("a/out.png", "A out", minutes(S0, 20));
  both.commit("b/late.png", "B late", minutes(S0, 45));
  // B 在两边都在跑的时候改了 A 早先提交的图，还没提交。
  both.put("a/早.png", "B edit, not committed");
  utimesSync(join(both.repo, "a/早.png"), minutes(S0, 25), minutes(S0, 25));
  assert.equal(await both.conf("GitA00000001", "a/out.png"), "concurrent", "提交那一刻 B 也在：分不出是谁的");
  assert.equal(await both.conf("GitB00000002", "a/out.png"), "concurrent");
  assert.equal(await both.conf("GitB00000002", "b/late.png"), "timed", "A 收工之后只有 B 在跑：不点名，仍是候选");
  assert.equal(await both.conf("GitA00000001", "b/late.png"), null);
  assert.equal(await both.conf("GitA00000001", "a/早.png"), "concurrent", "现在这份是两边都在时改出来的未提交版本：按改动那一刻认");

  // ── 2. 「动过这条路径」不等于「现在这份是它那一版」 ──────────────────────────
  // 2a. A 收工之后被别人提交改过。
  const S1 = sceneAt(1);
  const after = await gitRepoAt("after");
  await runTask("AfterA000003", S1, minutes(S1, 40), after.repo, "after");
  after.commit("a/v.png", "A version", minutes(S1, 5));
  after.commit("a/v.png", "someone later", minutes(S1, 90));
  assert.equal(await after.conf("AfterA000003", "a/v.png"), "version", "现在这份不是 A 那次提交落下的：候选，也不从面板上抹掉");

  // 2b. 合并时把冲突解成了别人那一版：合并提交默认不列路径，按时间只找得到 A 的那次提交。
  const S2 = sceneAt(2);
  const merge = await gitRepoAt("merge");
  merge.commit("a/v.html", "base", minutes(S2, -120));
  merge.git(["checkout", "-q", "-b", "side"]);
  merge.commit("a/v.html", "B version", minutes(S2, -60));
  merge.git(["checkout", "-q", "main"]);
  await runTask("MergeA000004", S2, minutes(S2, 40), merge.repo, "merge");
  merge.commit("a/v.html", "A version", minutes(S2, 5));
  try {
    merge.git(["merge", "-q", "--no-edit", "side"], minutes(S2, 20));
  } catch {
    // 冲突是预期内的：手工解成 B 那一版。
  }
  merge.put("a/v.html", "B version");
  merge.git(["add", "a/v.html"]);
  merge.git(["commit", "-q", "--no-edit"], minutes(S2, 20));
  assert.equal(await merge.conf("MergeA000004", "a/v.html"), "version",
    "A 在区间里提交过这条路径，可磁盘上是合并时解成的 B 那一版：不能按「最晚那次是 A 的」认成确定");

  // 2c. 之后有人提交了另一版、日期却回拨到 A 开工之前。
  const S3 = sceneAt(3);
  const back = await gitRepoAt("backdated");
  await runTask("BackA0000005", S3, minutes(S3, 40), back.repo, "backdated");
  back.commit("a/w.html", "A version", minutes(S3, 5));
  back.commit("a/w.html", "replaced later", minutes(S3, -100));
  utimesSync(join(back.repo, "a/w.html"), minutes(S3, 10), minutes(S3, 10));
  assert.equal(await back.conf("BackA0000005", "a/w.html"), "version", "磁盘上这份是回拨了日期的那次提交落下的");

  // 2d. 同一条路径先在精确区间、后在估出来的区间各提交一次，磁盘上是后一次那份。
  const S4 = sceneAt(4);
  const mix = await gitRepoAt("mixed");
  await runTask("MixA00000006", S4, minutes(S4, 20), mix.repo, "mixed");
  // 第二条会话没有逐回合记录：它的区间是从会话起止推断出来的。
  await db.insert(sessions).values({
    id: "s-MixA00000006-2", taskId: "MixA00000006", role: "main", agentType: "claude", executor: "claude",
    cwd: mix.repo, startedAt: iso(minutes(S4, 30)), endedAt: iso(minutes(S4, 40)), exitStatus: 0,
    cliSessionId: "cli-mix-2", commandLine: "claude -p", turnsStarted: 0, turnsBase: 0, turnsBaseApprox: false, turnsLost: 0,
  });
  mix.commit("c/z.html", "first", minutes(S4, 5));
  mix.commit("c/z.html", "second", minutes(S4, 35));
  assert.equal(await mix.conf("MixA00000006", "c/z.html"), "estimated", "磁盘上是估出来的区间里那次提交落下的");
  mix.commit("c/y.html", "only exact", minutes(S4, 6));
  assert.equal(await mix.conf("MixA00000006", "c/y.html"), "timed", "对照：磁盘上就是精确区间里那一版——不是「后来被改过」也不是「时间是估的」");

  // ── 3. 任务分支差异只替分支那一版作保 ───────────────────────────────────────
  // 任务的 worktree 清理掉了、分支还在，面板退回主仓展示。主仓里这条路径后来被提交成了另一版。
  const S5 = sceneAt(5);
  const branch = await gitRepoAt("branchrepo");
  branch.commit("README.md", "base", minutes(S5, -10));
  branch.git(["checkout", "-q", "-b", "ash/Branch00"]);
  branch.put("a/report.html", "<p>A version</p>");
  branch.put("a/keep.png", "keep");
  branch.git(["add", "."]);
  branch.git(["commit", "-q", "-m", "A"]);
  branch.git(["checkout", "-q", "main"]);
  branch.put("a/report.html", "<p>B version</p>");
  branch.put("a/keep.png", "keep");
  branch.git(["add", "."]);
  branch.git(["commit", "-q", "-m", "B"], minutes(S5, -5));
  await runTask("Branch000007", S5, minutes(S5, 30), branch.repo, "branchrepo", { mergeTargetBranch: "main" });
  assert.equal(await branch.conf("Branch000007", "a/keep.png"), "exact", "磁盘上这份就是分支那一版：分支证明照旧成立");
  assert.equal(await branch.conf("Branch000007", "a/report.html"), "version", "磁盘上是别人提交的另一版：内容对不上就不能算确定");
  // 三态，且一个读不出来的（不存在）不连累同批的其它文件。
  assert.deepEqual(
    Object.fromEntries(await checkBranchVersions(branch.repo, "", "ash/Branch00", ["a/keep.png", "a/report.html", "a/gone.png"])),
    { "a/keep.png": "match", "a/report.html": "mismatch", "a/gone.png": "unknown" },
  );

  // ── 4. 亲手写下的，在 git 仓库里一样直接认 ───────────────────────────────────
  // 两个任务同时在跑，A 亲手写了一份网页并提交：提交那一刻 B 在场，但内容就是 A 写下的那份。
  const S6 = sceneAt(6);
  const hand = await gitRepoAt("hand");
  await runTask("HandA0000008", S6, minutes(S6, 40), hand.repo, "hand");
  await runTask("HandB0000009", S6, minutes(S6, 40), hand.repo, "hand");
  hand.put("site/index.html", "<p>A wrote this</p>");
  const abs = join(hand.repo, "site/index.html");
  await recordTaskWrites("HandA0000008", "s-HandA0000008", { kind: "writes", paths: [abs], digests: { [abs]: contentDigest("<p>A wrote this</p>")! } }, iso(minutes(S6, 10)));
  hand.git(["add", "site/index.html"]);
  hand.git(["commit", "-q", "-m", "site"], minutes(S6, 12));
  assert.equal(await hand.conf("HandA0000008", "site/index.html"), "exact", "亲手写下、一字未变：不问那一刻还有谁");
  assert.equal(await hand.conf("HandB0000009", "site/index.html"), null, "现在这份正是 A 亲手写下的：B 那边不列");

  console.log("✓ task artifacts(git): 按时间找到的提交都是候选（同时在跑的点名）；内容不是它那一版的标「后来被改过」；分支证明核版本；亲手写下的直接认");
} finally {
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
