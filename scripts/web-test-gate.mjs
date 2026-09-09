// 前端回归闸。被 .githooks/pre-push 调用。
//
// 背景:2026-09-09 把 33 条前端回归从 `npm -w web run build` 的前置里摘了出去(理由见
// web/package.json 的 `//build`)。摘掉之后仓库里就没有任何东西会自动跑它们了 —— 这个
// 仓库没有 CI,build 前置曾是唯一的运行时机。这个脚本把兜底补在 push 上。
//
// 为什么是 pre-push 而不是 pre-commit:agent 每完成一个单元就提交一次(AGENTS.md
// 「Git 仓库改动立即提交」),挂 pre-commit 等于把刚摘掉的等待原样搬到每一次提交上,
// 比原来更糟。push 是「代码离开这台机器」的那一下,一次 push 覆盖多次提交,频率对得上
// 一次全量回归的代价。
//
// 三条刻意的设计:
//  - **按路径判断**:本次推送的提交没碰 web/ 与 shared/ 就直接放行。server 侧的改动
//    不该为前端测试买单。
//  - **没装依赖时如实警告并放行**(fail-open):worktree 里常态没有 node_modules
//    (记录见 docs/incidents.md 与 AGENTS.md 周边),硬拦会把 worktree 的 push 天天挡死。
//    但绝不静默 —— 放行时把「这次没跑」印在终端上。
//  - **给得起明路**:拦下来时同时给出 `--no-verify` 和 SKIP_WEB_TEST=1 两条出路。闸的
//    作用是让人知情,不是把人锁死。
//
// 换机器/新克隆后需要一次性执行:git config core.hooksPath .githooks
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const ZERO = /^0+$/;

// 碰了这些前缀才跑。shared/ 在内是因为前端回归里有一批直接断言 shared 的逻辑
// (isTeamSettled、sameExecutor 之类),改了它而不跑前端测试等于漏掉真会红的那部分。
const WATCHED = ["web/", "shared/"];

const say = (line) => process.stdout.write(`${line}\n`);

const git = (args, input) => {
  try {
    return execFileSync("git", args, { cwd: REPO, encoding: "utf8", input });
  } catch {
    return null;
  }
};

/** pre-push 从 stdin 收到的是若干行 `<local ref> <local sha> <remote ref> <remote sha>`。 */
function readRefLines() {
  try {
    // fd 0 直读:hook 的 stdin 是管道,读完即 EOF。拿不到(手工跑、被重定向)就当空。
    return readFileSync(0, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 本次推送真正新增的提交都改了哪些文件。
 *
 * 分两步:先 `rev-list` 圈出「这次真正新增的提交」,再 `diff-tree` 逐个列文件。
 *
 * ① remote sha 全 0 = 远端还没有这个分支,不能拿它当起点(会变成「和空树比」,整个仓库
 *    都算改动)。这种情况改问 git「哪些提交是所有远端分支都还没有的」,只算那一段。
 *    `--not --remotes` 是 rev-list 的语法,`git diff A..B` 写不出这一条,所以两条路统一
 *    走 rev-list。
 *
 * ② `diff-tree` 必须带 **`-c`**:merge commit 按 git 惯例不输出 diff,而这个仓库的主流程
 *    正是「worktree 里提交 → 主仓 merge → push」—— 解冲突时手改到 web/ 的那几行只存在于
 *    merge commit 自身,被合并进来的普通提交里没有。少了 -c,这类改动会让闸整个静默跳过
 *    (第 1 轮审查复现:两个父都只改 README、merge 时手改 web/view.txt → 报「没碰 web/」)。
 *    `-c` 给出 combined diff,正好是「跟所有父都不同」的那部分。`--root` 让没有父的首个
 *    提交也列得出文件。回归见 scripts/test-web-test-gate.mjs。
 */
function changedPaths(lines) {
  const paths = new Set();
  for (const line of lines) {
    const [, localSha, , remoteSha] = line.split(/\s+/);
    if (!localSha || ZERO.test(localSha)) continue; // 删除分支,没有内容要检
    const revs = git(ZERO.test(remoteSha || "")
      ? ["rev-list", localSha, "--not", "--remotes"]
      : ["rev-list", `${remoteSha}..${localSha}`]);
    if (!revs?.trim()) continue;
    const out = git(["diff-tree", "-r", "-c", "--root", "--no-commit-id", "--name-only", "--stdin"], revs);
    for (const p of (out ?? "").split("\n")) if (p) paths.add(p);
  }
  return [...paths];
}

/** 依赖装没装。web 的测试跑在 node/tsx/puppeteer 上,少哪一层都跑不起来。 */
function depsReady() {
  return existsSync(join(REPO, "node_modules")) && existsSync(join(REPO, "node_modules", ".bin"));
}

if (process.env.SKIP_WEB_TEST) {
  say("  ⏭ SKIP_WEB_TEST=1:跳过前端回归。");
  process.exit(0);
}

const lines = readRefLines();
if (!lines.length) {
  say("  (读不到要推送的 ref,跳过 —— 手工跑这个脚本时正常。)");
  process.exit(0);
}

const changed = changedPaths(lines);

// 闸自己被改了就先自检。它只要 node + git,不吃 node_modules —— 所以连下面那条
// 「没装依赖就放行」都绕不过它,worktree 里照样跑得动。第 1 轮审查那个 merge 漏检
// 就是这一条钉住的。
const SELF = ["scripts/web-test-gate.mjs", "scripts/test-web-test-gate.mjs", ".githooks/pre-push"];
const selfTest = join(REPO, "scripts", "test-web-test-gate.mjs");
if (changed.some((p) => SELF.includes(p)) && existsSync(selfTest)) {
  say("  ▶ 这次推送改到了闸自己,先跑它的回归…");
  const self = spawnSync(process.execPath, [selfTest], {
    cwd: REPO,
    stdio: "inherit",
  });
  if (self.status !== 0) {
    say("  ✕ 闸自己的回归没过 —— 已拦下这次 push。复跑:npm run test:web-gate");
    process.exit(1);
  }
}

const hits = changed.filter((p) => WATCHED.some((w) => p.startsWith(w)));
if (!hits.length) {
  say(`  ✓ 本次推送的 ${changed.length} 处改动没碰 ${WATCHED.join(" / ")},跳过前端回归。`);
  process.exit(0);
}

if (!depsReady()) {
  say(`  ⚠ 本次推送碰了 ${hits.length} 个 ${WATCHED.join(" / ")} 下的文件,但这里没有 node_modules —— **前端回归没跑**,照旧放行。`);
  say("     (worktree 常态如此。想跑就先 npm install,或到主仓跑 npm run test:web。)");
  process.exit(0);
}

say(`  ▶ 本次推送碰了 ${hits.length} 个 ${WATCHED.join(" / ")} 下的文件,跑一遍前端回归(几分钟)…`);
for (const p of hits.slice(0, 6)) say(`     · ${p}`);
if (hits.length > 6) say(`     · …另外 ${hits.length - 6} 个`);

const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
const res = spawnSync(npmBin, ["run", "test:web"], { cwd: REPO, stdio: "inherit", shell: process.platform === "win32" });
if (res.status !== 0) {
  say("");
  say("  ✕ 前端回归没过 —— 已拦下这次 push。");
  say("     单独复跑:      npm run test:web");
  say("     明知故推:      git push --no-verify");
  say("                    SKIP_WEB_TEST=1 git push");
  process.exit(1);
}
say("  ✓ 前端回归通过。");
process.exit(0);
