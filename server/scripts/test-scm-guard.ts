// SCM 写接口的门禁回归测试（路由级，跑在临时库 + 临时仓库上）。
//
// 钉住的是两条「读侧看着一切正常、写下去却是灾难」的行为：
//   • **该有独立工作区、目录还没建出来**的任务解出来的根是项目主仓。看可以，写不行——
//     否则用户从一个还没开工的任务的面板上，不可逆地丢掉了项目主工作区里的改动。
//   • **归档 = 冻结**：任务树把归档任务藏起来了，但旧页面、别的客户端、直接调 API 全绕
//     得过去，冻结语义只能由后端守住。
// 两条都不是「确认一下就能干」，所以带 force 也必须照样拒；且拒绝之后**磁盘一个字节都
// 不许变**——只断言 HTTP 409 是不够的，第 2 轮审查里 discard 正是先回了 200 才被发现。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  console.log("scm guard ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
