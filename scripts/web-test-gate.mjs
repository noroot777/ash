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
// git 的空树对象,拿它当「什么都还没有」的 diff 基准(首个提交没有父时用)。
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

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
 * 这次推送会让远端 ref 变成什么样 —— 净变化的文件清单。
 *
 * **判据是 ref 级的净 diff,不是 commit 级的**。push 改变的是远端那个 ref 的最终状态,
 * 所以问题只有一个:`remoteSha` 的树和 `localSha` 的树差在哪。绕道去逐个提交列文件会
 * 掉进 merge 的两个坑里,前两轮审查各撞了一个:
 *   · `git log --name-only` 按惯例不为 merge 输出 diff → 解冲突时手改的 web/ 全漏(第 1 轮)。
 *   · `diff-tree -c` 只列「跟**所有**父都不同」的路径 → merge 结果等同某一个父时也漏。
 *     具体地:main 把 web/view.txt 改成 A、side 没动它,merge 时把它改回 side 那版 ——
 *     相对远端(main 合并前)明明变了,combined diff 却是空的(第 2 轮)。
 * `git diff --name-only <remoteSha> <localSha>` 对这两种情况都直接给出正确答案。
 *
 * remote sha 全 0 = 远端还没有这个分支,没有「旧状态」可比。这时先圈出「所有远端 ref 都
 * 还没有的提交」,取它们踩在远端上的那些父提交当基准(见 boundaryBases),再照样做净 diff。
 *
 * 算不出来时(远端 sha 本地没有、仓库状态异常)返回 unknown —— 交由调用方保守处理:
 * 闸的作用是拦,静默当成「没碰」正是它失效的样子。
 */
/** 算不出来时返回 null(交给调用方标 unknown),而不是「没有新提交」的空数组。 */
function boundaryBases(localSha) {
  const raw = git(["rev-list", localSha, "--not", "--remotes"]);
  if (raw === null) return null;
  const revs = raw.split("\n").filter(Boolean);
  if (!revs.length) return []; // 这些提交远端全都有了,没有新东西要检
  const inRange = new Set(revs);
  const bases = new Set();
  for (const sha of revs) {
    const line = git(["rev-list", "--parents", "-n", "1", sha]);
    if (line === null) return null;
    const parents = line.trim().split(/\s+/).slice(1);
    // 没有父 = 仓库的首个提交,基准就是空树(整棵树都是新的)。
    if (!parents.length) bases.add(EMPTY_TREE);
    for (const p of parents) if (!inRange.has(p)) bases.add(p);
  }
  return [...bases];
}

function changedPaths(lines) {
  const paths = new Set();
  let unknown = false;
  for (const line of lines) {
    const [, localSha, , remoteSha] = line.split(/\s+/);
    if (!localSha || ZERO.test(localSha)) continue; // 删除分支,没有内容要检
    // 新分支可能踩在多个远端祖先上(比如这条链里带 merge),对每个基准各算一次并集 ——
    // 宁可多列几个文件多跑一次测试,也不漏。
    const bases = ZERO.test(remoteSha || "") ? boundaryBases(localSha) : [remoteSha];
    if (bases === null) {
      unknown = true;
      continue;
    }
    for (const base of bases) {
      // `--no-renames`:rename 默认只报**目标**路径,把文件从 web/ 搬去 server/ 会显示成
      // 「只碰了 server/」—— 可前端那边实实在在少了一个文件。关掉检测,rename 拆成「删源
      // 路径 + 加目标路径」,源路径才落回 web/(第 3 轮审查复现)。
      const out = git(["diff", "--no-renames", "--name-only", base, localSha]);
      if (out === null) {
        unknown = true;
        continue;
      }
      for (const p of out.split("\n")) if (p) paths.add(p);
    }
  }
  return { paths: [...paths], unknown };
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

const { paths: changed, unknown } = changedPaths(lines);

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
// 「算不出改了哪些文件」不等于「没改」。远端 sha 本地没有(没 fetch 过)这类情况下静默
// 跳过,正是这道闸失效的样子 —— 宁可白跑一次也要如实说出来。
if (unknown) say("  ⚠ 有一段推送范围算不出改了哪些文件(远端 sha 本地没有?),保守起见照跑。");
if (!hits.length && !unknown) {
  say(`  ✓ 本次推送的 ${changed.length} 处改动没碰 ${WATCHED.join(" / ")},跳过前端回归。`);
  process.exit(0);
}

const what = hits.length ? `碰了 ${hits.length} 个 ${WATCHED.join(" / ")} 下的文件` : "范围算不清";
if (!depsReady()) {
  say(`  ⚠ 本次推送${what},但这里没有 node_modules —— **前端回归没跑**,照旧放行。`);
  say("     (worktree 常态如此。想跑就先 npm install,或到主仓跑 npm run test:web。)");
  process.exit(0);
}

say(`  ▶ 本次推送${what},跑一遍前端回归(几分钟)…`);
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
