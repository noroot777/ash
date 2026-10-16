// 产物面板的**归属证据**（server/src/task-artifact-scope.ts）。
//
// 上一个文件（test-task-artifacts.ts）钉的是「三档各自认得对不对」；这一个钉的是**凭什么
// 算这个任务的**，也就是第 1 轮审查打回来的那四条：
//   F1 会话行跨回合复用，拿它的寿命当运行区间，续聊的任务会把两次运行之间别人做的东西
//      全收进自己名下；
//   F2 共享目录上 git status 不是归属证明，一次都没跑过的任务不该有任何产物；
//   F3 独占 worktree 不该吃时间上限，哨兵起的后台渲染会在回合收尾很久之后才落盘；
//   F4 已提交那一档要按**每段真实区间**取数，不是取它们的外包络。
// 另外钉住 N1（特殊文件名）、N2（profile 的深路径入口）、N3（venv.png 不是虚拟环境）、
// N4（上游在别的目录跑过的区间不算）。
// 跑：npm -w server run test:artifact-scope
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-artifact-scope-"));
process.env.ASH_DB = join(stage, "ash.db");
requireTmpDb("task-artifact-scope");

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const git = (root: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
const write = (root: string, path: string, body: string | Buffer = png) => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), body);
};
const touch = (root: string, path: string, at: Date) => utimesSync(join(root, path), at, at);
const initRepo = (root: string, ignore: string) => {
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "Scope test"]);
  git(root, ["config", "user.email", "scope@example.test"]);
  git(root, ["config", "commit.gpgSign", "false"]);
  git(root, ["config", "core.hooksPath", join(stage, "hooks")]);
  write(root, ".gitignore", ignore);
};

/** 相对基准时刻的分钟偏移——所有场景都用「T0 + n 分钟」描述，读起来才像时间线。 */
const T0 = new Date(Date.now() - 12 * 60 * 60 * 1000);
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60 * 1000);
const iso = (minutes: number) => at(minutes).toISOString();

