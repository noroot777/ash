// 仓库级串行锁回归测试:并行验收必须排队依次合并,而不是一起冲进同一个 `.git`。
// 每个用例自带临时仓库,任何 checkout / ref 更新都不会外溢到 harness 仓库。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

const root = mkdtempSync(join(tmpdir(), "harness-repo-lock-test-"));
process.env.HARNESS_DB = join(root, "harness.db");
// 会话 Markdown 落在仓库的 data/runs 下(RUNS_DIR 与 cwd 无关),用例结束时清掉。
const transcripts: string[] = [];
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function hasRef(repo: string, branch: string): boolean {
  try {
    git(repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

function makeRepo(name: string): string {
  const repo = join(root, name);
  execFileSync("git", ["init", "-b", "main", repo]);
  git(repo, "config", "user.name", "Harness Repo Lock Test");
  git(repo, "config", "user.email", "lock@example.test");
  writeFileSync(join(repo, ".gitignore"), ".worktrees/\n");
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "seed");
  return repo;
}

try {
  const { withRepoLock, holdsRepoLock, lockedRepoKeys } = await import("../src/repo-lock.js");
  const { prepareWorktree, worktreeBranchName } = await import("../src/git.js");
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, sessions, tasks } = await import("../src/db/schema.js");
  const { acceptTask } = await import("../src/task-accept.js");
  const { sessionTranscriptPath } = await import("../src/transcript.js");
  const { RUNS_DIR } = await import("../src/paths.js");
  await ensureSchema();

  // 1. 同一仓库互斥:并发进入的临界区任何时刻至多一个,且按到达顺序执行。
  {
    let inside = 0;
    let peak = 0;
    const order: number[] = [];
    await Promise.all(
      [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
        withRepoLock("~/code/lock-demo", async () => {
          inside += 1;
          peak = Math.max(peak, inside);
          order.push(i);
          await sleep(5);
          inside -= 1;
        }),
      ),
    );
    assert.equal(peak, 1, "同一仓库的临界区不允许并发");
    assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7], "应按到达顺序排队,不能乱序或饿死");
    assert.deepEqual(lockedRepoKeys(), [], "队列跑空后条目应被回收");
  }

  // 2. 路径写法不同但指向同一仓库,必须算同一把锁;不同仓库互不阻塞。
  {
    let inside = 0;
    let peak = 0;
    await Promise.all([
      withRepoLock("/tmp/same-repo", async () => { inside += 1; peak = Math.max(peak, inside); await sleep(5); inside -= 1; }),
      withRepoLock("/tmp/same-repo/", async () => { inside += 1; peak = Math.max(peak, inside); await sleep(5); inside -= 1; }),
    ]);
    assert.equal(peak, 1, "尾斜杠差异不能变成两把锁");

    let concurrent = 0;
    let otherPeak = 0;
    await Promise.all([
      withRepoLock("/tmp/repo-a", async () => { concurrent += 1; otherPeak = Math.max(otherPeak, concurrent); await sleep(10); concurrent -= 1; }),
      withRepoLock("/tmp/repo-b", async () => { concurrent += 1; otherPeak = Math.max(otherPeak, concurrent); await sleep(10); concurrent -= 1; }),
    ]);
    assert.equal(otherPeak, 2, "不同仓库应当并行,不该被同一条队列串起来");
  }

  // 2b. 路径别名(`.` / `..` / 软链)指的还是同一个仓库,必须落进同一把锁。
  // 去尾斜杠只挡得住最表面那一种写法;`repo/.` 和一条软链都是公共 API 收得下的合法
  // 路径,按字面值算键就会给同一个 `.git` 开两条队列 —— 并行验收撞 index.lock、
  // SCM 门禁也看不见别名项目里在跑的任务(第 2 轮审查)。
  {
    const real = makeRepo("alias-repo");
    const link = join(root, "alias-link");
    symlinkSync(real, link, "dir");
    // 故意用字符串拼而不是 `join`：`join` 自己就会把 `.` / `..` 消掉，那样测的就不是
    // `repoKey` 了。公共 API 收到的正是这种没归一过的原样字符串。
    // 相对路径也算一种别名：公共 API 收得下它,而 `git -C <相对路径>` 是按 server 进程的
    // cwd 解释的,落的是同一个目录 —— 按字面值算键同样会开出第二条队列(第 1 轮审查)。
    const aliases = [real, `${real}${sep}.`, `${real}${sep}sub${sep}..`, link, `${link}${sep}.${sep}`, relative(process.cwd(), real)];

    let inside = 0;
    let peak = 0;
    await Promise.all(aliases.map((path) =>
      withRepoLock(path, async () => {
        inside += 1; peak = Math.max(peak, inside); await sleep(5); inside -= 1;
      }),
    ));
    assert.equal(peak, 1, `别名写法不能变成多把锁：${aliases.join(" / ")}`);
    assert.deepEqual(lockedRepoKeys(), [], "队列跑空后条目应被回收");

    // 反向:确实是另一个目录时不能被并进来,否则上面那条用「只有一把锁」也能过。
    const other = makeRepo("alias-other");
    let together = 0;
    let bothPeak = 0;
    await Promise.all([`${real}${sep}.`, other].map((path) =>
      withRepoLock(path, async () => {
        together += 1; bothPeak = Math.max(bothPeak, together); await sleep(10); together -= 1;
      }),
    ));
    assert.equal(bothPeak, 2, "两个真正不同的仓库不该被归一到一起");
  }

  // 3. 可重入:外层持锁时内层直接放行(否则 acceptTask → mergeTaskBranch 会自锁死)。
  {
    const reentered = await withRepoLock("/tmp/reentrant", async () => {
      assert.equal(holdsRepoLock("/tmp/reentrant"), true);
      assert.equal(holdsRepoLock("/tmp/other"), false);
      return withRepoLock("/tmp/reentrant", async (wait) => {
        assert.equal(wait.queued, false, "重入不算排队");
        return "ok";
      });
    });
    assert.equal(reentered, "ok");
    assert.equal(holdsRepoLock("/tmp/reentrant"), false, "退出后不应残留持有标记");
  }

  // 4. 抛错也必须释放锁,否则一次失败的验收会永久冻住整个仓库。
  {
    await assert.rejects(withRepoLock("/tmp/throwing", async () => { throw new Error("boom"); }));
    const after = await withRepoLock("/tmp/throwing", async (wait) => wait.queued);
    assert.equal(after, false, "上一次抛错后锁应已释放");
    assert.deepEqual(lockedRepoKeys(), []);
  }

  // 5. 排队信息要如实上报,供调用方写进时间线。
  {
    const waits: boolean[] = [];
    await Promise.all([
      withRepoLock("/tmp/wait-report", async (wait) => { waits.push(wait.queued); await sleep(20); }),
      withRepoLock("/tmp/wait-report", async (wait) => { waits.push(wait.queued); }),
    ]);
    assert.deepEqual(waits, [false, true], "第一个不排队,第二个应报告排过队");
  }

  // 6. 端到端:4 个并行 worktree 任务同时验收。目标分支 main 检出在项目目录,
  //    正是"退化成在同一个工作区里 git merge"的危险路径 —— 没有串行锁时两个
  //    merge 会互相踩(index.lock / 干净检查看见半成品 / --abort 回滚别人)。
  {
    const repo = makeRepo("parallel-accept");
    const createdAt = new Date().toISOString();
    const projectId = "parallel-project";
    await db.insert(projects).values({ id: projectId, name: "parallel", repoPath: repo, createdAt });
    const common = {
      projectId,
      body: "",
      labels: "[]",
      dependsOn: "[]",
      resumeDependsOn: "[]",
      createdAt,
      updatedAt: createdAt,
    };

    // 分支名只取 taskId 前 8 位(worktreeBranchName),所以 id 前缀必须各不相同。
    const taskIds = ["acc1parallel", "acc2parallel", "acc3parallel", "acc4parallel"];
    for (const [index, taskId] of taskIds.entries()) {
      await db.insert(tasks).values({
        ...common,
        id: taskId,
        title: `并行任务 ${index + 1}`,
        mode: "single",
        status: "done",
        stage: "awaiting_acceptance",
        useWorktree: true,
        worktreeBase: "main",
      });
      const ws = await prepareWorktree(repo, taskId, "main");
      writeFileSync(join(ws.path, `${taskId}.txt`), `${taskId} output\n`);
      git(ws.path, "add", "-A");
      git(ws.path, "commit", "-m", `work of ${taskId}`);
    }

    // 用户挨个点了"验收通过":四个请求几乎同时打到服务端。
    const results = await Promise.all(taskIds.map((taskId) => acceptTask(taskId)));
    for (const [index, result] of results.entries()) {
      assert.equal(result.accepted, true, `第 ${index + 1} 个验收失败：${result.accepted ? "" : result.error}`);
      if (!result.accepted) throw new Error(result.error);
      assert.equal(result.stage, "accepted");
      assert.equal(result.kind, "isolated_worktree");
      assert.equal(result.targetBranch, "main");
    }

    // 每个任务的产物都必须真的进了 main —— 串行的意义就在这里:没有谁被覆盖。
    const merged = git(repo, "ls-tree", "-r", "--name-only", "main").split("\n");
    for (const taskId of taskIds) {
      assert.ok(merged.includes(`${taskId}.txt`), `${taskId} 的改动没有进入 main`);
      assert.equal(hasRef(repo, worktreeBranchName(taskId)), false, `${taskId} 的分支应已删除`);
      assert.equal(existsSync(join(repo, ".worktrees", taskId)), false, `${taskId} 的 worktree 应已删除`);
    }
    assert.equal(git(repo, "status", "--porcelain"), "", "验收后项目工作区必须仍然干净");
    const stages = await db.select().from(tasks);
    for (const taskId of taskIds) {
      assert.equal(stages.find((task) => task.id === taskId)?.stage, "accepted");
    }
    assert.deepEqual(lockedRepoKeys(), [], "全部验收结束后仓库锁应已释放");
  }

  // 7. 排队必须在时间线上留痕:刷新后仍看得出"它等过前一个验收",而不是
  //    界面上莫名卡住几秒。两个任务共享同一仓库,后到的那个应写下排队说明。
  {
    const repo = makeRepo("queue-timeline");
    const createdAt = new Date().toISOString();
    const projectId = "queue-timeline-project";
    await db.insert(projects).values({ id: projectId, name: "queue timeline", repoPath: repo, createdAt });
    const common = {
      projectId,
      body: "",
      labels: "[]",
      dependsOn: "[]",
      resumeDependsOn: "[]",
      createdAt,
      updatedAt: createdAt,
    };
    const ids = ["qt1timeline", "qt2timeline"];
    for (const [index, taskId] of ids.entries()) {
      await db.insert(tasks).values({
        ...common,
        id: taskId,
        title: `排队任务 ${index + 1}`,
        mode: "single",
        status: "done",
        stage: "awaiting_acceptance",
        useWorktree: true,
        worktreeBase: "main",
      });
      // 时间线只写进已有会话,所以给每个任务补一条(真实任务跑过就有)。
      await db.insert(sessions).values({
        id: `${taskId}-session`,
        taskId,
        role: "task",
        agentType: "claude",
        executor: "claude",
        startedAt: createdAt,
      });
      transcripts.push(join(RUNS_DIR, taskId));
      const ws = await prepareWorktree(repo, taskId, "main");
      writeFileSync(join(ws.path, `${taskId}.txt`), `${taskId}\n`);
      git(ws.path, "add", "-A");
      git(ws.path, "commit", "-m", `work of ${taskId}`);
    }

    const results = await Promise.all(ids.map((taskId) => acceptTask(taskId)));
    assert.ok(results.every((result) => result.accepted), "两个验收都应成功");
    const notes = ids.map((taskId) =>
      readFileSync(sessionTranscriptPath(taskId, `${taskId}-session`), "utf8"),
    );
    const queued = notes.filter((note) => note.includes("验收排队"));
    assert.equal(queued.length, 1, "只有后到的那个验收该记排队,先到的不该");
    assert.match(queued[0], /验收排队：同一仓库有其它验收\/worktree 操作正在执行，已等待 [\d.]+s 后开始本次验收。/);
  }

  console.log("repo lock: 互斥 / 路径归一 / 可重入 / 异常释放 / 排队上报 / 并行验收串行合并 / 排队留痕全部通过");
} finally {
  for (const dir of transcripts) rmSync(dir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
