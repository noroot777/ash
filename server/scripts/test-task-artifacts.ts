// 「这个任务做出来了什么」的判据（server/src/task-artifacts.ts）。
//
// 这块逻辑全部的难点都在**认人**上——同一个目录里躺着三类文件，只有一类是这个任务的产物：
//   1. 仓库本来就有的图（被跟踪、没动过）：一个都不能进
//   2. 这个任务做的（提交了的 / 没提交的 / 被 .gitignore 挡着的）：三档都要进，且要报对
//   3. 依赖树里的图（node_modules 之类）：一个都不能进
// 其中最容易写错、也最没法靠手测发现的是**第 1 类靠 mtime 认会全军覆没**：建 worktree 是
// 一次检出，所有被跟踪的文件 mtime 都等于任务开跑那一刻。所以这里专门钉一条「仓库原有的
// 图，mtime 比任务开跑还新，照样不算产物」。
// 跑：npm -w server run test:task-artifacts
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-artifacts-"));
process.env.ASH_DB = join(stage, "ash.db");
requireTmpDb("task-artifacts");

const repo = join(stage, "repo");
const TASK_ID = "Art1FactTest";
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const gitIn = (root: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
const git = (...args: string[]) => gitIn(repo, args);
const writeIn = (root: string, path: string, body: string | Buffer = png) => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), body);
};
const write = (path: string, body: string | Buffer = png) => writeIn(repo, path, body);
/** 把某个文件的 mtime 挪到指定时刻——「任务开跑之前 / 之后写的」得能造出来。 */
const touchAtIn = (root: string, path: string, at: Date) => utimesSync(join(root, path), at, at);
const touchAt = (path: string, at: Date) => touchAtIn(repo, path, at);
/** 一个刚初始化好、带忽略规则的仓库——共享工作区那一段要在自己的仓库里造场景。 */
const initRepo = (root: string, ignore: string) => {
  mkdirSync(root, { recursive: true });
  gitIn(root, ["init", "-q", "-b", "main"]);
  gitIn(root, ["config", "user.name", "Artifacts test"]);
  gitIn(root, ["config", "user.email", "artifacts@example.test"]);
  gitIn(root, ["config", "commit.gpgSign", "false"]);
  gitIn(root, ["config", "core.hooksPath", join(stage, "hooks")]);
  writeIn(root, ".gitignore", ignore);
};