try {
  mkdirSync(join(stage, "hooks"), { recursive: true });
  const shared = join(stage, "shared");
  initRepo(shared, [
    "output/", "node_modules/",
    "venv.png",        // 单个文件被忽略：它是一张图，不是虚拟环境目录（N3）
    "venv-report/",    // 正经目录，只是名字以 venv 开头（N3）
    "Extensions/",     // 无前导斜杠 → 匹配任意层级，git 会直接吐出 profile 深处那一层（N2）
    "",
  ].join("\n"));
  write(shared, "art/底图.png");
  git(shared, ["add", "."]);
  git(shared, ["commit", "-qm", "base"], {
    GIT_AUTHOR_DATE: iso(-600), GIT_COMMITTER_DATE: iso(-600),
  });

  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, sessionTurns, sessions, tasks } = await import("../src/db/schema.js");
  const { readTaskArtifacts } = await import("../src/task-artifacts.js");
  const { worktreeBranchName } = await import("../src/git.js");
  await ensureSchema();

  await db.insert(projects).values({ id: "p", name: "shared", repoPath: shared, createdAt: iso(0) });
  const addTask = (id: string, extra: Record<string, unknown> = {}) => db.insert(tasks).values({
    id, projectId: "p", title: id, body: "-", mode: "single", status: "done",
    agentType: "claude", useWorktree: false, createdAt: iso(0), updatedAt: iso(0), ...extra,
  });
  const addSession = (id: string, taskId: string, cwd: string, startedAt: number, endedAt: number | null, extra: Record<string, unknown> = {}) =>
    db.insert(sessions).values({
      id, taskId, role: "main", agentType: "claude", executor: "claude", cwd,
      startedAt: iso(startedAt), endedAt: endedAt === null ? null : iso(endedAt), exitStatus: 0, ...extra,
    });
  const addTurn = (id: string, sessionId: string, taskId: string, cwd: string | null, from: number, to: number) =>
    db.insert(sessionTurns).values({ id, sessionId, taskId, cwd, startedAt: iso(from), endedAt: iso(to) });

  const sharedRoot = {
    path: shared, branch: "main", gitRepo: true, source: "repo" as const, repo: shared, projectId: "p",
  };
  const read = async (taskId: string, root = sharedRoot) => {
    const got = await readTaskArtifacts(taskId, root);
    assert.equal(got.error, null, `${taskId}: 三路线索都该读得通`);
    return got;
  };
  const originOf = (got: { artifacts: { path: string; origin: string }[] }, path: string) =>
    got.artifacts.find((artifact) => artifact.path === path)?.origin ?? null;

  // ── F1：续聊的任务,两次运行之间是别人的东西 ────────────────────────────────
  // 一条会话行跨回合复用：startedAt 停在第一次建立，endedAt 只记最后一次收尾。拿它当
  // 运行区间，中间空的那四个钟头会连成一片。真实区间来自 session_turns。
  await addTask("ResumeTask01");
  await addSession("s-resume", "ResumeTask01", shared, 0, 250, { turnStartedAt: iso(240), activeMs: 20 * 60 * 1000 });
  await addTurn("t-resume-1", "s-resume", "ResumeTask01", shared, 0, 10);
  await addTurn("t-resume-2", "s-resume", "ResumeTask01", shared, 240, 250);

  write(shared, "output/第一回合.png");
  touch(shared, "output/第一回合.png", at(5));
  write(shared, "output/第二回合.png");
  touch(shared, "output/第二回合.png", at(245));
  write(shared, "output/间隔期别人做的.png");
  touch(shared, "output/间隔期别人做的.png", at(120));

  const resumed = await read("ResumeTask01");
  assert.equal(originOf(resumed, "output/第一回合.png"), "ignored", "第一个回合的产出要认");
  assert.equal(originOf(resumed, "output/第二回合.png"), "ignored", "第二个回合的产出也要认");
  assert.equal(
    originOf(resumed, "output/间隔期别人做的.png"), null,
    "两次运行之间别人做的东西不是它的——会话寿命不是运行区间",
  );
  assert.equal(resumed.scope, "shared");

  // 没有回合记录的老会话（这张表建立之前的行）只能退回整条寿命：宽，但不能漏。
  await addTask("LegacyTask01");
  await addSession("s-legacy", "LegacyTask01", shared, 0, 250);
  const legacy = await read("LegacyTask01");
  assert.equal(
    originOf(legacy, "output/间隔期别人做的.png"), "ignored",
    "没有回合记录时退回会话寿命（刻意从宽：老数据宁可多认，不能把它自己的产物漏掉）",
  );

  // ── F2：一次都没跑过的任务,不该有任何产物 ──────────────────────────────────
  write(shared, "draft/别人正在改的.png"); // 未跟踪 → git status 看得见，但它不属于任何任务
  await addTask("NeverRun001", { status: "backlog" });
  const never = await read("NeverRun001");
  assert.deepEqual(never.artifacts, [], "没跑过就没有归属证据，git status 不是归属证明");
  assert.equal(never.since, null);

  // 跑过的任务仍然能看到自己运行期间的未提交改动（上面那条别误伤这一条）。
  await addTask("WorkingTask1");
  await addSession("s-working", "WorkingTask1", shared, 300, 310);
  await addTurn("t-working", "s-working", "WorkingTask1", shared, 300, 310);
  write(shared, "draft/它自己改的.png");
  touch(shared, "draft/它自己改的.png", at(305));
  const working = await read("WorkingTask1");
  assert.equal(originOf(working, "draft/它自己改的.png"), "working");
  assert.equal(
    originOf(working, "draft/别人正在改的.png"), null,
    "共享目录上的未提交改动也要落在它的运行区间里",
  );

  // ── F4 / N1：已提交那一档按每段区间取数,且认得住带引号的文件名 ──────────────
  write(shared, 'art/版本"最终.png');
  git(shared, ["add", "-A", "art"]);
  git(shared, ["commit", "-qm", "区间内提交"], {
    GIT_AUTHOR_DATE: iso(302), GIT_COMMITTER_DATE: iso(302),
  });
  write(shared, "art/区间之外提交的.png");
  git(shared, ["add", "-A", "art"]);
  git(shared, ["commit", "-qm", "区间外提交"], {
    GIT_AUTHOR_DATE: iso(400), GIT_COMMITTER_DATE: iso(400),
  });
  const committed = await read("WorkingTask1");
  assert.equal(
    originOf(committed, 'art/版本"最终.png'), "committed",
    "带引号的文件名也要认出来——git 的默认 name-only 会给它加转义，必须走 NUL 协议",
  );
  assert.equal(originOf(committed, "art/区间之外提交的.png"), null, "区间之外的提交不算它的");

  // 两段区间之间的提交同样不算（逐段核对，不是取外包络）。
  write(shared, "art/两段之间提交的.png");
  git(shared, ["add", "-A", "art"]);
  git(shared, ["commit", "-qm", "两段之间"], {
    GIT_AUTHOR_DATE: iso(120), GIT_COMMITTER_DATE: iso(120),
  });
  const resumedAgain = await read("ResumeTask01");
  assert.equal(
    originOf(resumedAgain, "art/两段之间提交的.png"), null,
    "已提交那一档也要按每段真实区间认，取外包络会把间隔期的提交收进来",
  );

  // ── N2 / N3：profile 的深路径入口、以及名字像虚拟环境的正常文件 ─────────────
  write(shared, "browser-profile/Local State", "{}");
  write(shared, "browser-profile/Default/Extensions/icon_16.png");
  touch(shared, "browser-profile/Default/Extensions/icon_16.png", at(305));
  write(shared, "venv.png");
  touch(shared, "venv.png", at(305));
  write(shared, "venv-report/覆盖率.png");
  touch(shared, "venv-report/覆盖率.png", at(305));
  const dirs = await read("WorkingTask1");
  assert.equal(
    originOf(dirs, "browser-profile/Default/Extensions/icon_16.png"), null,
    "忽略规则把入口折到 profile 内部时，也要认出它在 profile 里（按祖先找标志）",
  );
  assert.equal(originOf(dirs, "venv.png"), "ignored", "venv.png 是一张图，不是虚拟环境目录");
  assert.equal(originOf(dirs, "venv-report/覆盖率.png"), "ignored", "名字以 venv 开头的正常目录不该被挡");

  // ── F3：独占 worktree 不吃时间上限 ────────────────────────────────────────
  const exclusiveId = "Exclusive001";
  await addTask(exclusiveId, { useWorktree: true, mergeTargetBranch: "main" });
  git(shared, ["worktree", "add", "-q", "-b", worktreeBranchName(exclusiveId), join(shared, ".worktrees", exclusiveId), "main"]);
  const worktree = join(shared, ".worktrees", exclusiveId);
  await addSession("s-exclusive", exclusiveId, worktree, 500, 501);
  await addTurn("t-exclusive", "s-exclusive", exclusiveId, worktree, 500, 501);
  // 哨兵起的后台渲染：回合第 501 分钟就收尾了，它第 525 分钟才写出来。
  write(worktree, "output/后台渲染.png");
  touch(worktree, "output/后台渲染.png", at(525));
  const exclusiveRoot = {
    path: worktree, branch: worktreeBranchName(exclusiveId), gitRepo: true,
    source: "session" as const, repo: shared, projectId: "p",
  };
  const exclusive = await read(exclusiveId, exclusiveRoot);
  assert.equal(exclusive.scope, "exclusive", "任务自己的 worktree 就是归属证据");
  assert.equal(
    originOf(exclusive, "output/后台渲染.png"), "ignored",
    "独占目录不设时间上限：后台渲染在回合收尾二十多分钟后落盘，照样是它做的",
  );

  // ── N4：上游在别的目录跑过的那些区间,不算在这个目录头上 ─────────────────────
  const other = join(stage, "other-dir");
  mkdirSync(other, { recursive: true });
  await addTask("LeadTask0001", { mode: "team", status: "done" });
  await addSession("s-lead", "LeadTask0001", other, 600, 700);
  await addTurn("t-lead", "s-lead", "LeadTask0001", other, 600, 700);
  await addTask("WorkerTask01", { parentId: "LeadTask0001" });
  await addSession("s-worker", "WorkerTask01", shared, 800, 810);
  await addTurn("t-worker", "s-worker", "WorkerTask01", shared, 800, 810);
  write(shared, "output/领队在别处跑的时候出现的.png");
  touch(shared, "output/领队在别处跑的时候出现的.png", at(650));
  write(shared, "output/执行者自己做的.png");
  touch(shared, "output/执行者自己做的.png", at(805));
  const worker = await read("WorkerTask01");
  assert.equal(originOf(worker, "output/执行者自己做的.png"), "ignored");
  assert.equal(
    originOf(worker, "output/领队在别处跑的时候出现的.png"), null,
    "领队那段时间在另一个目录干活，它的区间不该用来认这个目录里的东西",
  );

  // ── 哨兵的生命周期也算归属证据（共享目录上） ────────────────────────────────
  const { monitors } = await import("../src/db/schema-monitors.js");
  await db.insert(monitors).values({
    id: "m-worker", taskId: "WorkerTask01", command: "renderer", cwd: shared,
    status: "exited", logPath: join(stage, "m.log"),
    startedAt: iso(820), expiresAt: iso(900), endedAt: iso(880),
  });
  write(shared, "output/哨兵渲染出来的.png");
  touch(shared, "output/哨兵渲染出来的.png", at(870));
  const withMonitor = await read("WorkerTask01");
  assert.equal(
    originOf(withMonitor, "output/哨兵渲染出来的.png"), "ignored",
    "回合结束不等于它所属的后台工作结束——哨兵的生命周期要算进去",
  );

  // ── N4 的另一半：worktree 已经被删、面板降级到主仓展示时,那段区间还得认 ───────
  // 进程的 cwd 只证明它在哪儿启动，不证明它只往那儿写：有的流水线写死了绝对路径，cwd 在
  // worktree、产物落主仓；worktree 事后被删掉更是必然对不上。把 cwd 核对收紧到「同一个
  // 目录」会让这类任务三档一起空（真实库里几个任务全栽在这上头），所以判据是「同一个
  // 仓库」——跨仓那半边由上面的 N4 钉住，这半边钉住别再收紧。
  const goneWorktree = join(shared, ".worktrees", "GoneTask0001");
  await addTask("GoneTask0001", { useWorktree: true });
  await addSession("s-gone", "GoneTask0001", goneWorktree, 1000, 1030, { worktreePath: goneWorktree });
  await addTurn("t-gone", "s-gone", "GoneTask0001", goneWorktree, 1000, 1030);
  write(shared, "output/在已删worktree里跑时落到主仓的.png");
  touch(shared, "output/在已删worktree里跑时落到主仓的.png", at(1010));
  const gone = await read("GoneTask0001");
  assert.equal(
    originOf(gone, "output/在已删worktree里跑时落到主仓的.png"), "ignored",
    "cwd 记的是同一个仓库里那个已删的 worktree：那段区间照样是它在干活",
  );

  // 任务分支的 diff **自带归属**（分支名由 taskId 派生），跟它有没有留下运行区间无关：
  // 会话记录对不上、或者压根没留下（老任务、结算丢了收尾）时，这是唯一还拿得出来的证据，
  // 不能被按时间认的那道门槛一起挡掉。这里连一条会话都不给它。
  await addTask("BranchOnly01", { mergeTargetBranch: "main" });
  const branchOnly = worktreeBranchName("BranchOnly01");
  git(shared, ["checkout", "-q", "-b", branchOnly]);
  write(shared, "art/分支上提交的.png");
  git(shared, ["add", "art/分支上提交的.png"]);
  git(shared, ["commit", "-qm", "branch art"], { GIT_AUTHOR_DATE: iso(1100), GIT_COMMITTER_DATE: iso(1100) });
  const branchRead = await read("BranchOnly01");
  assert.equal(
    originOf(branchRead, "art/分支上提交的.png"), "committed",
    "有属于它的分支就够了：没有任何运行区间也要列出分支上提交的产物",
  );
  assert.equal(
    originOf(branchRead, "output/第一回合.png"), null,
    "分支 diff 自带归属不等于整个目录都归它：按时间认的那几档照样要有区间",
  );

  console.log("✓ artifact scope: 续聊区间按回合落账、没跑过就没有产物、独占目录不吃时间、提交按段取数");
  console.log("✓ artifact scope: 特殊文件名、profile 深路径入口、venv 边界、上游异地区间、哨兵生命周期");
  console.log("✓ artifact scope: 同仓异目录(worktree 已删)的区间要认、任务分支 diff 不吃时间门槛");
} finally {
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
