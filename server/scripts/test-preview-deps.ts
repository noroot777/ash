// 「预览缺 node 依赖时，ash 在**项目之外**备一份」（server/src/preview-deps.ts）。
// 跑：npm -w server run test:preview-deps
//
// 钉三件事，每一件都是踩过的：
//
// ① **不许在用户的项目里 install。** 用户的原话是「怎么能因为 ash 去『污染』正常的项目
//    呢？」。所以依赖装进 ash 自己的 `data/deps`（这里用 ASH_DEPS_DIR 指到临时目录），
//    项目里只被读 package.json 和锁文件，工作区里只多一条 node_modules 软链。
// ② **生成的命令要能真跑。** 提示里那几条 `cd` / `ln -s` 是给用户整行粘走的，路径带空格
//    不引号就是 `cd: too many arguments`。这里不看字符串长相，直接**执行**它们。
// ③ **「目录在」不等于「依赖齐」。** `--prod` 装出来的树没有 devDependency 里的 vite，
//    半截的安装会先留下一个空目录 —— 两种都会让「不缺依赖」的结论把诊断整个带偏。
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-preview-deps-"));
// 装到哪由 DEPS_DIR 决定，而它在模块加载时就定了 —— 所以先设环境变量再 import。
process.env.ASH_DEPS_DIR = join(root, "deps");
const { heldCacheOf, nodeDepsAdvice, prepareNodeDeps, pruneNodeDeps, removePreparedLinks }
  = await import("../src/preview-deps.js");
const { missingDepsHint } = await import("../src/preview-log.js");

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`✗ ${name}\n    expected ${e}\n    actual   ${a}`);
  } else {
    console.log(`✓ ${name}`);
  }
}

