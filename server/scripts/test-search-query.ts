import assert from "node:assert/strict";
import { matchesSearchQuery, parseSearchQuery } from "../src/search.js";
import { parseWorktreePorcelain } from "../src/git-overview.js";

const matches = (text: string, query: string) => matchesSearchQuery(text, parseSearchQuery(query));

assert.equal(matches("人工智能正在改变机器学习", "人工智能 机器学习"), true);
assert.equal(matches("只有人工智能", "人工智能 机器学习"), false);
assert.equal(matches("机器学习入门", "人工智能 | 机器学习"), true);
assert.equal(matches("旅游攻略与景点", "旅游攻略 -购物"), true);
assert.equal(matches("旅游攻略与购物清单", "旅游攻略 -购物"), false);
assert.equal(matches("人工智能与机器学习", '"人工智能与机器学习"'), true);
assert.equal(matches("人工智能以及机器学习", '"人工智能与机器学习"'), false);
assert.equal(matches("claude-3 模型", "claude-3"), true);

const worktrees = parseWorktreePorcelain(
  "worktree /repo\0HEAD abc123\0branch refs/heads/main\0\0" +
    "worktree /repo/.worktrees/task\0HEAD def456\0branch refs/heads/harness/task\0\0",
);
assert.deepEqual(worktrees, [
  { path: "/repo", branch: "main", head: "abc123", detached: false },
  { path: "/repo/.worktrees/task", branch: "harness/task", head: "def456", detached: false },
]);

console.log("search query + git overview parser tests passed");
