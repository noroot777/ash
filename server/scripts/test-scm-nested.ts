// 嵌套 Git 仓库在面板上的行为（路由级，跑在临时库 + 临时仓库上）。
//
// `git status -uall` 对**自带 `.git` 的子目录**不往里递归，只列一条 `? vendor-lib/`。
// 这一条带着尾斜杠原样进列表，就同时踩中两处：
//   • 形状闸把尾分隔符当成「目录 pathspec」拒掉（那道闸是对的——`:(literal)` 关不掉目录
//     递归），于是它自己既不能预览也不能操作，**还把同一批里的其它文件一起 400**：
//     「全部暂存 / 全部删除」和「没有已暂存时暂存全部并提交」只要列表里有一个嵌套仓就
//     整批失败（第 1 轮审查用公共 API 和页面都复现）。
//   • 就算把尾斜杠去掉放行也不对，git 对它的三种反应各错一样：`git add` 在没有提交的
//     嵌套仓上直接 exit 128 炸掉整批，在有提交的嵌套仓上**静默建出一条 gitlink 子模块
//     记录**（用户点的是「暂存一个未跟踪文件」，得到的是一个子模块）；`git clean -f`
//     一个字节都不删却照样 exit 0，面板会报「已丢弃 1 个文件」；未跟踪预览走的
//     `git diff --no-index /dev/null <dir>` exit 1，那个码在允许集里，于是回一份空 diff。
//
// 所以判据是：**列出来、说清楚、不下手**——嵌套仓在列表里看得见，批量操作跳过它并把
// 跳过了谁说出来，单独点它则拒绝并解释，其余文件一律照做。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

const root = mkdtempSync(join(tmpdir(), "ash-scm-nested-"));
const repo = join(root, "repo");
process.env.ASH_DB = join(root, "ash.db");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

const write = (dir: string, path: string, body: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), body);
};

/** 一个自带 `.git` 的子目录。`committed` 决定它有没有提交——git 对这两种的反应不一样。 */
function nestedRepo(name: string, committed: boolean) {
  const dir = join(repo, name);
  execFileSync("git", ["init", "-b", "main", dir]);
  git(dir, "config", "user.name", "Nested");
  git(dir, "config", "user.email", "nested@ash.test");
  write(dir, "inner.txt", "inner\n");
  if (committed) {
    git(dir, "add", "inner.txt");
    git(dir, "commit", "-m", "inner");
  }
}