const dir = (...parts: string[]) => {
  const p = join(root, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
};
const file = (p: string, name: string, body = "") => writeFileSync(join(p, name), body);
/** 「装好了」的样子：非空的 node_modules，`.bin` 里有那个可执行文件。 */
function installed(pkgDir: string, ...bins: string[]) {
  const bin = join(pkgDir, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  for (const name of bins) writeFileSync(join(bin, name), "#!/bin/sh\n");
}
/**
 * 按 ash 的真实布局搭一份任务 worktree：`<主仓>/.worktrees/<taskId>`，里面的 `.git` 是
 * **文件**，写着主仓在哪。位置不能随便挑 —— 「是不是 ash 自己建的隔离工作区」正是按它
 * 判的（见 ashWorktree），随便找个目录伪装成 worktree 会被当成用户自己的检出。
 */
function worktreeOf(repo: string, name: string): string {
  const wt = join(repo, ".worktrees", name);
  mkdirSync(wt, { recursive: true });
  file(wt, ".git", `gitdir: ${join(repo, ".git", "worktrees", name)}\n`);
  return wt;
}
/** worktree 里的一个子目录（建好并返回绝对路径）。 */
const sub = (base: string, ...parts: string[]) => {
  const p = join(base, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
};
/** 把提示里那条以 prefix 开头的反引号命令抠出来。 */
function command(hint: string, prefix: string): string {
  return [...hint.matchAll(/`([^`]+)`/g)].map((m) => m[1]).find((one) => one.startsWith(prefix)) ?? "";
}
const logOf = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

try {
  // —— 主仓那份能用：把两条真实路径给出来 ——
  const repo = dir("repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  file(dir("repo", "front"), "package.json", "{}");
  file(join(repo, "front"), "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  installed(join(repo, "front"), "vite");
  const wt = worktreeOf(repo, "wt-ready");
  file(sub(wt, "front"), "package.json", "{}");
  file(join(wt, "front"), "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  const ready = nodeDepsAdvice(wt);
  check("只报缺依赖的那个子目录", ready.map((a) => a.rel), ["front"]);
  check("按锁文件认包管理器", ready[0]?.pm, "pnpm");
  check("主仓那份能用", ready[0]?.sourceReady, true);
  check("源路径是主仓里的真实目录", ready[0]?.source, join(repo, "front", "node_modules"));
  check("目标路径是任务工作区里的真实目录", ready[0]?.target, join(wt, "front", "node_modules"));
  const readyHint = missingDepsHint("sh: 1: vite: not found\n", ready) ?? "";
  check("提示里是可以整行粘走的真实命令", readyHint.includes(`ln -s ${join(repo, "front", "node_modules")}`), true);
  check("不再出现占位符", readyHint.includes("<项目目录>"), false);

  // —— 「node_modules 目录在」不等于依赖齐 ——
  // 这两种状态一点都不罕见：`--prod` 装的树本来就没有 devDependency 里的 vite；中断的
  // 安装会先把目录留下。判成「不缺依赖」的话，日志里明明写着 `vite: not found`，诊断却
  // 回一句「没发现缺依赖」，再退回带占位符的通用模板 —— 比不说还糟。
  const partial = dir("partial");
  mkdirSync(join(partial, ".git"), { recursive: true });
  file(dir("partial", "front"), "package.json", "{}");
  mkdirSync(join(partial, "front", "node_modules"), { recursive: true });
  check("空的 node_modules 不算装过", nodeDepsAdvice(partial).map((a) => a.rel), ["front"]);
  installed(join(partial, "front"), "tsc"); // 装了别的，就是没有 vite
  check("装了别的就不算缺（不知道缺什么时）", nodeDepsAdvice(partial), []);
  check("知道缺的是 vite 时就认得出来", nodeDepsAdvice(partial, "", "vite").map((a) => a.rel), ["front"]);
  check("它自己有的那个不算缺", nodeDepsAdvice(partial, "", "tsc"), []);
  const partialHint = missingDepsHint("sh: 1: vite: not found\n", nodeDepsAdvice(partial, "", "vite")) ?? "";
  check("于是提示不再退回占位符", partialHint.includes("<项目目录>"), false);

  // —— 主仓那份也不能用：这正是目标项目的形状，必须说破并给出唯一那一步 ——
  const bare = dir("bare-repo");
  mkdirSync(join(bare, ".git"), { recursive: true });
  file(dir("bare-repo", "a4sms-front"), "package.json", "{}");
  file(join(bare, "a4sms-front"), "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  const bareWt = worktreeOf(bare, "wt-empty");
  file(sub(bareWt, "a4sms-front"), "package.json", "{}");
  file(join(bareWt, "a4sms-front"), "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  const empty = nodeDepsAdvice(bareWt);
  check("认出来「借不到」", empty[0]?.sourceReady, false);
  const emptyHint = missingDepsHint("sh: 1: vite: not found\n", empty) ?? "";
  check("明说主仓那份也不能用", emptyHint.includes("主仓那份也不能用"), true);
  check("给出在自己主仓装一次的真实命令", emptyHint.includes(`cd ${join(bare, "a4sms-front")} && pnpm install`), true);
  check("先交代 ash 自己在项目外备过一份", emptyHint.includes("data/deps"), true);
  // 「装完之后呢」也得说，否则用户装完还得自己想起来软链。
  check("装完那一步也给了", emptyHint.includes("装完再"), true);
  // 上一版在这儿写的是「在那儿装不会进任何任务的 diff」—— 只对了一半：node_modules 是被
  // gitignore 了，可**锁文件是跟踪文件**，install 完全可能改写它并跟着任务 diff 走进验收。
  // 一句听着让人放心的错话比不说更坏。
  check("锁文件这个副作用要说破", emptyHint.includes("锁文件是跟踪文件"), true);

  // —— 好几个子项目都缺依赖时，这次卡住的那个排最前 ——
  // a4sms-allinone 就是这个形状（a4sms-app 和 a4sms-front 都没装），但用户这次点的是前端。
  const many = dir("many");
  mkdirSync(join(many, ".git"), { recursive: true });
  file(dir("many", "app"), "package.json", "{}");
  file(dir("many", "front"), "package.json", "{}");
  check("默认按目录名排", nodeDepsAdvice(many).map((a) => a.rel), ["app", "front"]);
  check("命令里提到谁，谁排最前", nodeDepsAdvice(many, "cd front && pnpm run dev").map((a) => a.rel), ["front", "app"]);
  check("并且只有它被标成「这次要的」", nodeDepsAdvice(many, "cd front && pnpm run dev").map((a) => a.mentioned), [true, false]);

  // —— 产物/依赖目录不参与扫描（跟识别预览候选同一份理由）——
  const noisy = dir("noisy");
  mkdirSync(join(noisy, ".git"), { recursive: true });
  file(dir("noisy", "dist"), "package.json", "{}");
  file(dir("noisy", "web"), "package.json", "{}");
  check("只报真项目目录", nodeDepsAdvice(noisy).map((a) => a.rel), ["web"]);

  // —— 不是 worktree（就是主仓本身）：没有「别处那一份」可借，只能在这儿装 ——
  const plain = dir("plain");
  mkdirSync(join(plain, ".git"), { recursive: true });
  file(plain, "package.json", "{}");
  const plainAdvice = nodeDepsAdvice(plain);
  check("根目录自己也算一个包", plainAdvice.map((a) => a.rel), ["."]);
  check("主仓本身没有来源", plainAdvice[0]?.sourceDir, null);
  const plainHint = missingDepsHint("sh: 1: vite: not found\n", plainAdvice) ?? "";
  check("对主仓说的是「在这儿装一次」", plainHint.includes(`cd ${plain} && npm install`), true);

  // ================= 生成的命令必须真能执行 =================
  // 上一版直接把路径拼进命令，带空格的合法路径当场就是 `cd: too many arguments` ——
  // 而这几条命令的**唯一**用途就是被用户整行粘进 shell。所以这里不看长相，直接跑。
  const spaced = dir("repo with space");
  mkdirSync(join(spaced, ".git"), { recursive: true });
  file(dir("repo with space", "front app"), "package.json", "{}");
  installed(join(spaced, "front app"), "vite");
  const spacedWt = worktreeOf(spaced, "wt with space");
  file(sub(spacedWt, "front app"), "package.json", "{}");
  const spacedAdvice = nodeDepsAdvice(spacedWt, "cd 'front app' && npm run dev");
  const spacedHint = missingDepsHint("sh: 1: vite: not found\n", spacedAdvice) ?? "";
  const lnCommand = command(spacedHint, "ln -s");
  check("带空格的路径引起来了", lnCommand.startsWith("ln -s '"), true);
  execFileSync("/bin/sh", ["-c", lnCommand]);
  check(
    "而且照抄一遍真的挂上了软链",
    lstatSync(join(spacedWt, "front app", "node_modules")).isSymbolicLink(),
    true,
  );
  rmSync(join(spacedWt, "front app", "node_modules"), { force: true });

  // 「去主仓装一次」那条同理。用一个假的 pnpm 把 cwd 打出来 —— 命令引对了才进得了目录。
  const fakeBin = dir("fakebin");
  writeFileSync(join(fakeBin, "pnpm"), "#!/bin/sh\npwd\n");
  chmodSync(join(fakeBin, "pnpm"), 0o755);
  const bareSpaced = dir("bare with space");
  mkdirSync(join(bareSpaced, ".git"), { recursive: true });
  file(dir("bare with space", "front app"), "package.json", "{}");
  file(join(bareSpaced, "front app"), "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  const bareSpacedWt = worktreeOf(bareSpaced, "wt2 with space");
  file(sub(bareSpacedWt, "front app"), "package.json", "{}");
  file(join(bareSpacedWt, "front app"), "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  const installHint = missingDepsHint("sh: 1: vite: not found\n", nodeDepsAdvice(bareSpacedWt)) ?? "";
  const cdCommand = command(installHint, "cd ");
  check("装依赖那条也引了", cdCommand.includes("'"), true);
  const where = execFileSync("/bin/sh", ["-c", cdCommand], {
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    encoding: "utf8",
  }).trim();
  check("跑起来确实进了那个带空格的目录", where, join(bareSpaced, "front app"));

  // ================= ash 自己备依赖：项目一个字节都不许被写 =================
  // ① 主仓已经有一份能用的、package.json 又一致 → 直接软链，不联网、不写任何人的项目。
  const borrowLog = join(root, "borrow.log");
  writeFileSync(borrowLog, "");
  const borrowed = await prepareNodeDeps(wt, "cd front && pnpm run dev", borrowLog);
  check("借得到就借", borrowed.map((one) => one.ok), [true]);
  check("挂的是主仓那份", lstatSync(join(wt, "front", "node_modules")).isSymbolicLink(), true);
  check("日志里说清楚了挂的是什么", logOf(borrowLog).includes("借用主仓已经装好的那份"), true);
  check("主仓没有被写（只多了我们自己造的那点东西）", existsSync(join(repo, "front", "node_modules", ".bin", "vite")), true);
  rmSync(join(wt, "front", "node_modules"), { force: true });

  // package.json 不一致就不借：这个任务很可能刚加了依赖，借一份旧树只会给出更难懂的报错。
  file(join(wt, "front"), "package.json", "{\"dependencies\":{\"left-pad\":\"1.0.0\"}}");
  const stale = nodeDepsAdvice(wt);
  check("不一致时事实层面仍然「能借」", stale[0]?.sourceReady, true);
  const staleLog = join(root, "stale.log");
  writeFileSync(staleLog, "");
  const staleTried = await prepareNodeDeps(wt, "cd front && pnpm run dev", staleLog);
  check("但备依赖不会把那份旧树挂过来", staleTried[0]?.detail.startsWith("借用主仓"), false);
  rmSync(join(wt, "front", "node_modules"), { force: true, recursive: true });

  // ② 真装一次。用 `file:` 依赖，全程不联网 —— 这条要证明的是链路（复制清单 → 在 ash 自己
  //    的目录里装 → 挂软链），不是 npm 会不会下包。
  const dep = dir("fakedep");
  file(dep, "package.json", JSON.stringify({ name: "fakedep", version: "1.0.0", bin: { fakevite: "cli.js" } }));
  file(dep, "cli.js", "#!/usr/bin/env node\nconsole.log('hi')\n");
  const installRepo = dir("install-repo");
  mkdirSync(join(installRepo, ".git"), { recursive: true });
  const installWt = worktreeOf(installRepo, "wt-install");
  const pkg = sub(installWt, "front");
  file(pkg, "package.json", JSON.stringify({
    name: "front", version: "1.0.0", private: true, dependencies: { fakedep: `file:${dep}` },
  }));
  const installLog = join(root, "install.log");
  writeFileSync(installLog, "");
  const installed1 = await prepareNodeDeps(installWt, "cd front && npm run dev", installLog);
  check("装成了", installed1.map((one) => one.ok), [true]);
  const linked = join(pkg, "node_modules");
  check("工作区里只多了一条软链", lstatSync(linked).isSymbolicLink(), true);
  check("软链指向 ash 自己的目录", readFileSync(join(linked, ".bin", "fakevite"), "utf8").length > 0, true);
  check("依赖装在 ASH_DEPS_DIR 下", existsSync(join(root, "deps")), true);
  check("项目目录里没有被塞进 node_modules 实体", lstatSync(linked).isDirectory(), false);
  check("日志里交代了在项目外装", logOf(installLog).includes("在项目外备依赖"), true);
  // 同样内容的第二次不该再装一遍（内容哈希命中）。
  rmSync(linked, { force: true });
  const again = await prepareNodeDeps(installWt, "cd front && npm run dev", installLog);
  check("第二次直接复用", again[0]?.detail.startsWith("复用 ash 之前备好的依赖"), true);

  // ③ workspaces 装不出正确的树 —— 认出来就别硬来，如实说。
  const wsRepo = dir("ws-repo");
  mkdirSync(join(wsRepo, ".git"), { recursive: true });
  const wsWt = worktreeOf(wsRepo, "wt-ws");
  file(sub(wsWt, "front"), "package.json", JSON.stringify({ name: "f", workspaces: ["packages/*"] }));
  const wsLog = join(root, "ws.log");
  writeFileSync(wsLog, "");
  const ws = await prepareNodeDeps(wsWt, "cd front && npm run dev", wsLog);
  check("workspaces 不硬装", ws[0]?.ok, false);
  check("而且说得出原因", ws[0]?.detail.includes("workspaces"), true);
  check("原因也进了预览日志", logOf(wsLog).includes("workspaces"), true);

  // ④ 工作区里已经有一份**非空的真目录**时不许动它 —— 删掉是不可逆的。
  const keepRepo = dir("keep-repo");
  mkdirSync(join(keepRepo, ".git"), { recursive: true });
  const keepWt = worktreeOf(keepRepo, "wt-keep");
  const keepPkg = sub(keepWt, "front");
  file(keepPkg, "package.json", JSON.stringify({ name: "front", version: "1.0.0", dependencies: { fakedep: `file:${dep}` } }));
  mkdirSync(join(keepPkg, "node_modules"), { recursive: true });
  file(join(keepPkg, "node_modules"), "someone-elses-file", "x");
  const keepLog = join(root, "keep.log");
  writeFileSync(keepLog, "");
  const kept = await prepareNodeDeps(keepWt, "cd front && npm run dev", keepLog);
  check("已经有一份非空的就当没事发生", kept, []);
  check("那份东西还在", existsSync(join(keepPkg, "node_modules", "someone-elses-file")), true);
  check("也没有被换成软链", lstatSync(join(keepPkg, "node_modules")).isSymbolicLink(), false);
  // 空目录是另一回事：那是半截安装的残留，可以清掉重挂。
  rmSync(join(keepPkg, "node_modules"), { recursive: true, force: true });
  mkdirSync(join(keepPkg, "node_modules"), { recursive: true });
  const relinked = await prepareNodeDeps(keepWt, "cd front && npm run dev", keepLog);
  check("空目录会被清掉重挂", relinked[0]?.ok, true);
  check("挂上的是软链", lstatSync(join(keepPkg, "node_modules")).isSymbolicLink(), true);

  // ⑤ 装不上不该拦住预览：命令照跑（可能它根本不需要 node 依赖），失败理由留给诊断。
  const badRepo = dir("bad-repo");
  mkdirSync(join(badRepo, ".git"), { recursive: true });
  const badWt = worktreeOf(badRepo, "wt-bad");
  // 让 install 必然失败，而且不靠网络：一份读不动的 package.json。
  file(sub(badWt, "front"), "package.json", "{ this is not json }");
  const badLog = join(root, "bad.log");
  writeFileSync(badLog, "");
  const bad = await prepareNodeDeps(badWt, "cd front && npm run dev", badLog);
  check("装不上就如实说", bad[0]?.ok, false);
  check("不留半截的树给下次「复用」", existsSync(join(badWt, "front", "node_modules")), false);
  const badHint = missingDepsHint("sh: 1: vite: not found\n", nodeDepsAdvice(badWt, "cd front", "vite"), bad) ?? "";
  check("失败理由进了给用户的下一步", badHint.includes(bad[0]?.detail ?? "!"), true);

  // ⑤b 预览收掉时把我们挂的撤干净 —— 用户敲 `git status` 不该看见 ash 留下的东西
  //    （前端的 .gitignore 写的是 `node_modules/`，只匹配目录，匹配不上软链）。
  //    只撤软链：真目录一律不动。
  const linkPath = installed1[0]?.link ?? "";
  check("成功时报出了自己挂的那条", linkPath, join(pkg, "node_modules"));
  removePreparedLinks([linkPath]);
  check("收预览后工作区里什么都不剩", existsSync(linkPath), false);
  check("依赖本体还在 ash 自己的目录里（下次秒挂）", existsSync(join(root, "deps")), true);
  removePreparedLinks([join(keepPkg, "node_modules")]); // 这次目标是真目录（上面重挂过，是软链）
  const realDir = join(root, "real-node-modules");
  mkdirSync(realDir, { recursive: true });
  removePreparedLinks([realDir]);
  check("真目录一律不动", existsSync(realDir), true);

  // ⑤b2 **并发**：缓存的键是清单内容的哈希，所以「两个任务同时第一次预览同一个前端」
  //      不是巧合，是正常路径。原来判「装好没有」只看 node_modules 非空 —— 第一个 install
  //      刚落下第一个文件，第二个就会挂软链开跑，拿着一棵仍在长的树；更糟的是装之前那句
  //      rmSync 会把对方正装到一半的目录删掉。现在装在临时目录里、装完写标记再原子 rename。
  const slowBin = dir("slowbin");
  writeFileSync(
    join(slowBin, "npm"),
    // 先落一个文件（旧判据在这一刻就会认为「装好了」），2 秒后才补齐 .bin
    "#!/bin/sh\nmkdir -p node_modules/half\nsleep 2\nmkdir -p node_modules/.bin\n"
      + "touch node_modules/.bin/done\n",
    { mode: 0o755 },
  );
  const parallelPkg = JSON.stringify({ name: "front", version: "1.0.0", private: true });
  const twoTasks = ["wt-race-a", "wt-race-b"].map((name) => {
    const repoDir = dir(`${name}-repo`);
    mkdirSync(join(repoDir, ".git"), { recursive: true });
    const wtDir = worktreeOf(repoDir, name);
    file(sub(wtDir, "front"), "package.json", parallelPkg);
    return wtDir;
  });
  const raceLog = join(root, "race.log");
  writeFileSync(raceLog, "");
  const path0 = process.env.PATH;
  process.env.PATH = `${slowBin}:${path0 ?? ""}`;
  const depsDir = join(root, "deps");
  const before = readdirSync(depsDir);
  try {
    const first = prepareNodeDeps(twoTasks[0], "cd front && npm run dev", raceLog);
    await new Promise((r) => setTimeout(r, 700)); // 让第一趟装到一半
    const midway = readdirSync(depsDir).filter((n) => !before.includes(n));
    check("装到一半时只有临时目录", midway.every((n) => n.includes(".installing.")), true);
    check("而且确实有一个在装", midway.length > 0, true);
    const second = prepareNodeDeps(twoTasks[1], "cd front && npm run dev", raceLog);
    const [a, b] = await Promise.all([first, second]);
    check("两个都成了", [a[0]?.ok, b[0]?.ok], [true, true]);
    // 关键断言：第二个拿到的树必须是**装完的**那棵，不是半截的。
    for (const [i, wtDir] of twoTasks.entries()) {
      check(`第 ${i + 1} 个任务拿到的是完整的树`, existsSync(join(wtDir, "front", "node_modules", ".bin", "done")), true);
    }
    const after = readdirSync(depsDir).filter((n) => !before.includes(n));
    check("装完了不留临时目录", after.filter((n) => n.includes(".installing.")), []);
    check("同样的内容只留一份缓存", after.length, 1);
  } finally {
    process.env.PATH = path0;
  }
  removePreparedLinks(twoTasks.map((w) => join(w, "front", "node_modules")));

  // ⑤c 长期没人用的那几份要清掉：一份前端依赖几百兆，涨的是**用户的磁盘**。
  const deps = join(root, "deps");
  const cached = readdirSync(deps);
  check("先确认确实装了一份在这儿", cached.length > 0, true);
  pruneNodeDeps();
  check("最近用过的不动", readdirSync(deps).length, cached.length);
  const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60_000);
  for (const name of cached) utimesSync(join(deps, name), longAgo, longAgo);
  pruneNodeDeps();
  check("三十天没人用的清掉", readdirSync(deps), []);

  // ⑤d **正被一个活着的预览用着的那份，多老也不能删。** 清理只看 mtime，而缓存只在挂链
  //     那一刻 touch 过一次；自由预览是 `life: "task"`，一个任务等人验收等上三十天完全合法。
  //     删掉的后果不是下次慢一点：工作区那条软链还在、只是断了，dev server 按需加载下一个
  //     模块时才炸，而记录上它还好端端地跑着。
  const fastBin = dir("fastbin");
  writeFileSync(join(fastBin, "npm"), "#!/bin/sh\nmkdir -p node_modules/.bin\ntouch node_modules/.bin/done\n", { mode: 0o755 });
  const withFakeNpm = async <T>(work: () => Promise<T>): Promise<T> => {
    const saved = process.env.PATH;
    process.env.PATH = `${fastBin}:${saved ?? ""}`;
    try { return await work(); } finally { process.env.PATH = saved; }
  };
  const heldRepo = dir("held-repo");
  mkdirSync(join(heldRepo, ".git"), { recursive: true });
  const heldWt = worktreeOf(heldRepo, "wt-held");
  file(sub(heldWt, "front"), "package.json", JSON.stringify({ name: "held", version: "1.0.0", private: true }));
  const heldLog = join(root, "held.log");
  writeFileSync(heldLog, "");
  const heldPrepared = await withFakeNpm(() => prepareNodeDeps(heldWt, "cd front && npm run dev", heldLog));
  const heldLink = heldPrepared[0]?.link ?? "";
  check("先装上一份并挂好", [heldPrepared[0]?.ok, existsSync(heldLink)], [true, true]);
  const heldCache = heldCacheOf(heldLink);
  check("顺着软链认得出是哪份缓存", heldCache !== null && readdirSync(deps).includes(heldCache.split("/").pop() ?? ""), true);
  check("指向别处的软链不算", heldCacheOf(join(root, "real-node-modules")), null);
  utimesSync(heldCache ?? "", longAgo, longAgo); // 预览跑到第三十一天
  pruneNodeDeps([heldCache ?? ""]);
  check("还被用着就不许删", existsSync(heldCache ?? ""), true);
  check("那条软链也还指得到东西", existsSync(join(heldLink, ".bin", "done")), true);
  check("而且顺手续了租（下一轮不会又擦边）", Date.now() - statSync(heldCache ?? "").mtimeMs < 60_000, true);
  removePreparedLinks([heldLink]);
  utimesSync(heldCache ?? "", longAgo, longAgo);
  pruneNodeDeps([]); // 预览收掉之后，同一份就该按年龄清掉了
  check("没人用了才清", existsSync(heldCache ?? ""), false);

  // ⑤e **相对路径依赖装不出正确的树，而且包管理器不会报错。** `file:../shared` 相对的是
  //     项目里的目录，搬进 ash 的隔离目录就指到隔壁去了 —— npm 退出码照样 0，只留下一条
  //     断链，等应用真去 import 才炸，那时 ash 已经宣称「依赖装好了」。
  const relRepo = dir("rel-repo");
  mkdirSync(join(relRepo, ".git"), { recursive: true });
  const relWt = worktreeOf(relRepo, "wt-rel");
  file(sub(relWt, "shared"), "package.json", JSON.stringify({ name: "rel-shared", version: "1.0.0" }));
  file(sub(relWt, "front"), "package.json", JSON.stringify({
    name: "front", version: "1.0.0", private: true, dependencies: { "rel-shared": "file:../shared" },
  }));
  const relLog = join(root, "rel.log");
  writeFileSync(relLog, "");
  const rel = await prepareNodeDeps(relWt, "cd front && npm run dev", relLog);
  check("相对路径依赖不硬装", rel[0]?.ok, false);
  check("理由说清楚是哪一条", rel[0]?.detail.includes("rel-shared: file:../shared"), true);
  check("也没留下一条断链给下一步", existsSync(join(relWt, "front", "node_modules")), false);

  // ⑤e2 同一类毛病的兜底：退出码 0 不等于这棵树能用。装完扫一眼顶层，有断链就当没装成
  //     （锁文件里记着本地路径、装到一半被打断，都会长这样）。
  const ghostBin = dir("ghostbin");
  writeFileSync(join(ghostBin, "npm"), "#!/bin/sh\nmkdir -p node_modules/@scope\nln -s ../../nowhere node_modules/@scope/ghost\n", { mode: 0o755 });
  const ghostRepo = dir("ghost-repo");
  mkdirSync(join(ghostRepo, ".git"), { recursive: true });
  const ghostWt = worktreeOf(ghostRepo, "wt-ghost");
  file(sub(ghostWt, "front"), "package.json", JSON.stringify({ name: "ghost", version: "1.0.0", private: true }));
  const ghostLog = join(root, "ghost.log");
  writeFileSync(ghostLog, "");
  const savedPath = process.env.PATH;
  process.env.PATH = `${ghostBin}:${savedPath ?? ""}`;
  let ghost: Awaited<ReturnType<typeof prepareNodeDeps>>;
  try { ghost = await prepareNodeDeps(ghostWt, "cd front && npm run dev", ghostLog); }
  finally { process.env.PATH = savedPath; }
  check("装出断链就不算装成了", ghost[0]?.ok, false);
  check("说清楚断的是哪一条", ghost[0]?.detail.includes("@scope/ghost"), true);
  check("半截的树不留下来给下次「复用」", readdirSync(deps).filter((n) => n.startsWith("front-")).length, 0);

  // ⑤f **一起复制过去的配置改了，缓存就得失效。** `.npmrc` 里的 `omit=dev` 会让装出来的树
  //     没有 devDependency（vite 就在那儿）。用户把配置改对、再点预览，如果键没变，命中的
  //     还是那棵缺东西的旧树，ash 还会告诉他「复用之前备好的依赖」—— 他要么等三十天，要么
  //     自己去翻 ash 的私有缓存目录。
  const cfgRepo = dir("cfg-repo");
  mkdirSync(join(cfgRepo, ".git"), { recursive: true });
  const cfgWt = worktreeOf(cfgRepo, "wt-cfg");
  const cfgPkg = sub(cfgWt, "front");
  file(cfgPkg, "package.json", JSON.stringify({ name: "cfg", version: "1.0.0", private: true }));
  file(cfgPkg, ".npmrc", "omit=dev\n");
  const cfgLog = join(root, "cfg.log");
  writeFileSync(cfgLog, "");
  const cfgFirst = await withFakeNpm(() => prepareNodeDeps(cfgWt, "cd front && npm run dev", cfgLog));
  check("第一次照着当时的配置装", cfgFirst[0]?.ok, true);
  removePreparedLinks([cfgFirst[0]?.link ?? ""]); // 收掉预览，用户去改配置
  const cfgAgain = await withFakeNpm(() => prepareNodeDeps(cfgWt, "cd front && npm run dev", cfgLog));
  check("配置没动就该复用", cfgAgain[0]?.detail.startsWith("复用"), true);
  removePreparedLinks([cfgAgain[0]?.link ?? ""]);
  file(cfgPkg, ".npmrc", "\n"); // 用户把 omit=dev 删了
  const cfgFixed = await withFakeNpm(() => prepareNodeDeps(cfgWt, "cd front && npm run dev", cfgLog));
  check("配置改了就重新装，不拿旧树糊弄", cfgFixed[0]?.detail.startsWith("复用"), false);
  check("改完照样是成功的", cfgFixed[0]?.ok, true);
  removePreparedLinks([cfgFixed[0]?.link ?? ""]);

  // ⑤g **不是 ash 自己的隔离工作区，就一条软链都不挂。** 任务默认不开 worktree，那种
  //     任务的工作区就是用户的项目检出本身；依赖装在项目外只解决了「本体」，入口那条
  //     软链照样是写进人家的目录（`git status` 看得见，`life: task` 还能挂好几天）。
  //     用户的原话是「怎么能因为 ash 去『污染』正常的项目呢？」——「最终会撤」不是「没写」。
  const checkout = dir("plain-checkout");
  mkdirSync(join(checkout, ".git"), { recursive: true }); // 普通检出：.git 是目录
  file(sub(checkout, "front"), "package.json", JSON.stringify({ name: "plain", version: "1.0.0", private: true }));
  const checkoutLog = join(root, "plain.log");
  writeFileSync(checkoutLog, "");
  const depsBefore = readdirSync(join(root, "deps")).length;
  const checkoutTried = await withFakeNpm(() => prepareNodeDeps(checkout, "cd front && npm run dev", checkoutLog));
  check("普通检出不代备依赖", checkoutTried[0]?.ok, false);
  check("说清楚为什么（以及怎么办）", checkoutTried[0]?.detail.includes("worktree"), true);
  check("用户的项目里什么都没多出来", existsSync(join(checkout, "front", "node_modules")), false);
  check("也没有偷偷装一份", readdirSync(join(root, "deps")).length, depsBefore);
  const checkoutHint = missingDepsHint("sh: 1: vite: not found\n", nodeDepsAdvice(checkout, "cd front", "vite"), checkoutTried) ?? "";
  check("理由进了给用户的下一步", checkoutHint.includes(checkoutTried[0]?.detail ?? "!"), true);
  // 开头那句话也得换：这不是「ash 备依赖失败了」，是「ash 根本不会往你的项目里放东西」。
  // 说成前者，用户会去等一个永远不会发生的自动补救。
  check("开头不说「这次没成」那一套", checkoutHint.includes("这次没成"), false);
  check("而是说清楚 ash 不往项目里写", checkoutHint.includes("不往你的项目目录里写任何东西"), true);
  check("还得给出他自己能走的那条路", checkoutHint.includes("得在这儿装一次"), true);
  // 用户自己 `git worktree add` 出来的检出也是 worktree，但那同样是**他的**目录：
  // 判据必须严到「住在主仓的 .worktrees/ 下面」，不能只看 `.git` 是不是文件。
  const ownRepo = dir("own-repo");
  mkdirSync(join(ownRepo, ".git"), { recursive: true });
  const ownWt = dir("my-own-worktree");
  file(ownWt, ".git", `gitdir: ${join(ownRepo, ".git", "worktrees", "my-own-worktree")}\n`);
  file(sub(ownWt, "front"), "package.json", JSON.stringify({ name: "own", version: "1.0.0", private: true }));
  const ownTried = await withFakeNpm(() => prepareNodeDeps(ownWt, "cd front && npm run dev", checkoutLog));
  check("用户自己开的 worktree 也不碰", [ownTried[0]?.ok, existsSync(join(ownWt, "front", "node_modules"))], [false, false]);

  // ⑤h **借主仓那份，得连锁文件和安装配置一起对上。** 只比 package.json 是不够的：
  //     任务里最常见的改动之一就是只动锁文件（升传递依赖、解冲突），清单一个字不变 ——
  //     借一棵按旧锁装出来的树，等于把预览页面建在跟这次提交不一致的依赖上，而它最会
  //     掩盖的恰恰是锁升级带来的回归。
  const lockRepo = dir("lock-repo");
  mkdirSync(join(lockRepo, ".git"), { recursive: true });
  const lockManifest = JSON.stringify({ name: "lockcase", version: "1.0.0", private: true });
  const repoFront = sub(lockRepo, "front");
  file(repoFront, "package.json", lockManifest);
  file(repoFront, "package-lock.json", JSON.stringify({ name: "lockcase", packages: { "node_modules/x": { version: "1.0.0" } } }));
  installed(repoFront, "vite"); // 主仓那份「能用」
  const lockWt = worktreeOf(lockRepo, "wt-lock");
  const wtFront = sub(lockWt, "front");
  file(wtFront, "package.json", lockManifest); // 清单完全一样
  file(wtFront, "package-lock.json", JSON.stringify({ name: "lockcase", packages: { "node_modules/x": { version: "2.0.0" } } }));
  const lockLog = join(root, "lock.log");
  writeFileSync(lockLog, "");
  const lockTried = await withFakeNpm(() => prepareNodeDeps(lockWt, "cd front && npm run dev", lockLog));
  check("锁文件不一样就不借主仓", lockTried[0]?.detail.startsWith("借用主仓"), false);
  check("而是按这个任务自己的锁装一份", lockTried[0]?.ok, true);
  removePreparedLinks([lockTried[0]?.link ?? ""]);
  // 配置同理：清单和锁都一样，`.npmrc` 不一样也不能借。
  file(wtFront, "package-lock.json", JSON.stringify({ name: "lockcase", packages: { "node_modules/x": { version: "1.0.0" } } }));
  file(wtFront, ".npmrc", "omit=dev\n");
  const cfgTried = await withFakeNpm(() => prepareNodeDeps(lockWt, "cd front && npm run dev", lockLog));
  check("安装配置不一样也不借", cfgTried[0]?.detail.startsWith("借用主仓"), false);
  removePreparedLinks([cfgTried[0]?.link ?? ""]);
  // 三样都对上了才借 —— 这条路本身还得是通的。
  rmSync(join(wtFront, ".npmrc"), { force: true });
  const borrowedNow = await withFakeNpm(() => prepareNodeDeps(lockWt, "cd front && npm run dev", lockLog));
  check("三样都一致才借主仓", borrowedNow[0]?.detail.startsWith("借用主仓"), true);
  removePreparedLinks([borrowedNow[0]?.link ?? ""]);

  // ⑥ 没有 node 包目录时什么都不做（Java 项目点预览不该被拖进 npm 的世界）。
  const java = dir("java");
  mkdirSync(join(java, ".git"), { recursive: true });
  file(java, "pom.xml", "<project/>");
  const javaLog = join(root, "java.log");
  writeFileSync(javaLog, "");
  check("不是 node 项目就不插手", await prepareNodeDeps(java, "mvn spring-boot:run", javaLog), []);
  check("日志也不该被写脏", logOf(javaLog), "");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} 条没过` : "\npreview-deps 全部通过");
process.exit(failures ? 1 : 0);
