// SCM 写接口的门禁回归测试（路由级，跑在临时库 + 临时仓库上）。
//
// 钉住的是两条「读侧看着一切正常、写下去却是灾难」的行为：
//   • **该有独立工作区、目录还没建出来**的任务解出来的根是项目主仓。看可以，写不行——
//     否则用户从一个还没开工的任务的面板上，不可逆地丢掉了项目主工作区里的改动。
//   • **归档 = 冻结**：任务树把归档任务藏起来了，但旧页面、别的客户端、直接调 API 全绕
//     得过去，冻结语义只能由后端守住。
// 两条都不是「确认一下就能干」，所以带 force 也必须照样拒；且拒绝之后**磁盘一个字节都
// 不许变**——只断言 HTTP 409 是不够的，第 2 轮审查里 discard 正是先回了 200 才被发现。
//
// 反过来，只读也不能滥发：**共享工作区的归属任务不是执行者自己**，还没跑过的团队执行者
// 该看到领队那个真实存在的 worktree，而不是退到项目主仓再谎称「目录还没建出来」。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";

const root = mkdtempSync(join(tmpdir(), "harness-scm-guard-"));
const repo = join(root, "repo");
process.env.HARNESS_DB = join(root, "harness.db");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

try {
  execFileSync("git", ["init", "-b", "main", repo]);
  git(repo, "config", "user.name", "Harness SCM Guard Test");
  git(repo, "config", "user.email", "scm@harness.test");
  writeFileSync(join(repo, "a.txt"), "baseline\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-m", "seed");

  const [{ db, ensureSchema }, { projects, tasks }, { mountScmRoutes }] = await Promise.all([
    import("../src/db/index.js"),
    import("../src/db/schema.js"),
    import("../src/scm-routes.js"),
  ]);
  await ensureSchema();

  const ts = new Date().toISOString();
  await db.insert(projects).values({ id: "project", name: "scm guard", repoPath: repo, createdAt: ts });
  const common = {
    projectId: "project", title: "scm guard", status: "backlog",
    parentId: null, mode: "single", createdAt: ts, updatedAt: ts,
  };
  await db.insert(tasks).values([
    // 就地干活（没有独立工作区这回事），没归档 —— 唯一一个该放行的
    { ...common, id: "in-place", useWorktree: false },
    // 就地干活但**已归档**：冻结
    { ...common, id: "archived", useWorktree: false, archived: true, archivedAt: ts },
    // 逻辑上要独立工作区、从来没跑过 → 目录不存在 → 解析回退到项目主仓：只读
    { ...common, id: "isolated-unborn", useWorktree: true },
  ]);

  const api = new Hono();
  mountScmRoutes(api);

  const post = (taskId: string, op: string, body: unknown) =>
    api.request(`/tasks/${taskId}/scm/${op}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const fileNow = () => readFileSync(join(repo, "a.txt"), "utf8");
  // porcelain 的前两列一个是索引、一个是工作区，**开头那个空格有意义**，不能 trim 掉。
  const dirty = () =>
    execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" }).trimEnd();

  // 每次写门禁用例前，工作区都摆成「有一处未提交的改动」——拒绝的判据是它还在。
  const soil = () => {
    writeFileSync(join(repo, "a.txt"), "local edit\n");
    assert.equal(fileNow(), "local edit\n");
  };

  /** 四个写操作全试一遍：门禁住在公共外壳里，只测一条会漏掉挂错的那三条。 */
  const writeOps = [
    { op: "stage", body: { paths: ["a.txt"] } },
    { op: "unstage", body: { paths: ["a.txt"] } },
    { op: "discard", body: { paths: ["a.txt"] } },
    { op: "commit", body: { message: "should never land", stagePaths: ["a.txt"] } },
  ];

  const expectFrozen = async (taskId: string, hint: string) => {
    for (const forced of [false, true]) {
      for (const { op, body } of writeOps) {
        soil();
        const head = git(repo, "rev-parse", "HEAD");
        const res = await post(taskId, op, { ...body, force: forced });
        const payload = await res.json() as { error?: string; readOnly?: string };
        assert.equal(res.status, 409, `${hint} ${op}${forced ? "(force)" : ""} 必须 409，实际 ${res.status}`);
        assert.ok(payload.readOnly, `${hint} ${op} 要把只读理由回给面板`);
        assert.match(payload.readOnly ?? "", hint === "归档" ? /归档/ : /还没建出来/);
        // 真正的判据在磁盘上：文件没被还原、索引没被动、没有多出提交。
        assert.equal(fileNow(), "local edit\n", `${hint} ${op} 之后文件内容不许变`);
        assert.equal(dirty(), " M a.txt", `${hint} ${op} 之后索引不许变`);
        assert.equal(git(repo, "rev-parse", "HEAD"), head, `${hint} ${op} 之后不许多出提交`);
      }
    }
    // 读侧照旧能看，只是要带上理由（面板据此收起按钮）。
    const overview = await api.request(`/tasks/${taskId}/scm`);
    assert.equal(overview.status, 200, `${hint} 的读接口不该被冻住`);
    const body = await overview.json() as { readOnly: string | null; root: { source: string } };
    assert.ok(body.readOnly, `${hint} 的概览必须带只读理由`);
  };

  // ── 1. 归档 = 冻结 ──────────────────────────────────────────────────────────
  await expectFrozen("archived", "归档");

  // ── 2. 独立工作区还没建出来 → 回退到项目主仓，只读 ──────────────────────────
  await expectFrozen("isolated-unborn", "未建");

  // ── 3. 反向：正常任务照旧能写 ───────────────────────────────────────────────
  // 没有这一条，上面两条用「一律 409」也能过。
  {
    soil();
    const res = await post("in-place", "stage", { paths: ["a.txt"] });
    assert.equal(res.status, 200, "就地干活的活任务必须能写");
    const payload = await res.json() as { affected: number; status: { staged: { path: string }[] } };
    assert.equal(payload.affected, 1);
    assert.deepEqual(payload.status.staged.map((c) => c.path), ["a.txt"]);
    assert.equal(dirty(), "M  a.txt");
    git(repo, "restore", "--staged", "--worktree", "a.txt");
  }

  // ── 4. 排锁期间才归档的，也要被挡住 ─────────────────────────────────────────
  // 进门时那道读到的是「没归档」，而 withRepoLock 可能排上几秒——这中间用户完全可能
  // 刚把任务归档了。所以真正动手之前还要在锁内复查一次归档位。
  {
    const { withRepoLock } = await import("../src/repo-lock.js");
    soil();
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    // 先占住这个仓库的锁，让写请求停在排队里。
    const holding = withRepoLock(repo, () => held);
    const pending = post("in-place", "discard", { paths: ["a.txt"] });
    // 排队期间归档 → 锁内复查必须看见新值。
    await db.update(tasks).set({ archived: true, archivedAt: ts }).where(eq(tasks.id, "in-place"));
    release();
    await holding;

    const res = await pending;
    assert.equal(res.status, 409, "排锁期间刚归档的任务，动手之前必须被复查挡下");
    assert.equal(fileNow(), "local edit\n", "被挡下之后文件一个字节都不许变");
    await db.update(tasks).set({ archived: false, archivedAt: null }).where(eq(tasks.id, "in-place"));
    git(repo, "restore", "--worktree", "a.txt");
  }

  // ── 5. 还没跑过的共享执行者，看的是**领队那个 worktree**，不是项目主仓 ─────────
  // 团队执行者默认跟随调度台的工作区（`taskWorkspace`）。它自己名下没有 session、也没有
  // `.worktrees/<workerId>`，但那不代表「还没建出来」——领队的目录好端端地在，执行者真跑
  // 起来就落进去。解析只查它自己就会退到项目主仓：展示一份完全无关的 git 状态，还谎称
  // 目录没建出来，执行者看不见自己的改动，也无法从面板收尾。
  {
    const leadWorktree = join(repo, ".worktrees", "lead");
    git(repo, "worktree", "add", "-b", "harness/lead", leadWorktree);
    writeFileSync(join(leadWorktree, "shared.txt"), "worker's work\n");

    await db.insert(tasks).values([
      { ...common, id: "lead", mode: "team", useWorktree: true },
      // 默认执行者：useWorktree=false 在这里的语义是「跟随调度台」，不是「就地干活」
      { ...common, id: "worker", parentId: "lead", useWorktree: false },
    ]);

    const res = await api.request("/tasks/worker/scm");
    assert.equal(res.status, 200);
    const body = await res.json() as {
      root: { path: string; source: string }; readOnly: string | null;
      status: { untracked: { path: string }[] };
    };
    assert.equal(body.root.path, leadWorktree, "共享执行者必须看到领队的工作区");
    assert.equal(body.root.source, "worktree");
    assert.equal(body.readOnly, null, "目录真实存在，没有理由只读");
    assert.deepEqual(body.status.untracked.map((c) => c.path), ["shared.txt"]);

    // 领队 worktree 确实不存在时才回退项目主仓并只读——「未建」那一档不能被这条抹掉。
    git(repo, "worktree", "remove", "--force", leadWorktree);
    const gone = await api.request("/tasks/worker/scm");
    const goneBody = await gone.json() as { root: { source: string }; readOnly: string | null };
    assert.equal(goneBody.root.source, "repo");
    assert.match(goneBody.readOnly ?? "", /还没建出来/, "归属工作区没了才该显示未创建");
  }

  // ── 6. 共用同一个工作目录的**兄弟任务**在跑，也要挡 ─────────────────────────
  // 第 5 条把共享工作区正式开放成可写之后冒出来的：门禁只问当前这个 task id，而工作目录
  // 是领队、跟随执行者、各自审查任务共用的。兄弟执行者正写着文件，用户从这一位空闲执行者
  // 的面板上无 force 就能把它没提交的成果丢掉（第 4 轮审查在页面上真实复现）。
  {
    const { claimTurn, isTurnClaimed, releaseTurn } = await import("../src/runs.js");
    const leadWorktree = join(repo, ".worktrees", "lead");
    git(repo, "worktree", "add", leadWorktree, "harness/lead");
    writeFileSync(join(leadWorktree, "shared.txt"), "baseline\n");
    git(leadWorktree, "add", "shared.txt");
    git(leadWorktree, "commit", "-m", "shared baseline");
    await db.insert(tasks).values([
      { ...common, id: "worker2", title: "兄弟执行者", parentId: "lead", useWorktree: false },
    ]);

    const sharedNow = () => readFileSync(join(leadWorktree, "shared.txt"), "utf8");
    const soilShared = () => {
      writeFileSync(join(leadWorktree, "shared.txt"), "sibling agent in progress\n");
      assert.equal(sharedNow(), "sibling agent in progress\n");
    };
    const sharedOps = [
      { op: "stage", body: { paths: ["shared.txt"] } },
      { op: "unstage", body: { paths: ["shared.txt"] } },
      { op: "discard", body: { paths: ["shared.txt"] } },
      { op: "commit", body: { message: "should need force", stagePaths: ["shared.txt"] } },
    ];
    const sharedDirty = () =>
      execFileSync("git", ["-C", leadWorktree, "status", "--porcelain"], { encoding: "utf8" }).trimEnd();

    // 「在飞」的两种凭据各来一遍：团队调度台的常驻回合不占 turn 锁（DB status 是唯一
    // 凭据），刚 claim 还没落 running 的执行者反过来只有 turn 锁。少看一样就漏掉一类。
    const evidences = [
      {
        hint: "DB 说兄弟在跑",
        arm: async () => { await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, "worker2")); },
        disarm: async () => { await db.update(tasks).set({ status: "backlog" }).where(eq(tasks.id, "worker2")); },
      },
      {
        hint: "兄弟刚占住回合",
        arm: async () => { assert.equal(claimTurn("worker2", "single"), true); },
        disarm: async () => { releaseTurn("worker2"); },
      },
    ];

    for (const { hint, arm, disarm } of evidences) {
      await arm();
      const overview = await api.request("/tasks/worker/scm");
      const body = await overview.json() as { taskRunning: boolean; readOnly: string | null };
      assert.equal(body.taskRunning, true, `${hint}：空闲执行者的面板也得说「这个目录里有任务在跑」`);
      assert.equal(body.readOnly, null, "在飞不是只读——是要用户确认一次");

      for (const { op, body: payload } of sharedOps) {
        soilShared();
        const head = git(leadWorktree, "rev-parse", "HEAD");
        const res = await post("worker", op, payload);
        const json = await res.json() as { error?: string; needsForce?: boolean };
        assert.equal(res.status, 409, `${hint}：${op} 必须 409，实际 ${res.status}`);
        assert.equal(json.needsForce, true, `${hint}：${op} 要让面板弹确认框，而不是报一个死错`);
        assert.match(json.error ?? "", /兄弟执行者/, `${hint}：${op} 要说清是哪个任务在跑`);
        assert.equal(sharedNow(), "sibling agent in progress\n", `${hint}：${op} 之后文件不许变`);
        assert.equal(sharedDirty(), " M shared.txt", `${hint}：${op} 之后索引不许变`);
        assert.equal(git(leadWorktree, "rev-parse", "HEAD"), head, `${hint}：${op} 之后不许多出提交`);
      }
      await disarm();
    }

    // 兄弟停下之后照旧能写——上面那几条不能是「共享目录一律 409」。
    soilShared();
    const free = await post("worker", "discard", { paths: ["shared.txt"] });
    assert.equal(free.status, 200, "没人在跑时共享目录必须能写");
    assert.equal(sharedNow(), "baseline\n");

    // 用户点了确认：带 force 要真能穿过去，否则「明知故犯」这一档等于没有。
    await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, "worker2"));
    soilShared();
    const forced = await post("worker", "discard", { paths: ["shared.txt"], force: true });
    assert.equal(forced.status, 200, "带 force 必须放行");
    assert.equal(sharedNow(), "baseline\n", "force 之后丢弃要真的生效");
    await db.update(tasks).set({ status: "backlog" }).where(eq(tasks.id, "worker2"));

    // 写完必须把整组占位都还回去，否则这几个任务再也起不来。
    for (const id of ["lead", "worker", "worker2"]) {
      assert.equal(isTurnClaimed(id), false, `${id} 的占位必须还回去`);
    }
  }

  // ── 7. 同一个仓库登记成两个项目，对面那个任务在跑也要挡 ─────────────────────
  // 第 6 条按 projectId 圈共用者，于是同一份主仓被登记成两个项目时，两边的就地任务落在
  // 同一个目录里却互相看不见：面板不显示在飞横幅，无 force 的 discard 直接把对面正在跑的
  // 任务的成果丢掉（第 1 轮审查用公共 API 复现）。归一按 `repoKey`，所以这里把第二个项目的
  // 路径挨个换成各种**指向同一个 `.git` 的合法写法**：只去掉末尾斜杠的话，`repo/.` 和一条
  // 软链就能原样绕过整道门禁（第 2 轮审查用公共 API 复现——`POST /api/projects` 收得下这
  // 两种写法）。
  {
    // 故意用字符串拼而不是 `join`：`join` 自己会把 `.` / `..` 消掉，那样测的就不是 `repoKey`。
    const link = join(root, "repo-link");
    symlinkSync(repo, link, "dir");
    // 相对路径是同一类事：`POST /api/projects` 原样收，而 `git -C <相对路径>` 是按 server
    // 进程的 cwd 解释的，落的正是这个仓库（第 1 轮审查用隔离实例复现：面板不显示在飞、
    // 无 force 的 discard 直接 200 把文件还原了）。
    const aliases = [`${repo}/`, `${repo}/.`, `${repo}/sub/..`, link, `${link}/./`, relative(process.cwd(), repo)];

    await db.insert(projects).values({
      id: "project-b", name: "同一个仓库的另一个项目", repoPath: aliases[0], createdAt: ts,
    });
    await db.insert(tasks).values({
      ...common, id: "cross-proj", projectId: "project-b", title: "隔壁项目的任务",
      useWorktree: false, status: "running",
    });

    // 第 6 条在主仓里留了个 `.worktrees/lead`，主仓的 porcelain 会多一行未跟踪目录；
    // 这里要钉的是 a.txt 那一条有没有被动过，把它滤掉。
    const repoDirty = () => dirty().split("\n").filter((line) => !line.includes(".worktrees/")).join("\n");

    for (const alias of aliases) {
      await db.update(projects).set({ repoPath: alias }).where(eq(projects.id, "project-b"));
      const overview = await api.request("/tasks/in-place/scm");
      const body = await overview.json() as { taskRunning: boolean; readOnly: string | null };
      assert.equal(body.taskRunning, true, `跨项目(${alias})：这边的面板也得说「这个目录里有任务在跑」`);
      assert.equal(body.readOnly, null, "在飞不是只读");

      for (const { op, body: payload } of writeOps) {
        soil();
        const head = git(repo, "rev-parse", "HEAD");
        const res = await post("in-place", op, payload);
        const json = await res.json() as { error?: string; needsForce?: boolean };
        assert.equal(res.status, 409, `跨项目(${alias})：${op} 必须 409，实际 ${res.status}`);
        assert.equal(json.needsForce, true, `跨项目(${alias})：${op} 要让面板弹确认框`);
        assert.match(json.error ?? "", /隔壁项目的任务/, `跨项目(${alias})：${op} 要说清是哪个任务在跑`);
        assert.equal(fileNow(), "local edit\n", `跨项目(${alias})：${op} 之后文件不许变`);
        assert.equal(repoDirty(), " M a.txt", `跨项目(${alias})：${op} 之后索引不许变`);
        assert.equal(git(repo, "rev-parse", "HEAD"), head, `跨项目(${alias})：${op} 之后不许多出提交`);
      }
    }

    // 反向：别的仓库不能被顺带圈进来，否则上面几条用「只要有任务在跑就挡」也能过。
    await db.update(tasks).set({ status: "backlog" }).where(eq(tasks.id, "cross-proj"));
    await db.update(projects).set({ repoPath: join(root, "other-repo") }).where(eq(projects.id, "project-b"));
    await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, "cross-proj"));
    soil();
    const free = await post("in-place", "discard", { paths: ["a.txt"] });
    assert.equal(free.status, 200, "另一个仓库里的任务在跑，跟这个目录无关");
    assert.equal(fileNow(), "baseline\n");

    await db.delete(tasks).where(eq(tasks.id, "cross-proj"));
    await db.delete(projects).where(eq(projects.id, "project-b"));
  }

  // ── 8. 写操作已经落地之后，那次「顺手刷新状态」失败不许把它翻成失败 ────────
  //
  // 外壳在每个写操作之后补读一次 status，好让面板不用再补一次 GET。这一读本身也会失败
  // （第 1 轮审查用一个合法的 post-commit hook 复现：提交完把仓库目录挪走，接口回 500，
  // 而真实 HEAD 上提交好好地在）。提交不可逆，报成失败等于让用户再提交一次。
  // hook 要 shell 和可执行位，Windows 上两样都不作数，那边跳过。
  if (process.platform !== "win32") {
    const repo8 = join(root, "vanishing-repo");
    const moved8 = `${repo8}-moved`;
    execFileSync("git", ["init", "-b", "main", repo8]);
    git(repo8, "config", "user.name", "Harness SCM Guard Test");
    git(repo8, "config", "user.email", "scm@harness.test");
    writeFileSync(join(repo8, "a.txt"), "baseline\n");
    git(repo8, "add", "a.txt");
    git(repo8, "commit", "-m", "seed");
    writeFileSync(join(repo8, "a.txt"), "to be committed\n");
    writeFileSync(join(repo8, ".git", "hooks", "post-commit"), `#!/bin/sh\nmv "${repo8}" "${moved8}"\n`);
    chmodSync(join(repo8, ".git", "hooks", "post-commit"), 0o755);

    await db.insert(projects).values({ id: "project-v", name: "会消失的仓库", repoPath: repo8, createdAt: ts });
    await db.insert(tasks).values({ ...common, id: "vanishing", projectId: "project-v", useWorktree: false });

    const res = await post("vanishing", "commit", { message: "提交真的成功了", stagePaths: ["a.txt"] });
    const json = await res.json() as { ok?: boolean; sha?: string | null; warning?: string; error?: string };
    assert.equal(res.status, 200, `提交已经落地，刷新状态失败不许翻成 ${res.status}`);
    assert.equal(json.ok, true, "回给面板的必须是「成功」");
    assert.equal(json.sha, null, "读不到提交号就如实回 null");
    assert.match(json.warning ?? "", /提交已经成功/, "读不到的那部分要说出来");
    assert.equal(
      execFileSync("git", ["-C", moved8, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim(),
      "提交真的成功了",
      "前提：提交确实落进了 HEAD——这正是不许报失败的理由",
    );

    await db.delete(tasks).where(eq(tasks.id, "vanishing"));
    await db.delete(projects).where(eq(projects.id, "project-v"));
  }

  // ── 9. 项目改了 repoPath，任务还在旧仓库里干活 ──────────────────────────────
  // 展示解析（`taskFileRoot`）第一优先级是**会话 cwd**，而项目的 `repoPath` 是随时能
  // PATCH 改掉的登记值。两者一分家，按项目 repoPath 圈共用者、按项目 repoPath 上锁，就
  // 等于拿一个跟眼前这份 git 状态毫无关系的仓库做判断：旧仓库里正在跑的任务完全不可见，
  // 无 force 的 discard 直接穿透；锁也锁在了空仓库上（第 2 轮审查用隔离实例复现）。
  {
    const { withRepoLock } = await import("../src/repo-lock.js");
    const oldRepo = join(root, "moved-old-repo");
    const newRepo = join(root, "moved-new-repo");
    for (const dir of [oldRepo, newRepo]) {
      execFileSync("git", ["init", "-b", "main", dir]);
      git(dir, "config", "user.name", "Harness SCM Guard Test");
      git(dir, "config", "user.email", "scm@harness.test");
      writeFileSync(join(dir, "a.txt"), "baseline\n");
      git(dir, "add", "a.txt");
      git(dir, "commit", "-m", "seed");
    }

    const { sessions } = await import("../src/db/schema.js");
    await db.insert(projects).values([
      // 项目**已经**改指新仓库了，任务上一轮跑的却是旧仓库
      { id: "project-moved", name: "改过路径的项目", repoPath: newRepo, createdAt: ts },
      { id: "project-old", name: "旧仓库项目", repoPath: oldRepo, createdAt: ts },
    ]);
    await db.insert(tasks).values([
      { ...common, id: "moved", projectId: "project-moved", useWorktree: false },
      { ...common, id: "old-runner", projectId: "project-old", title: "旧仓库里在跑的任务",
        useWorktree: false, status: "running" },
    ]);
    await db.insert(sessions).values({
      id: "sess-moved", taskId: "moved", role: "main", agentType: "claude", executor: "claude",
      target: "local", cwd: oldRepo, startedAt: ts,
    });

    const movedNow = () => readFileSync(join(oldRepo, "a.txt"), "utf8");
    const soilMoved = () => writeFileSync(join(oldRepo, "a.txt"), "agent in progress\n");

    const overview = await api.request("/tasks/moved/scm");
    const body = await overview.json() as { root: { path: string }; taskRunning: boolean };
    assert.equal(body.root.path, oldRepo, "前提：会话 cwd 说了算，展示的是旧仓库");
    assert.equal(body.taskRunning, true, "旧仓库里正在跑的任务必须出现在在飞判定里");

    for (const { op, body: payload } of writeOps) {
      soilMoved();
      const head = git(oldRepo, "rev-parse", "HEAD");
      const res = await post("moved", op, payload);
      const json = await res.json() as { error?: string; needsForce?: boolean };
      assert.equal(res.status, 409, `搬过家：${op} 必须 409，实际 ${res.status}`);
      assert.equal(json.needsForce, true, `搬过家：${op} 要让面板弹确认框`);
      assert.match(json.error ?? "", /旧仓库里在跑的任务/, `搬过家：${op} 要说清是哪个任务在跑`);
      assert.equal(movedNow(), "agent in progress\n", `搬过家：${op} 之后文件不许变`);
      assert.equal(git(oldRepo, "rev-parse", "HEAD"), head, `搬过家：${op} 之后不许多出提交`);
    }

    // 写型 git 操作要跟**旧仓库**的其它 git 操作串行：锁错了仓库等于没锁。占住旧仓库的
    // 锁，这次写就该一直排在外面。
    await db.update(tasks).set({ status: "backlog" }).where(eq(tasks.id, "old-runner"));
    {
      soilMoved();
      let release = () => {};
      const held = new Promise<void>((resolve) => { release = resolve; });
      const holding = withRepoLock(oldRepo, () => held);
      const pending = post("moved", "stage", { paths: ["a.txt"] });
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(
        execFileSync("git", ["-C", oldRepo, "status", "--porcelain"], { encoding: "utf8" }).trimEnd(),
        " M a.txt",
        "旧仓库的锁被占着，这次暂存必须还排在外面（锁错仓库的话它早跑完了）",
      );
      release();
      await holding;
      assert.equal((await pending).status, 200, "锁一放就该跑完");
      assert.equal(
        execFileSync("git", ["-C", oldRepo, "status", "--porcelain"], { encoding: "utf8" }).trimEnd(),
        "M  a.txt",
        "排完队之后暂存要真的生效",
      );
      git(oldRepo, "restore", "--staged", "--worktree", "a.txt");
    }

    // 反向：新仓库里在跑的任务跟眼前这个目录无关，不该把这边挡住。
    await db.insert(tasks).values({
      ...common, id: "new-runner", projectId: "project-moved", title: "新仓库里在跑的任务",
      useWorktree: false, status: "running",
    });
    soilMoved();
    const free = await post("moved", "discard", { paths: ["a.txt"] });
    assert.equal(free.status, 200, "登记的新仓库里有任务在跑，跟旧仓库这份状态无关");
    assert.equal(movedNow(), "baseline\n");

    for (const id of ["moved", "old-runner", "new-runner"]) await db.delete(tasks).where(eq(tasks.id, id));
    await db.delete(sessions).where(eq(sessions.taskId, "moved"));
    for (const id of ["project-moved", "project-old"]) await db.delete(projects).where(eq(projects.id, id));
  }

  console.log("scm guard ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