try {
  execFileSync("git", ["init", "-b", "main", repo]);
  git(repo, "config", "user.name", "Ash SCM Nested Test");
  git(repo, "config", "user.email", "scm@ash.test");
  write(repo, "seed.txt", "seed\n");
  git(repo, "add", "seed.txt");
  git(repo, "commit", "-m", "seed");

  nestedRepo("vendor-lib", false);   // 还没有提交的嵌套仓：`git add` 会 exit 128 炸整批
  nestedRepo("vendor-done", true);   // 有提交的嵌套仓：`git add` 会静默建出 gitlink
  write(repo, "untracked.txt", "hello\n");

  const [{ db, ensureSchema }, { projects, tasks }, { mountScmRoutes }, { readScmStatus }] = await Promise.all([
    import("../src/db/index.js"),
    import("../src/db/schema.js"),
    import("../src/scm-routes.js"),
    import("../src/git-status.js"),
  ]);
  await ensureSchema();

  const ts = new Date().toISOString();
  await db.insert(projects).values({ id: "project", name: "scm nested", repoPath: repo, createdAt: ts });
  await db.insert(tasks).values({
    id: "t", projectId: "project", title: "scm nested", status: "backlog",
    parentId: null, mode: "single", useWorktree: false, createdAt: ts, updatedAt: ts,
  });

  const api = new Hono();
  mountScmRoutes(api);
  const post = async (op: string, body: unknown) => {
    const res = await api.request(`/tasks/t/scm/${op}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() as Record<string, unknown> };
  };

  const staged = () => git(repo, "diff", "--cached", "--name-only").split("\n").filter(Boolean).sort();
  /** 索引里有没有 gitlink（子模块记录）——嵌套仓被 `git add` 收进去就是这个形态。 */
  const gitlinks = () => git(repo, "ls-files", "-s").split("\n").filter((line) => line.startsWith("160000"));

  // ── 1. 解析：嵌套仓进列表，但带着「不能下手」的标记，路径上不留尾斜杠 ─────────
  {
    const status = await readScmStatus(repo);
    assert.deepEqual(
      status.untracked.map((c) => c.path).sort(),
      ["untracked.txt", "vendor-done", "vendor-lib"],
      "嵌套仓要列出来（用户得知道它在），且路径上不留只表示「这是目录」的尾斜杠",
    );
    const nested = status.untracked.filter((c) => c.nested).map((c) => c.path).sort();
    assert.deepEqual(nested, ["vendor-done", "vendor-lib"], "两种嵌套仓都要标出来");
    assert.equal(status.untracked.find((c) => c.path === "untracked.txt")?.nested, false, "普通未跟踪文件不是嵌套仓");
  }

  // ── 2. 单独点嵌套仓：拒绝，并说清楚为什么、下一步该去哪 ──────────────────────
  for (const op of ["stage", "discard"]) {
    const body = op === "stage" ? { paths: ["vendor-lib"] } : { deleteUntracked: ["vendor-lib"] };
    const { status, json } = await post(op, body);
    assert.equal(status, 409, `${op} 单点嵌套仓要拒绝，实际 ${status}`);
    assert.match(String(json.error), /嵌套/, `${op} 的拒绝理由要说清是嵌套仓，而不是一句「路径不合法」`);
    assert.deepEqual(staged(), [], `${op} 被拒之后索引不许变`);
    assert.equal(existsSync(join(repo, "vendor-lib", "inner.txt")), true, `${op} 被拒之后磁盘不许变`);
  }

  // ── 3. 组级暂存：跳过嵌套仓，其它文件照做，并把跳过了谁说出来 ────────────────
  // 这条是这个文件的主目标：此前整批 400，`untracked.txt` 跟着一起没暂存上。
  {
    const { status, json } = await post("stage", { paths: ["untracked.txt", "vendor-lib", "vendor-done"] });
    assert.equal(status, 200, `混着嵌套仓的整批暂存必须成功，实际 ${status}：${json.error ?? ""}`);
    assert.equal(json.affected, 1, "只算真正暂存上的那一个");
    assert.match(String(json.note), /vendor-lib/, "跳过了谁必须说出来，否则用户以为它也暂存上了");
    assert.match(String(json.note), /vendor-done/);
    assert.deepEqual(staged(), ["untracked.txt"], "同一批里的普通文件不许被嵌套仓连坐");
    assert.deepEqual(gitlinks(), [], "嵌套仓绝不能被静默收成 gitlink 子模块记录");
  }

  // ── 4. 未跟踪预览：明说不能预览，而不是回一份空 diff ─────────────────────────
  {
    const res = await api.request("/tasks/t/scm/diff?path=vendor-lib&source=untracked");
    const json = await res.json() as { error?: string; diff?: string };
    assert.notEqual(res.status, 200, "嵌套仓没有可预览的内容，不能装作读到了一份空 diff");
    assert.match(String(json.error), /嵌套/, "预览被拒也要说清是嵌套仓");
  }

  // ── 5. 组级删除：只删点名的普通文件，嵌套仓原封不动 ──────────────────────────
  // `git clean -f` 对嵌套仓一个字节都不删却照样 exit 0，交给它跑就会报「已丢弃 2 个」。
  {
    write(repo, "trash.txt", "trash\n");
    const { status, json } = await post("discard", { deleteUntracked: ["trash.txt", "vendor-lib"] });
    assert.equal(status, 200, `混着嵌套仓的整批删除必须成功，实际 ${status}：${json.error ?? ""}`);
    assert.equal(json.affected, 1, "报账只能算真删掉的那个");
    assert.match(String(json.note), /vendor-lib/);
    assert.equal(existsSync(join(repo, "trash.txt")), false, "点名的普通文件要真删掉");
    assert.equal(existsSync(join(repo, "vendor-lib", "inner.txt")), true, "嵌套仓一个字节都不许动");
  }

  // ── 6. 「暂存全部并提交」：嵌套仓不进这次提交，其余照常 ──────────────────────
  {
    write(repo, "more.txt", "more\n");
    const { status, json } = await post("commit", {
      message: "带上嵌套仓的一次提交", stagePaths: ["more.txt", "vendor-lib", "vendor-done"],
    });
    assert.equal(status, 200, `实际 ${status}：${json.error ?? ""}`);
    assert.match(String(json.note), /vendor-lib/, "提交也要交代跳过了谁——用户以为它进去了");
    assert.deepEqual(
      git(repo, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean).sort(),
      ["more.txt", "untracked.txt"],
      "提交里应当只有普通文件（untracked.txt 是第 3 步暂存上的）",
    );
    assert.deepEqual(gitlinks(), [], "提交之后索引里也不许冒出 gitlink");
  }

  // ── 7. 整批只有嵌套仓：这不是「成功了 0 个」，要拒绝并解释 ────────────────────
  {
    const { status, json } = await post("commit", { message: "只有嵌套仓", stagePaths: ["vendor-lib", "vendor-done"] });
    assert.equal(status, 409, `一个都下不了手时不能装作提交成功，实际 ${status}`);
    assert.match(String(json.error), /嵌套/);
    assert.equal(git(repo, "log", "-1", "--format=%s"), "带上嵌套仓的一次提交", "被拒之后不许多出提交");
  }

  console.log("scm nested ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
