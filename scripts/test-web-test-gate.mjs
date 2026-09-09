// scripts/web-test-gate.mjs 的回归。
//
// 在临时 git 仓库里造出各种推送场景,把 pre-push 的 stdin 喂给闸,断言它「跑 / 跳过 / 拦下」
// 三选一选对。跑法:npm run test:web-gate
//
// 头号用例是 **merge commit 自身的改动**:这个仓库的主流程是「worktree 里提交 → 主仓 merge
// → push」,解冲突时手改到 web/ 的那几行只存在于 merge commit 本身。第 1 轮审查复现过闸在
// 这一条上整个静默跳过,所以它必须一直被钉住。
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REAL_GATE = fileURLToPath(new URL("web-test-gate.mjs", import.meta.url));
const WIN = process.platform === "win32";
const ZERO = "0".repeat(40);

// 每条用例建的临时仓库都登记在这儿,由 runner 统一清 —— 用例里各自 rmSync 的话,
// 断言一失败就 throw 到 rmSync 之前,红一条留一个目录。
const made = [];

/** 造一个自带 scripts/web-test-gate.mjs 副本的空仓库。 */
function makeRepo() {
  // 必须**复制**而不是软链:node 默认解析软链的真实路径,脚本的 `new URL("..")` 会指回
  // 本仓库,测出来的就不是这个临时仓库了。
  const dir = mkdtempSync(join(tmpdir(), "web-gate-"));
  made.push(dir);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  cpSync(REAL_GATE, join(dir, "scripts", "web-test-gate.mjs"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main", ".");
  git("config", "user.email", "gate@test");
  git("config", "user.name", "gate");
  // 副本不入库:否则每个 fixture 的首个提交都带着 scripts/web-test-gate.mjs,闸会把它
  // 当成「改到了自己」而去跑自检,测的就不是本用例想测的东西了。
  writeFileSync(join(dir, ".gitignore"), "scripts/\n");
  return { dir, git };
}

function write(dir, rel, text) {
  const abs = join(dir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, text);
}

/** 假装依赖装好了 —— 闸只看 node_modules/.bin 在不在。 */
function fakeDeps(dir) {
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
}

/** 前置一个必然返回 code 的假 npm,用来断言「跑了测试」以及测试红/绿两条出口。 */
function fakeNpm(dir, code) {
  const bin = join(dir, "fakebin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "npm"), `#!/bin/sh\necho "(fake npm $*)"\nexit ${code}\n`, { mode: 0o755 });
  if (WIN) writeFileSync(join(bin, "npm.cmd"), `@echo off\r\necho (fake npm %*)\r\nexit /b ${code}\r\n`);
  return bin;
}

/** 跑一次闸,返回 {out, status}。refLines 就是 git 喂给 pre-push 的那几行。 */
function runGate(dir, refLines, { npmBin, env } = {}) {
  const res = spawnSync(process.execPath, [join(dir, "scripts", "web-test-gate.mjs")], {
    input: refLines.map((l) => `${l}\n`).join(""),
    encoding: "utf8",
    env: {
      ...process.env,
      ...(npmBin ? { PATH: `${npmBin}${WIN ? ";" : ":"}${process.env.PATH}` } : {}),
      ...env,
    },
  });
  return { out: `${res.stdout}${res.stderr}`, status: res.status };
}

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test("merge commit 自身改到 web/ —— 两个父都没碰,也必须跑", () => {
  const { dir, git } = makeRepo();
  write(dir, "README.md", "base");
  write(dir, "web/view.txt", "v0");
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");

  git("checkout", "-qb", "feat");
  write(dir, "README.md", "feat");
  git("commit", "-qam", "feat");

  git("checkout", "-q", "main");
  write(dir, "README.md", "main");
  git("commit", "-qam", "main");

  // 冲突 merge:两个父都只动 README,解冲突时顺手改了 web/ —— 这一改只存在于 merge 自身。
  try {
    git("merge", "feat", "-q");
  } catch {
    /* 冲突是预期的 */
  }
  write(dir, "README.md", "resolved");
  write(dir, "web/view.txt", "TOUCHED");
  git("add", "-A");
  git("commit", "-qm", "merge");
  const head = git("rev-parse", "HEAD");

  fakeDeps(dir);
  const { out, status } = runGate(dir, [`refs/heads/main ${head} refs/heads/main ${base}`], {
    npmBin: fakeNpm(dir, 0),
  });
  assert.match(out, /本次推送碰了/, `merge 自身的 web/ 改动被漏掉了:\n${out}`);
  assert.match(out, /web\/view\.txt/, out);
  assert.match(out, /前端回归通过/, out);
  assert.equal(status, 0);
});

test("merge 结果等同某一个父,但相对远端确实改了 web/ —— 也必须跑", () => {
  // 第 2 轮审查的复现:combined diff(`diff-tree -c`)只列「跟所有父都不同」的路径,
  // 这个场景里 web/view.txt 的最终内容跟 side 那个父一模一样,于是被整个漏掉 ——
  // 可它相对**远端要被更新的那个 sha**(main 合并前)明明变了。
  const { dir, git } = makeRepo();
  write(dir, "README.md", "base");
  write(dir, "web/view.txt", "base");
  git("add", "-A");
  git("commit", "-qm", "base");

  git("checkout", "-qb", "side");
  write(dir, "README.md", "side");
  git("commit", "-qam", "side"); // side 没动 web/

  git("checkout", "-q", "main");
  write(dir, "README.md", "main");
  write(dir, "web/view.txt", "main-web"); // 远端那一版的 web/ 是这个
  git("commit", "-qam", "main");
  const remote = git("rev-parse", "HEAD"); // ← 这次 push 要更新的就是这个 sha

  try {
    git("merge", "side", "-q");
  } catch {
    /* 冲突是预期的 */
  }
  write(dir, "README.md", "resolved");
  write(dir, "web/view.txt", "base"); // 改回 side 父那一版 → combined diff 里它是空的
  git("add", "-A");
  git("commit", "-qm", "merge");
  const head = git("rev-parse", "HEAD");

  // 前提校验:净 diff 里确实有 web/view.txt,否则这条用例就没在测想测的东西。
  assert.match(git("diff", "--name-only", remote, head), /web\/view\.txt/);

  fakeDeps(dir);
  const { out, status } = runGate(dir, [`refs/heads/main ${head} refs/heads/main ${remote}`], {
    npmBin: fakeNpm(dir, 0),
  });
  assert.match(out, /本次推送碰了/, `merge 结果等同某个父时被漏掉了:\n${out}`);
  assert.match(out, /web\/view\.txt/, out);
  assert.equal(status, 0);
});

test("算不出推送范围时保守照跑,不静默跳过", () => {
  const { dir, git } = makeRepo();
  write(dir, "README.md", "base");
  git("add", "-A");
  git("commit", "-qm", "base");
  const head = git("rev-parse", "HEAD");
  // 远端 sha 本地根本没有(没 fetch 过对方的分支)——diff 算不出来。
  const ghost = "1".repeat(40);

  fakeDeps(dir);
  const { out, status } = runGate(dir, [`refs/heads/main ${head} refs/heads/main ${ghost}`], {
    npmBin: fakeNpm(dir, 0),
  });
  assert.match(out, /算不出改了哪些文件/, out);
  assert.doesNotMatch(out, /跳过前端回归/, `算不出范围时静默跳过了:\n${out}`);
  assert.match(out, /前端回归通过/, out);
  assert.equal(status, 0);

  // 新分支那条路(remote sha 全 0)也一样:local sha 本地就没有 → 算不出,同样得保守跑。
  const ghostLocal = runGate(dir, [`refs/heads/topic ${"2".repeat(40)} refs/heads/topic ${ZERO}`], {
    npmBin: fakeNpm(dir, 0),
  });
  assert.match(ghostLocal.out, /算不出改了哪些文件/, ghostLocal.out);
  assert.doesNotMatch(ghostLocal.out, /跳过前端回归/, ghostLocal.out);
  assert.equal(ghostLocal.status, 0);
});

test("把文件从 web/ 或 shared/ 搬走 —— rename 也得算碰过", () => {
  // 第 3 轮审查的复现:`git diff --name-only` 对纯 rename 只报目标路径,web/thing.ts →
  // server/thing.ts 会显示成「只碰了 server/」,可前端那边确实少了一个文件。
  for (const from of ["web/thing.ts", "shared/thing.ts"]) {
    const { dir, git } = makeRepo();
    write(dir, "README.md", "base");
    write(dir, from, "export const x = 1;");
    git("add", "-A");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");

    mkdirSync(join(dir, "server"), { recursive: true });
    git("mv", from, "server/thing.ts");
    git("commit", "-qm", `move ${from} out`);
    const head = git("rev-parse", "HEAD");

    fakeDeps(dir);
    // 假 npm 返回 1:漏检就会静默 exit 0,真跑了才会被拦下 —— 两种结果分得开。
    const { out, status } = runGate(dir, [`refs/heads/main ${head} refs/heads/main ${base}`], {
      npmBin: fakeNpm(dir, 1),
    });
    assert.match(out, /前端回归没过 —— 已拦下这次 push/, `从 ${from} 搬走被漏掉了:\n${out}`);
    assert.equal(status, 1, out);
  }
});

test("只碰 server/ —— 跳过,不跑测试", () => {
  const { dir, git } = makeRepo();
  write(dir, "README.md", "base");
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  write(dir, "server/src/a.ts", "export const a = 1;");
  git("add", "-A");
  git("commit", "-qm", "server only");
  const head = git("rev-parse", "HEAD");

  fakeDeps(dir);
  // 给一个必然失败的假 npm:真跑了就会红,红了就说明「跳过」没生效。
  const { out, status } = runGate(dir, [`refs/heads/main ${head} refs/heads/main ${base}`], {
    npmBin: fakeNpm(dir, 1),
  });
  assert.match(out, /没碰 web\/ \/ shared\/,跳过/, out);
  assert.equal(status, 0);
});

test("shared/ 也算,且测试红了要拦下 push", () => {
  const { dir, git } = makeRepo();
  write(dir, "README.md", "base");
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  write(dir, "shared/src/x.ts", "export const x = 1;");
  git("add", "-A");
  git("commit", "-qm", "shared");
  const head = git("rev-parse", "HEAD");

  fakeDeps(dir);
  const { out, status } = runGate(dir, [`refs/heads/main ${head} refs/heads/main ${base}`], {
    npmBin: fakeNpm(dir, 1),
  });
  assert.match(out, /前端回归没过 —— 已拦下这次 push/, out);
  assert.match(out, /--no-verify/, out);
  assert.equal(status, 1);
});

test("新分支(remote sha 全 0)只算未推送的提交,不退化成全仓库", () => {
  const { dir, git } = makeRepo();
  write(dir, "README.md", "base");
  write(dir, "web/old.txt", "已经推过的前端文件");
  git("add", "-A");
  git("commit", "-qm", "base");
  // 假装 base 已经在远端:闸用 `--not --remotes` 排除它。
  git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
  write(dir, "server/src/b.ts", "export const b = 1;");
  git("add", "-A");
  git("commit", "-qm", "server only");
  const head = git("rev-parse", "HEAD");

  fakeDeps(dir);
  const { out, status } = runGate(dir, [`refs/heads/topic ${head} refs/heads/topic ${ZERO}`], {
    npmBin: fakeNpm(dir, 1),
  });
  // 全仓库 diff 会把 base 里的 web/old.txt 算进来 → 误跑。只算新提交才是对的。
  assert.match(out, /没碰 web\/ \/ shared\/,跳过/, out);
  assert.equal(status, 0);
});

test("首个提交(没有父)也列得出文件", () => {
  const { dir, git } = makeRepo();
  write(dir, "web/first.txt", "root commit 里的前端文件");
  git("add", "-A");
  git("commit", "-qm", "root");
  const head = git("rev-parse", "HEAD");

  fakeDeps(dir);
  const { out } = runGate(dir, [`refs/heads/main ${head} refs/heads/main ${ZERO}`], { npmBin: fakeNpm(dir, 0) });
  assert.match(out, /web\/first\.txt/, `root commit 的文件没列出来:\n${out}`);
});

test("没装依赖时如实警告并放行", () => {
  const { dir, git } = makeRepo();
  write(dir, "README.md", "base");
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  write(dir, "web/a.tsx", "export const A = () => null;");
  git("add", "-A");
  git("commit", "-qm", "web");
  const head = git("rev-parse", "HEAD");

  const { out, status } = runGate(dir, [`refs/heads/main ${head} refs/heads/main ${base}`]);
  assert.match(out, /没有 node_modules/, out);
  assert.match(out, /前端回归没跑/, out);
  assert.equal(status, 0);
});

test("删除分支 / 无 stdin / SKIP_WEB_TEST 都放行", () => {
  const { dir, git } = makeRepo();
  write(dir, "web/a.tsx", "export const A = () => null;");
  git("add", "-A");
  git("commit", "-qm", "web");
  const head = git("rev-parse", "HEAD");
  fakeDeps(dir);
  const npmBin = fakeNpm(dir, 1); // 真跑了就会红

  const del = runGate(dir, [`(delete) ${ZERO} refs/heads/gone ${head}`], { npmBin });
  assert.equal(del.status, 0, del.out);

  const empty = runGate(dir, [], { npmBin });
  assert.match(empty.out, /读不到要推送的 ref/, empty.out);
  assert.equal(empty.status, 0);

  const skipped = runGate(dir, [`refs/heads/main ${head} refs/heads/main ${ZERO}`], {
    npmBin,
    env: { SKIP_WEB_TEST: "1" },
  });
  assert.match(skipped.out, /SKIP_WEB_TEST/, skipped.out);
  assert.equal(skipped.status, 0);
});

test("闸自己被改动时先跑它自己的回归,红了就拦下", () => {
  for (const [selfExit, expect, wantStatus] of [
    [1, /闸自己的回归没过/, 1],
    [0, /先跑它的回归/, 0],
  ]) {
    const { dir, git } = makeRepo();
    write(dir, "README.md", "base");
    git("add", "-A");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    // 只碰闸自己,不碰 web/ —— 所以走到这一步的唯一理由就是自检。
    git("add", "-f", "scripts/web-test-gate.mjs");
    git("commit", "-qm", "改闸自己");
    const head = git("rev-parse", "HEAD");
    // 假的自检脚本:真跑一遍会递归进这个文件本身,这里只要它的退出码。
    write(dir, "scripts/test-web-test-gate.mjs", `process.exit(${selfExit});\n`);

    const { out, status } = runGate(dir, [`refs/heads/main ${head} refs/heads/main ${base}`]);
    assert.match(out, expect, out);
    assert.equal(status, wantStatus, out);
  }
});

let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (err) {
    failed++;
    process.stdout.write(`  ✕ ${name}\n${err.message}\n`);
  } finally {
    while (made.length) rmSync(made.pop(), { recursive: true, force: true });
  }
}
process.stdout.write(failed ? `web-test-gate: ${failed}/${cases.length} 条失败\n` : `web-test-gate: ${cases.length} 条全过\n`);
process.exit(failed ? 1 : 0);
