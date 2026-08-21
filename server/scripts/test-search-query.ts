import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-search-"));
process.env.ASH_DB = join(root, "ash.db");

// 动态 import:search.js 连带打开 DB,得等 ASH_DB 指到临时库之后再加载。
const [{ db, ensureSchema }, { projects, tasks }, search, { parseWorktreePorcelain }] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/search.js"),
  import("../src/git-overview.js"),
]);
const { isTaskIdMatch, matchesSearchQuery, parseSearchQuery, searchAll, taskIdCandidates } = search;

const matches = (text: string, query: string) => matchesSearchQuery(text, parseSearchQuery(query));

assert.equal(matches("人工智能正在改变机器学习", "人工智能 机器学习"), true);
assert.equal(matches("只有人工智能", "人工智能 机器学习"), false);
assert.equal(matches("机器学习入门", "人工智能 | 机器学习"), true);
assert.equal(matches("旅游攻略与景点", "旅游攻略 -购物"), true);
assert.equal(matches("旅游攻略与购物清单", "旅游攻略 -购物"), false);
assert.equal(matches("人工智能与机器学习", '"人工智能与机器学习"'), true);
assert.equal(matches("人工智能以及机器学习", '"人工智能与机器学习"'), false);
assert.equal(matches("claude-3 模型", "claude-3"), true);

// ── 按任务 id 命中 ────────────────────────────────────────────────────────
const candidates = (query: string) => taskIdCandidates(parseSearchQuery(query));
// 合成 id,不能用真实存在过的任务 id:下面要靠「语料里根本没有这串字符」证明
// 命中是凭 id 注入的,撞上一个真的 data/runs/<id>/ 就会因为错误的原因通过。
const TASK_ID = "Zx8Kq2mNrT4V";

// 整串 id、分支短 id、以及粘贴 URL / 分支名 / kv 写法都要认出 id 本体。
assert.deepEqual(candidates(TASK_ID), ["zx8kq2mnrt4v"]);
assert.deepEqual(candidates("ash/Zx8Kq2mN"), ["zx8kq2mn"]);
assert.deepEqual(candidates(`http://localhost:4317/tasks/${TASK_ID}`), ["localhost", "zx8kq2mnrt4v"]);
assert.deepEqual(candidates(`taskId=${TASK_ID}`), ["zx8kq2mnrt4v"]);
// 太短的词不是 id,别拿它去撞任务。
assert.deepEqual(candidates("修复 bug"), []);
assert.deepEqual(candidates("Zx8Kq2m"), []);
// `-<id>` 是排除语法:用户说了别看这条,就不能反过来把它钉到第一位。
assert.deepEqual(candidates(`-${TASK_ID}`), []);
assert.deepEqual(candidates(`修复 -${TASK_ID}`), []);

assert.equal(isTaskIdMatch(TASK_ID, "zx8kq2mnrt4v"), true, "整串 id 大小写不敏感");
assert.equal(isTaskIdMatch(TASK_ID, "zx8kq2mn"), true, "分支短 id 是前缀命中");
assert.equal(isTaskIdMatch("aBcDeFgHiJkL", "zx8kq2mnrt4v"), false);
assert.equal(isTaskIdMatch(TASK_ID, "x8kq2mnrt4v"), false, "只认前缀,不做子串");

const worktrees = parseWorktreePorcelain(
  "worktree /repo\0HEAD abc123\0branch refs/heads/main\0\0" +
    "worktree /repo/.worktrees/task\0HEAD def456\0branch refs/heads/ash/task\0\0",
);
assert.deepEqual(worktrees, [
  { path: "/repo", branch: "main", head: "abc123", detached: false },
  { path: "/repo/.worktrees/task", branch: "ash/task", head: "def456", detached: false },
]);

// ── searchAll:搜 id 时那个任务必须排第一,而且是「凭 id」排上来的 ──────────
await ensureSchema();
const at = new Date().toISOString();
try {
  await db.insert(projects).values({ id: "project", name: "搜索", repoPath: root, createdAt: at });
  await db.insert(tasks).values([
    // 关键点:被搜的这个任务,标题和正文里都没有自己的 id——没有注入这一路,
    // 它是搜不到自己的(还没跑过的任务连会话记录都没有)。
    { id: TASK_ID, projectId: "project", title: "被搜的那个任务", body: "正文里不含自己的 id", createdAt: at, updatedAt: at },
    { id: "MentionsIt1", projectId: "project", title: "提到它的另一个任务", body: `派给 ${TASK_ID} 去做`, createdAt: at, updatedAt: at },
  ]);

  const byId = await searchAll(TASK_ID);
  assert.equal(byId[0]?.id, TASK_ID, "搜任务 id,那个任务必须排在第一位");
  assert.equal(byId[0]?.field, "id", "并且标成 id 命中——界面据此打「就是这个任务」");
  const mention = byId.find((hit) => hit.id === "MentionsIt1");
  assert.ok(mention, "正文里提到该 id 的任务照常命中,只是排在后面");
  assert.notEqual(mention?.field, "id", "别人提到它不等于别人就是它");

  const byBranch = await searchAll(`ash/${TASK_ID.slice(0, 8)}`);
  assert.equal(byBranch[0]?.id, TASK_ID, "分支名里的 8 位短 id 也要能定位到任务");
  assert.equal(byBranch[0]?.field, "id");

  const byUrl = await searchAll(`http://localhost:4317/tasks/${TASK_ID}`);
  assert.equal(byUrl[0]?.id, TASK_ID, "直接粘 URL 也算");

  const excluded = await searchAll(`-${TASK_ID}`);
  assert.equal(excluded.some((hit) => hit.field === "id"), false, "`-<id>` 是排除语法,不能反过来把它钉上来");

  assert.equal((await searchAll("修复")).length, 0, "普通词不该误撞任何任务 id");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("search query + task-id + git overview parser tests passed");
