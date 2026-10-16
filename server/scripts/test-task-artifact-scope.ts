// 产物面板的**归属证据**（server/src/task-artifact-{scope,windows,paths}.ts）。
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
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
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
  await addSession("s-resume", "ResumeTask01", shared, 0, 250, { turnStartedAt: iso(240), turnsStarted: 2, activeMs: 20 * 60 * 1000 });
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

  // 没有回合记录的老会话（这张表建立之前的行）只能退回整条寿命：宽，但不能漏——而且**必须
  // 说出来**。缺记录既不能当成「这段时间它一直在跑」（那就串图），也不能当成「它没跑过」
  // （那就整页空着），只能当成「这段算不准」并在面板上明说（第 2 轮审查 F1）。
  await addTask("LegacyTask01");
  await addSession("s-legacy", "LegacyTask01", shared, 0, 250);
  const legacy = await read("LegacyTask01");
  assert.equal(
    originOf(legacy, "output/间隔期别人做的.png"), "ignored",
    "没有回合记录时退回会话寿命（刻意从宽：老数据宁可多认，不能把它自己的产物漏掉）",
  );
  assert.ok(
    legacy.incomplete.some((line) => line.includes("没有逐回合记录")),
    "退回会话寿命这件事必须披露：面板上得看出来「这几段算不准」",
  );
  assert.deepEqual(resumed.incomplete, [], "记录齐全的续聊不该白说一句「算不准」");

  // 最后一个回合没落账（异常退出、被停、写库失败都这样）：会话行上的 turn_started_at 比
  // 所有落账记录都晚，这个缺口要补出来并披露。读成「没跑过」会把那一回合真做出来的东西
  // 静默滤掉，面板空着还什么都不说（第 2 轮审查 F1）。
  await addTask("CutShort001");
  await addSession("s-cut", "CutShort001", shared, 500, 530, { turnStartedAt: iso(520) });
  await addTurn("t-cut-1", "s-cut", "CutShort001", shared, 500, 510);
  write(shared, "output/末回合做出来的.png");
  touch(shared, "output/末回合做出来的.png", at(525));
  const cutShort = await read("CutShort001");
  assert.equal(
    originOf(cutShort, "output/末回合做出来的.png"), "ignored",
    "末回合没留下记录,不等于那一回合没跑过——它的产物不能被静默滤掉",
  );
  assert.ok(
    cutShort.incomplete.some((line) => line.includes("最后一个回合没留下记录")),
    "这一段是估出来的,面板上要说明",
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
  // 哨兵停了之后才出现的东西不算它的：那条记录自己写下了收尾时刻，那就是实测证据，不该
  // 再往后推十分钟去吃别人的产出（第 3 轮审查必须修 1）。
  write(shared, "output/哨兵停了之后出现的.png");
  touch(shared, "output/哨兵停了之后出现的.png", at(885));
  const withMonitor = await read("WorkerTask01");
  assert.equal(
    originOf(withMonitor, "output/哨兵渲染出来的.png"), "ignored",
    "回合结束不等于它所属的后台工作结束——哨兵的生命周期要算进去",
  );
  assert.equal(
    originOf(withMonitor, "output/哨兵停了之后出现的.png"), null,
    "哨兵已经记下了收尾时刻,那就是它的真实终点",
  );

  // ── F2：团队执行者共用领队的工作区,不能个个都说自己独占 ──────────────────────
  // 一个领队底下几个执行者默认都在领队那份 worktree 里干活。`isolatedWorkspaceOwner` 给
  // 它们的 owner 是**领队**，那只证明隔离于项目主仓,不证明隔离于兄弟执行者——按目录独占判,
  // 三页会显示同样的三张图,「按任务区分」在团队上整个失效(第 2 轮审查 F2)。
  const crewRoot = join(shared, ".worktrees", "LeadWithCrew");
  git(shared, ["worktree", "add", "-q", "-b", "ash/LeadWithCrew", crewRoot, "main"]);
  await addTask("LeadWithCrew", { mode: "team", useWorktree: true, status: "done" });
  await addSession("s-crew-lead", "LeadWithCrew", crewRoot, 600, 760, { turnStartedAt: iso(740) });
  await addTurn("t-crew-lead", "s-crew-lead", "LeadWithCrew", crewRoot, 740, 760);
  for (const [id, from, to] of [["CrewA000001", 600, 610], ["CrewB000001", 700, 710]] as const) {
    await addTask(id, { parentId: "LeadWithCrew", useWorktree: false });
    await addSession(`s-${id}`, id, crewRoot, from, to);
    await addTurn(`t-${id}`, `s-${id}`, id, crewRoot, from, to);
  }
  // 第三个执行者**紧接着** A 收工一分钟后开工：这一段原先被「每个回合末端一律加十分钟」
  // 吃掉，A 的清单里于是混进 C 的图，而两者压根没有并发（第 3 轮审查必须修 1）。
  await addTask("CrewC000001", { parentId: "LeadWithCrew", useWorktree: false });
  await addSession("s-CrewC000001", "CrewC000001", crewRoot, 611, 615, { turnsStarted: 1 });
  await addTurn("t-CrewC000001", "s-CrewC000001", "CrewC000001", crewRoot, 611, 615);
  write(crewRoot, "output/C 紧接着画的绿图.png");
  touch(crewRoot, "output/C 紧接着画的绿图.png", at(612));
  write(crewRoot, "output/A 先画的蓝图.png");
  touch(crewRoot, "output/A 先画的蓝图.png", at(605));
  write(crewRoot, "output/B 两小时后画的红图.png");
  touch(crewRoot, "output/B 两小时后画的红图.png", at(705));
  const crewRootArg = {
    path: crewRoot, branch: "ash/LeadWithCrew", gitRepo: true, source: "worktree" as const,
    repo: shared, projectId: "p",
  };
  const crewA = await read("CrewA000001", crewRootArg);
  const crewB = await read("CrewB000001", crewRootArg);
  assert.equal(crewA.scope, "shared", "跟着领队目录干活的执行者不独占那个目录");
  assert.equal(originOf(crewA, "output/A 先画的蓝图.png"), "ignored", "A 看得到自己画的");
  assert.equal(
    originOf(crewA, "output/B 两小时后画的红图.png"), null,
    "A 不该看到兄弟执行者两小时后画的——共用领队目录不是独占证据",
  );
  assert.equal(originOf(crewB, "output/B 两小时后画的红图.png"), "ignored", "B 看得到自己画的");
  assert.equal(originOf(crewB, "output/A 先画的蓝图.png"), null, "B 也不该看到 A 画的");
  // 紧接着那一位：A 收工在 610、C 开工在 611，隔一分钟。
  const crewC = await read("CrewC000001", crewRootArg);
  assert.equal(originOf(crewC, "output/C 紧接着画的绿图.png"), "ignored", "C 看得到自己画的");
  assert.equal(
    originOf(crewA, "output/C 紧接着画的绿图.png"), null,
    "A 收工一分钟后 C 才开工,两者没有并发:落账过的回合是实测区间,末端不该白给十分钟",
  );
  assert.equal(originOf(crewC, "output/A 先画的蓝图.png"), null, "C 也不该看到 A 画的");
  assert.deepEqual(crewA.incomplete, [], "记录齐全、区间精确,不该有「算不准」的提示");
  // 领队那一页的语义本来就是整组汇总：它独占那个目录，两张都该在。
  const lead = await read("LeadWithCrew", crewRootArg);
  assert.equal(lead.scope, "exclusive");
  assert.equal(originOf(lead, "output/A 先画的蓝图.png"), "ignored", "领队页面汇总整组");
  assert.equal(originOf(lead, "output/B 两小时后画的红图.png"), "ignored", "领队页面汇总整组");

  // ── F2 的另一半：路径别名不能把同一个目录判成两个 ────────────────────────────
  // macOS 的 /var、/tmp 都是软链。会话记 `/var/…`、git 报 `/private/var/…` 时纯字符串比较
  // 会把独占目录降级成共享、重新吃上时间上限，第 1 轮 F3 修好的延迟产物又漏回去。
  await addTask("AliasTask01", { useWorktree: true });
  const aliasRoot = join(shared, ".worktrees", "AliasTask01");
  git(shared, ["worktree", "add", "-q", "-b", "ash/AliasTask01", aliasRoot, "main"]);
  await addSession("s-alias", "AliasTask01", aliasRoot, 800, 810);
  await addTurn("t-alias", "s-alias", "AliasTask01", aliasRoot, 800, 810);
  write(aliasRoot, "output/收尾很久之后渲染出来的.png");
  touch(aliasRoot, "output/收尾很久之后渲染出来的.png", at(900));
  // 真实的错位长这样：`repo` 是 git 报出来的（走过真身），而 `path` 来自会话 cwd（原样记下来
  // 的）。纯字符串比 `<repo>/.worktrees/<id>` 跟 `path`，同一个目录会被判成两个。
  //
  // 这里**自己造一个软链**指向仓库，不去依赖宿主 TMPDIR 恰好是 `/var`→`/private/var` 那种
  // 布局：TMPDIR 本来就是真实路径时（Linux 常见、macOS 也可以配），拿 `realpathSync(stage)`
  // 跟原值比会相等，于是即便功能完全正确，整个用例也会失败（第 3 轮审查 N2）。
  const sharedLink = join(stage, "shared-link");
  symlinkSync(shared, sharedLink, "dir");
  const aliased = await read("AliasTask01", {
    path: join(sharedLink, ".worktrees", "AliasTask01"), branch: "ash/AliasTask01", gitRepo: true,
    source: "worktree" as const, repo: realpathSync(shared), projectId: "p",
  });
  assert.notEqual(
    join(sharedLink, ".worktrees", "AliasTask01"), aliasRoot,
    "这条用例的前提：两个字符串不同、指向同一个目录（软链由夹具自己建，不靠宿主布局）",
  );
  assert.equal(aliased.scope, "exclusive", "软链别名指的是同一个目录，独占判据不能被它骗过去");
  assert.equal(
    originOf(aliased, "output/收尾很久之后渲染出来的.png"), "ignored",
    "独占目录不设时间上限：别名判错会让它重新吃上限,延迟产物又漏掉",
  );

  // ── N2：工作目录**自己**就是浏览器 profile ───────────────────────────────────
  const profileRoot = join(stage, "profile-root");
  initRepo(profileRoot, ["*.png", ""].join("\n"));
  write(profileRoot, "Local State", "{}");
  write(profileRoot, "Default/Preferences", "{}");
  write(profileRoot, "Default/Extensions/abc/icon_16.png");
  touch(profileRoot, "Default/Extensions/abc/icon_16.png", at(305));
  git(profileRoot, ["add", "-A"]);
  git(profileRoot, ["commit", "-qm", "profile"], { GIT_AUTHOR_DATE: iso(-600), GIT_COMMITTER_DATE: iso(-600) });
  await db.insert(projects).values({ id: "p-profile", name: "profile", repoPath: profileRoot, createdAt: iso(0) });
  await addTask("ProfileRoot1", { projectId: "p-profile" });
  await addSession("s-profile", "ProfileRoot1", profileRoot, 300, 310);
  await addTurn("t-profile", "s-profile", "ProfileRoot1", profileRoot, 300, 310);
  const atProfile = await read("ProfileRoot1", {
    path: profileRoot, branch: "main", gitRepo: true, source: "repo" as const,
    repo: profileRoot, projectId: "p-profile",
  });
  assert.equal(
    originOf(atProfile, "Default/Extensions/abc/icon_16.png"), null,
    "工作目录自己就是 profile 时,祖先查到 Default 就停了——根上那两个标志也得问",
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

  // ── N4：committer date 沿历史不单调时,`--since` 的遍历剪枝会把区间内的提交整条剪掉 ──
  // rebase、cherry-pick、改过系统时间都会让日期回拨。`--since` 是遍历边界，碰到更早的提交
  // 就停；于是祖先里真正落在运行区间里的那条提交一个字都出不来，而且不触发任何额度提示，
  // 跟「本来就没有」长得一模一样。`--since-as-filter`（git 2.37+）把它降级成输出过滤器。
  let sinceAsFilter = true;
  try {
    git(shared, ["log", "--since-as-filter=1970-01-01", "--max-count=0"]);
  } catch {
    sinceAsFilter = false;
  }
  await addTask("OutOfOrder1");
  await addSession("s-ooo", "OutOfOrder1", shared, 1200, 1210);
  await addTurn("t-ooo", "s-ooo", "OutOfOrder1", shared, 1200, 1210);
  write(shared, "art/区间内提交的.png");
  git(shared, ["add", "art/区间内提交的.png"]);
  git(shared, ["commit", "-qm", "区间内"], { GIT_AUTHOR_DATE: iso(1205), GIT_COMMITTER_DATE: iso(1205) });
  write(shared, "art/日期回拨到更早的.png");
  git(shared, ["add", "art/日期回拨到更早的.png"]);
  git(shared, ["commit", "-qm", "日期回拨"], { GIT_AUTHOR_DATE: iso(-900), GIT_COMMITTER_DATE: iso(-900) });
  const outOfOrder = await read("OutOfOrder1");
  if (sinceAsFilter) {
    assert.equal(
      originOf(outOfOrder, "art/区间内提交的.png"), "committed",
      "后一个提交把日期回拨到区间之前,也不该把区间内的提交整条剪掉",
    );
  } else {
    assert.ok(
      outOfOrder.incomplete.some((line) => line.includes("按提交日期截断遍历")),
      "这台机器的 git 不支持 --since-as-filter,那就必须如实说这一档可能漏",
    );
  }

  // ── 必须修 2：中间那一轮没落账,不能被后来成功的那条记录盖掉 ──────────────────
  // 三轮运行、第二轮的 `recordTurnSpan` 写失败：库里只剩第一和第三轮。两头都对得上
  //（最早贴着会话起点、最新等于 turn_started_at），原先据此判「历史完整」，第二轮做出来的
  // 东西于是被静默滤掉、面板空着还什么都不说。会话行上的 `turns_started` 才是权威计数。
  await addTask("GapMid00001");
  await addSession("s-gapmid", "GapMid00001", shared, 1000, 1250, { turnStartedAt: iso(1240), turnsStarted: 3 });
  await addTurn("t-gapmid-1", "s-gapmid", "GapMid00001", shared, 1000, 1010);
  await addTurn("t-gapmid-3", "s-gapmid", "GapMid00001", shared, 1240, 1250);
  write(shared, "output/中间那轮做出来的.png");
  touch(shared, "output/中间那轮做出来的.png", at(1125));
  const gapMid = await read("GapMid00001");
  assert.equal(
    originOf(gapMid, "output/中间那轮做出来的.png"), "ignored",
    "中间缺了一轮记录,那一轮的产物不能被静默滤掉",
  );
  assert.ok(
    gapMid.incomplete.some((line) => line.includes("没在库里留下记录")),
    "缺了几轮就说几轮:这段是按整条会话兜出来的,算不准要明说",
  );
  assert.ok(
    gapMid.incomplete.some((line) => line.includes("按估出来的时间段认的")),
    "靠推断区间认进来的条目要单独说一句:它们是候选,不能跟实测的混在一起不说话",
  );

  // 在飞的任务**照样要查**早期缺口：续聊一进来就跳过检查，历史上的不确定会凭空消失一阵。
  await addTask("LiveEarly01", { status: "running" });
  await addSession("s-liveearly", "LiveEarly01", shared, 1300, null, { turnStartedAt: iso(1400), turnsStarted: 2 });
  await addTurn("t-liveearly", "s-liveearly", "LiveEarly01", shared, 1400, 1410);
  const liveEarly = await read("LiveEarly01");
  assert.ok(
    liveEarly.incomplete.length > 0,
    "在飞不等于历史清白:早期那段没有记录,仍然要说出来",
  );

  // 同一条会话**换过工作目录**（旧目录还在）：完整性是会话自己的属性，不能因为本目录上只
  // 剩一条回合就当成「这个目录缺了历史」去放宽清单。
  await addTask("MovedTask01");
  const movedAway = join(shared, ".worktrees", "MovedTask01");
  git(shared, ["worktree", "add", "-q", "-b", "ash/MovedTask01", movedAway, "main"]);
  await addSession("s-moved", "MovedTask01", shared, 1500, 1560, { turnStartedAt: iso(1550), turnsStarted: 2 });
  await addTurn("t-moved-1", "s-moved", "MovedTask01", movedAway, 1500, 1510);
  await addTurn("t-moved-2", "s-moved", "MovedTask01", shared, 1550, 1560);
  write(shared, "output/它在别处跑那会儿主仓里出现的.png");
  touch(shared, "output/它在别处跑那会儿主仓里出现的.png", at(1520));
  const moved = await read("MovedTask01");
  assert.equal(
    originOf(moved, "output/它在别处跑那会儿主仓里出现的.png"), null,
    "那一回合在别的目录跑,这个目录上那会儿出现的东西不是它的",
  );
  assert.deepEqual(moved.incomplete, [], "回合一条不缺,只是有一条在别的目录——不是缺口");

  // ── N1：同一进程内软链换了指向,不能沿用上一次的独占结论 ──────────────────────
  const swing = join(stage, "swing");
  symlinkSync(aliasRoot, swing, "dir");
  const swingRoot = (branch: string) => ({
    path: swing, branch, gitRepo: true, source: "worktree" as const,
    repo: realpathSync(shared), projectId: "p",
  });
  assert.equal((await read("AliasTask01", swingRoot("ash/AliasTask01"))).scope, "exclusive");
  rmSync(swing);
  symlinkSync(shared, swing, "dir"); // 同一个字符串,现在指向共享主仓
  assert.equal(
    (await read("AliasTask01", swingRoot("main"))).scope, "shared",
    "路径到真身的映射会变:独占凭据必须来自这一次解析,不能吃进程里缓存的旧答案",
  );

  // ── N5：新表要进任务删除的原子批 ────────────────────────────────────────────
  // 不进去就会攒下无主的回合行：建删几轮之后，库里全是没人认领的区间。
  const { deleteTaskCompletely } = await import("../src/task-delete-routes.js");
  await deleteTaskCompletely("CutShort001");
  assert.deepEqual(
    await db.select().from(sessionTurns).where(eq(sessionTurns.taskId, "CutShort001")), [],
    "任务删掉之后不该留下它的回合记录",
  );

  console.log("✓ artifact scope: 续聊区间按回合落账、没跑过就没有产物、独占目录不吃时间、提交按段取数");
  console.log("✓ artifact scope: 特殊文件名、profile 深路径入口、venv 边界、上游异地区间、哨兵生命周期");
  console.log("✓ artifact scope: 同仓异目录(worktree 已删)的区间要认、任务分支 diff 不吃时间门槛");
  console.log("✓ artifact scope: 团队执行者各看各的/领队汇总、软链别名同目录、工作目录自己是 profile");
  console.log("✓ artifact scope: 紧接着开工的执行者不串图、中间缺的那轮要认且披露、在飞也查早期缺口");
  console.log("✓ artifact scope: 换过工作目录不算缺口、软链改指向后重新解析独占");
  console.log(`✓ artifact scope: 提交日期回拨不剪掉区间内的提交（--since-as-filter ${sinceAsFilter ? "可用" : "不可用,已披露"}）、删任务清掉回合记录`);
} finally {
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