try {
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(stage, "hooks"), { recursive: true });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Artifacts test");
  git("config", "user.email", "artifacts@example.test");
  git("config", "commit.gpgSign", "false");
  git("config", "core.hooksPath", join(stage, "hooks"));

  // ── 基线：仓库本来就有的东西，一个都不该被认成产物 ────────────────────────
  // 基线提交要**落在任务开跑之前**：共享工作区上没有任务分支，已提交那一档只能按「落在
  // 运行区间里的提交」认，而一个此刻才做的基线提交当然落在「此刻开跑」的区间里。真实
  // 仓库的基线是几个月前的事，fixture 得照这个来，否则测的是一个不存在的场景。
  const baseDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  write(".gitignore", "output/\nnode_modules/\n*.tmp.png\n");
  write("assets/仓库原有.png");
  write("src/app.ts", "export const x = 1;\n");
  git("add", ".");
  gitIn(repo, ["commit", "-qm", "base"], { GIT_AUTHOR_DATE: baseDate, GIT_COMMITTER_DATE: baseDate });

  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, sessions, tasks } = await import("../src/db/schema.js");
  const { readTaskArtifacts } = await import("../src/task-artifacts.js");
  await ensureSchema();

  const startedAt = new Date();
  const before = new Date(startedAt.getTime() - 60 * 60 * 1000);
  const after = new Date(startedAt.getTime() + 60 * 1000);
  const stamp = startedAt.toISOString();
  await db.insert(projects).values({ id: "p", name: "artifacts", repoPath: repo, createdAt: stamp });
  await db.insert(tasks).values({
    id: TASK_ID, projectId: "p", title: "产物", body: "造点东西出来",
    mode: "single", status: "done", agentType: "claude",
    mergeTargetBranch: "main", createdAt: stamp, updatedAt: stamp,
  });
  await db.insert(sessions).values({
    id: "s1", taskId: TASK_ID, role: "main", agentType: "claude", executor: "claude",
    cwd: repo, startedAt: stamp,
  });

  const root = { path: repo, branch: "main", gitRepo: true, source: "repo" as const, repo, projectId: "p" };
  const read = async () => {
    const result = await readTaskArtifacts(TASK_ID, root);
    assert.equal(result.error, null, "三路线索都该读得通");
    return result;
  };
  const originOf = (result: { artifacts: { path: string; origin: string }[] }, path: string) =>
    result.artifacts.find((artifact) => artifact.path === path)?.origin ?? null;

  // 仓库原有的图 mtime 比任务开跑还新（worktree 检出就是这个效果），仍然不算产物。
  touchAt("assets/仓库原有.png", after);
  assert.deepEqual((await read()).artifacts, [], "任务什么都没做时，仓库原有的图一张都不该算产物");

  // ── 已提交在任务分支上 ────────────────────────────────────────────────────
  // 分支名由 taskId 派生（`worktreeBranchName`），不能在这儿手写一个：写死的名字跟约定
  // 一旦分家，测试会因为「分支不存在」而绿着跑过去，什么都没验到。
  const { worktreeBranchName } = await import("../src/git.js");
  git("checkout", "-qb", worktreeBranchName(TASK_ID));
  write("out/海报.png");
  write("out/页面.html", "<!doctype html><p>hi</p>");
  write("src/app.ts", "export const x = 2;\n");
  git("add", ".");
  git("commit", "-qm", "做了张图和一个页面");
  let result = await read();
  assert.equal(originOf(result, "out/海报.png"), "committed");
  assert.equal(originOf(result, "out/页面.html"), "committed");
  assert(!result.artifacts.some((a) => a.path === "src/app.ts"), "代码改动不是产物，那是「改动」面板的事");
  assert(!result.artifacts.some((a) => a.path === "assets/仓库原有.png"), "没在这条分支上动过的图仍然不算");

  // ── 还没提交 ──────────────────────────────────────────────────────────────
  write("out/草稿.png");                       // 未跟踪
  write("out/海报.png", Buffer.concat([png, png])); // 已跟踪、改过
  result = await read();
  assert.equal(originOf(result, "out/草稿.png"), "working");
  assert.equal(
    originOf(result, "out/海报.png"), "working",
    "既提交过又刚改过时报最靠近当下的那一档",
  );

  // ── 被 .gitignore 挡着 ────────────────────────────────────────────────────
  write("output/渲染.png");
  touchAt("output/渲染.png", after);
  write("output/上一轮.png");
  touchAt("output/上一轮.png", before);        // 任务开跑之前就在了
  write("output/nested/深一层.png");
  touchAt("output/nested/深一层.png", after);
  write("旧图.tmp.png");                        // 单文件被忽略（不是整个目录）
  touchAt("旧图.tmp.png", after);
  write("node_modules/pkg/logo.png");          // 依赖树，永远不进
  touchAt("node_modules/pkg/logo.png", after);
  result = await read();
  assert.equal(originOf(result, "output/渲染.png"), "ignored");
  assert.equal(originOf(result, "output/nested/深一层.png"), "ignored", "被忽略的目录要往里走");
  assert.equal(originOf(result, "旧图.tmp.png"), "ignored", "按模式忽略的单个文件也要认");
  assert.equal(originOf(result, "output/上一轮.png"), null, "任务开跑之前就在的，不是这一趟的产物");
  assert.equal(originOf(result, "node_modules/pkg/logo.png"), null, "依赖树里的图一张都不进");

  // ── 分类、排序、元信息 ────────────────────────────────────────────────────
  assert.equal(result.artifacts.find((a) => a.path === "out/页面.html")?.kind, "page");
  assert.equal(result.artifacts.find((a) => a.path === "out/海报.png")?.kind, "image");
  assert.equal(result.artifacts.find((a) => a.path === "out/海报.png")?.dir, "out");
  assert.equal(result.artifacts.find((a) => a.path === "out/海报.png")?.size, png.length * 2);
  const times = result.artifacts.map((a) => Date.parse(a.mtime ?? ""));
  assert.deepEqual(times, [...times].sort((a, b) => b - a), "新的排前面");
  assert.equal(result.since, stamp);

  // ── 删掉之后就该消失（清单里留着一个点开是 404 的条目比没有更糟） ──────────
  rmSync(join(repo, "out/草稿.png"));
  assert.equal(originOf(await read(), "out/草稿.png"), null, "磁盘上没了的路径不能留在清单里");

  // ── 没跑过的任务：被忽略那一档整个跳过（没有时间下限可用） ──────────────────
  await db.insert(tasks).values({
    id: "NoRunTask00", projectId: "p", title: "没跑过", body: "-",
    mode: "single", status: "backlog", agentType: "claude", createdAt: stamp, updatedAt: stamp,
  });
  const fresh = await readTaskArtifacts("NoRunTask00", root);
  assert.equal(fresh.since, null);
  assert(!fresh.artifacts.some((a) => a.origin === "ignored"), "没有开跑时刻就不敢认被忽略的文件");

  // ── 共享工作区：各任务只认自己在跑的那几段 ────────────────────────────────
  // `useWorktree=false` 的任务直接在项目主仓干活，同一个目录上先后（乃至同时）跑过的
  // 任务都往那儿写东西。判据写成「开跑之后」时的症状不是少几个，而是**每个任务拿到
  // 同一份清单**：实测 daily-report 上三个 6 月的任务各自都列出 400 条（撞上限），其中
  // 395 条是另一个任务三个月后写进 `.worktrees/<它>/videos/` 的东西，而它们自己那几个
  // 产物反倒被挤出去了。所以这一段钉三件事：窗口有上限、别人的 worktree 整个排除、
  // 同一个目录上的两个任务拿到的是两份不同的清单。
  const shared = join(stage, "shared");
  initRepo(shared, "output/\nnode_modules/\n");
  writeIn(shared, "art/底图.png");
  gitIn(shared, ["add", "."]);
  gitIn(shared, ["commit", "-qm", "base"], { GIT_AUTHOR_DATE: baseDate, GIT_COMMITTER_DATE: baseDate });

  const T0 = new Date(Date.now() - 3 * 60 * 60 * 1000);   // 第一个任务：3 小时前跑的
  const T0End = new Date(T0.getTime() + 10 * 60 * 1000);
  const T1 = new Date(T0.getTime() + 2 * 60 * 60 * 1000); // 第二个任务：两小时之后才跑
  const T1End = new Date(T1.getTime() + 10 * 60 * 1000);
  const iso = (at: Date) => at.toISOString();
  await db.insert(projects).values({ id: "p2", name: "shared", repoPath: shared, createdAt: iso(T0) });
  const sharedTask = (id: string, startedAt: Date, endedAt: Date, extra: Record<string, unknown> = {}) => [
    db.insert(tasks).values({
      id, projectId: "p2", title: id, body: "-", mode: "single", status: "done",
      agentType: "claude", useWorktree: false, createdAt: iso(startedAt), updatedAt: iso(endedAt),
      ...extra,
    }),
    db.insert(sessions).values({
      id: `s-${id}`, taskId: id, role: "main", agentType: "claude", executor: "claude",
      cwd: shared, startedAt: iso(startedAt), endedAt: iso(endedAt), exitStatus: 0,
    }),
  ];
  for (const step of [
    ...sharedTask("ShareFirst01", T0, T0End),
    ...sharedTask("ShareLater02", T1, T1End),
    // 审查任务：自己那几分钟什么都没产出，要看的恰恰是被审任务做出来的东西。
    ...sharedTask("ShareReview3", new Date(T1.getTime() + 30 * 60 * 1000), new Date(T1.getTime() + 40 * 60 * 1000), { reviewOf: "ShareFirst01" }),
  ]) await step;

  // 被忽略的那一档：三个时刻各一张，再加一张躺在别的任务 worktree 里的。
  writeIn(shared, "output/第一趟.png");
  touchAtIn(shared, "output/第一趟.png", new Date(T0.getTime() + 5 * 60 * 1000));
  writeIn(shared, "output/第二趟.png");
  touchAtIn(shared, "output/第二趟.png", new Date(T1.getTime() + 5 * 60 * 1000));
  writeIn(shared, "output/开跑之前.png");
  touchAtIn(shared, "output/开跑之前.png", new Date(T0.getTime() - 60 * 60 * 1000));
  // `output/` 这条忽略规则没有前导斜杠，所以它也匹配 `.worktrees/<任务>/output/`——
  // `git ls-files --ignored --directory` 会把那条深路径整个吐出来，只看 basename
  // （`output`）的跳过判定一个字都挡不住。
  writeIn(shared, ".worktrees/OtherTask001/output/别人的.png");
  touchAtIn(shared, ".worktrees/OtherTask001/output/别人的.png", new Date(T0.getTime() + 5 * 60 * 1000));

  // 浏览器自动化留下的 profile：里面成千上万个扩展图标确实都是「任务在跑的时候出现的」，
  // 但一条都不是产出。认的是 `Local State` + `Default/` 这两样 Chrome 专有标志，不是目录名。
  writeIn(shared, "output/x-browser-profile/Local State", "{}");
  writeIn(shared, "output/x-browser-profile/Default/Extensions/icon_16.png");
  touchAtIn(shared, "output/x-browser-profile/Default/Extensions/icon_16.png", new Date(T0.getTime() + 5 * 60 * 1000));

  // 已提交的那一档：共享工作区上没有任何一条属于任务的分支（`source_branch_missing`），
  // 只能退回「运行区间里的提交动过什么」。提交时刻由 committer date 决定。
  writeIn(shared, "art/海报.png");
  gitIn(shared, ["add", "."]);
  gitIn(shared, ["commit", "-qm", "第一趟的海报"], {
    GIT_AUTHOR_DATE: iso(new Date(T0.getTime() + 2 * 60 * 1000)),
    GIT_COMMITTER_DATE: iso(new Date(T0.getTime() + 2 * 60 * 1000)),
  });
  writeIn(shared, "art/事后补的.png");
  gitIn(shared, ["add", "."]);
  gitIn(shared, ["commit", "-qm", "两个钟头以后才提交的"], {
    GIT_AUTHOR_DATE: iso(new Date(T1.getTime() + 5 * 60 * 1000)),
    GIT_COMMITTER_DATE: iso(new Date(T1.getTime() + 5 * 60 * 1000)),
  });

  const sharedRoot = { path: shared, branch: "main", gitRepo: true, source: "repo" as const, repo: shared, projectId: "p2" };
  const readShared = async (id: string) => {
    const got = await readTaskArtifacts(id, sharedRoot);
    assert.equal(got.error, null, `${id} 的三路线索都该读得通`);
    return got;
  };

  const first = await readShared("ShareFirst01");
  // **估算档的强弱不能在「已提交」这个标签下丢掉**（第 4 轮审查 N2）：这条会话没有逐回合
  // 记录，整段寿命都是估出来的，所以**两张**都只是候选——`art/海报.png` 是「那一段里有提交
  // 动过它」，不是「它的任务分支里有这个提交」。原先 committed 一律当确定、不计数，于是面板
  // 上只说「1 个是估的」，另一个凭着同一段估出来的区间冒充确定。
  const guessedCount = Number(first.incomplete.find((n) => n.includes("按估出来的时间段"))?.match(/有 (\d+) 个/)?.[1]);
  assert.equal(guessedCount, 2, `估算区间认进来的两张都要计数（含已提交那张）：${JSON.stringify(first.incomplete)}`);
  assert.equal(originOf(first, "output/第一趟.png"), "ignored");
  assert.equal(originOf(first, "art/海报.png"), "committed", "共享工作区没有任务分支，已提交的那一档只能按运行区间认");
  assert.equal(
    originOf(first, "output/第二趟.png"), null,
    "任务收尾两小时之后才出现的文件不是它的产物——时间判据是个区间，不是一个下限",
  );
  assert.equal(originOf(first, "art/事后补的.png"), null, "运行区间之外的提交同理");
  assert.equal(originOf(first, "output/开跑之前.png"), null);
  assert.equal(
    originOf(first, ".worktrees/OtherTask001/output/别人的.png"), null,
    "别的任务的隔离工作区整个排除，时间再对得上也不是它的",
  );
  assert.equal(originOf(first, "art/底图.png"), null, "仓库本来就有的图仍然不算");
  assert.equal(
    originOf(first, "output/x-browser-profile/Default/Extensions/icon_16.png"), null,
    "浏览器 profile 整棵不算产物——时间对得上，但那是扩展自带的图标",
  );

  const later = await readShared("ShareLater02");
  assert.equal(originOf(later, "output/第二趟.png"), "ignored");
  assert.equal(originOf(later, "art/事后补的.png"), "committed");
  assert.equal(
    originOf(later, "output/第一趟.png"), null,
    "同一个共享目录上的两个任务必须拿到两份不同的清单",
  );
  assert.notDeepEqual(
    first.artifacts.map((a) => a.path), later.artifacts.map((a) => a.path),
    "两个任务的清单一模一样，就说明判据根本没在区分任务",
  );

  // 审查任务跟着被审任务的时间走：它自己那几分钟什么都没写，但要看的东西都在。
  const review = await readShared("ShareReview3");
  assert.equal(originOf(review, "output/第一趟.png"), "ignored", "审查任务要看的是被审任务做出来的东西");
  assert.equal(originOf(review, "art/海报.png"), "committed");

  // 还在飞的任务：收尾时刻无从得知，窗口必须开放到现在，否则 agent 正在写的东西全看不见。
  for (const step of sharedTask("ShareRunning4", new Date(Date.now() - 60 * 1000), new Date())) await step;
  await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, "ShareRunning4"));
  await db.update(sessions).set({ endedAt: null }).where(eq(sessions.id, "s-ShareRunning4"));
  writeIn(shared, "output/正在写.png");
  const running = await readShared("ShareRunning4");
  assert.equal(originOf(running, "output/正在写.png"), "ignored", "在飞的任务，刚落盘的东西必须立刻出现");

  // ── F3：别人后来动了同一个文件,不能把它从原任务的清单上抹掉 ──────────────────
  // `art/海报.png` 是 ShareFirst01 自己在运行区间里提交的，归属已经成立。此刻另一个任务
  // 改了它但还没提交：`git status` 先把这条路径登记成 working，而 working 是按 mtime 筛的,
  // 别人那次改动的时间当然不在原任务的区间里——整条路径于是从面板上消失,文件却还在
  // （第 2 轮审查 F3）。弱证据不许盖掉已经成立的强证据。
  writeIn(shared, "art/海报.png", Buffer.concat([png, Buffer.from([1, 2, 3])]));
  touchAtIn(shared, "art/海报.png", new Date(T1.getTime() + 90 * 60 * 1000));
  // 归属（在不在清单上）和当前状态（显示成哪一档）是两件事：路径必须留着，而标签照实说
  // 「它现在有未提交的改动」。
  const afterOthersEdit = await readShared("ShareFirst01");
  assert.equal(
    originOf(afterOthersEdit, "art/海报.png"), "working",
    "自己提交过的产物,不能因为别人后来又改了它就从清单上消失(标签照实说它现在有未提交改动)",
  );
  // 暂存之后 git status 的那一档换了个位置，判据不能跟着变。
  gitIn(shared, ["add", "art/海报.png"]);
  const afterStage = await readShared("ShareFirst01");
  assert.ok(
    originOf(afterStage, "art/海报.png"), "暂存与未暂存是同一件事：归属看的是提交证据,不是当前改动状态",
  );
  // 而**没有**提交证据的路径仍然只能靠时间：别人改的、自己没提交过的,照样不算它的。
  writeIn(shared, "draft/别人改的草稿.png");
  touchAtIn(shared, "draft/别人改的草稿.png", new Date(T1.getTime() + 90 * 60 * 1000));
  const strangerEdit = await readShared("ShareFirst01");
  assert.equal(
    originOf(strangerEdit, "draft/别人改的草稿.png"), null,
    "没有提交证据兜底的工作区改动,仍然要落在它的运行区间里",
  );

  // ── N1：文件名真的以换行开头,也不能被协议换行的处理顺手改写 ──────────────────
  // 两个都提交进同一个提交：`\n开头的海报.png` 排在前（紧跟提交头，前面带着 git 插进来的
  // 那个协议换行）、`zz-另一张.png` 排在后。要剥的只有协议那一个换行，文件名自己带的那个
  // 得留着——无条件剥掉每个 token 的全部前导换行，两种位置都会被改写成查不到的路径。
  const newlineNames = ["\n开头的海报.png", "\n排在后面的.png"];
  for (const name of newlineNames) writeIn(shared, name);
  writeIn(shared, "zz-另一张.png");
  gitIn(shared, ["add", "-A", "--", ...newlineNames, "zz-另一张.png"]);
  gitIn(shared, ["commit", "-qm", "换行开头的文件名"], {
    GIT_AUTHOR_DATE: iso(new Date(T0.getTime() + 3 * 60 * 1000)),
    GIT_COMMITTER_DATE: iso(new Date(T0.getTime() + 3 * 60 * 1000)),
  });
  const withNewline = await readShared("ShareFirst01");
  for (const name of newlineNames) {
    assert.equal(
      originOf(withNewline, name), "committed",
      `以换行开头的文件名要原样认出来（${JSON.stringify(name)}）：协议换行只在提交头后面那一条路径前面出现一次`,
    );
  }
  assert.equal(originOf(withNewline, "zz-另一张.png"), "committed", "同一个提交里的普通文件名照常");

  console.log("✓ task artifacts: committed/working/ignored 三档、仓库原有物免疫 mtime、依赖树与过期产物排除、删除即消失");
  console.log("✓ task artifacts: 别人后来的改动不抹掉自己已提交的产物(暂存/未暂存)、以换行开头的文件名照样认");
  console.log("✓ task artifacts: 共享工作区按运行区间认人——窗口有上限、别人的 worktree 排除、两个任务两份清单、审查跟到被审、在飞的开放到现在");
} finally {
  // ASH_DB 落在舞台目录里,Windows 上不先松开就删不掉(见 tmp-db.ts)。
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
