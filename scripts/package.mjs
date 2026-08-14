#!/usr/bin/env node
// 打一个可以直接发给别人的分发包。
//
//   npm run package                 # 打 HEAD,产物落 dist-package/
//   REF=main npm run package        # 打指定 ref
//   OUT=/tmp npm run package        # 换产物目录
//   FORMAT=zip npm run package      # 换产物格式(tar.gz / zip)
//
// 用 `git archive` 而不是 `tar czf .`:只装**入库的文件**,于是 data/(SQLite 库里有
// 你的 API key、任务正文、run 产物)、node_modules/、.worktrees/、*.log 一律不可能
// 混进去 —— 靠人肉 --exclude 迟早会漏,这类漏的代价是把密钥发出去。
//
// 收件人拿到之后:解包 → node scripts/setup.mjs(见 docs/install.md)。
//
// 2026-08-14 从 package.sh 改写成 .mjs:tar.gz 三个平台通吃(Windows 10 1803 起自带
// bsdtar),但 du/shasum 不是,而这些只是「报个大小和校验和」—— 用 node 内置做掉。
// 同日补 zip:Windows 收件人**双击就能解**,不必先知道 tar 在不在。两种格式都由
// `git archive` 原生产出,不引第三方打包器,所以默认值按**打包机**的平台走就行 ——
// 真要发给另一边的人,`FORMAT=` 明写一下。安装器(MSI/NSIS)没做:它要签名、卸载、
// 升级三条链路,而这个包解开之后还得 `npm install` + 构建,不是「装完就能用」的形态。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IS_WINDOWS, which } from "./platform.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
process.chdir(REPO);

const REF = process.env.REF || "HEAD";
const OUT = process.env.OUT || join(REPO, "dist-package");
const FORMAT = (process.env.FORMAT || (IS_WINDOWS ? "zip" : "tar.gz")).toLowerCase();

const say = (line = "") => process.stdout.write(`${line}\n`);
const die = (line) => { say(line); process.exit(1); };

function git(args, opts = {}) {
  const res = spawnSync("git", args, { encoding: "utf8", windowsHide: true, ...opts });
  return { status: res.status ?? 1, stdout: (res.stdout ?? "").trim() };
}

if (!which("git")) die("✕ 需要 git");
if (FORMAT !== "tar.gz" && FORMAT !== "zip") die(`✕ FORMAT 只支持 tar.gz 或 zip,收到:${FORMAT}`);
if (git(["rev-parse", "--git-dir"]).status !== 0) die("✕ 这里不是 git 仓库,没法用 git archive 打包");
if (git(["rev-parse", "--verify", REF]).status !== 0) die(`✕ 找不到 ref: ${REF}`);

const sha = git(["rev-parse", "--short", REF]).stdout;
const now = new Date();
const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
const name = `harness-${stamp}-${sha}`;
const archive = join(OUT, `${name}.${FORMAT}`);

// 未提交的改动不会进包 —— 说清楚,别让人以为「我刚改的那行也发出去了」。
const dirty = git(["diff", "--quiet", "HEAD"]).status !== 0;
const untracked = git(["ls-files", "--others", "--exclude-standard"]).stdout !== "";
if (dirty || untracked) {
  say(`⚠ 工作区有未提交/未入库的改动,它们**不会**进包(打的是 ${REF}=${sha})。`);
  say("  要一起发出去就先提交,再重跑。");
}

mkdirSync(OUT, { recursive: true });
say(`▶ 打包 ${REF} (${sha}) → ${archive}`);
// --prefix:解包后自成一个目录,不会把文件炸进对方的当前目录。
const archived = git(["archive", `--format=${FORMAT}`, `--prefix=${name}/`, "-o", archive, REF], { stdio: "inherit" });
if (archived.status !== 0) die("✕ 打包失败");

const bytes = statSync(archive).size;
const mb = bytes / 1024 / 1024;
say(`✓ 完成:${archive} (${mb >= 1 ? `${mb.toFixed(1)}M` : `${Math.max(1, Math.round(bytes / 1024))}K`})`);
say();
say("包里**没有**(也不该有):data/(库+密钥+run 产物)、node_modules/、.worktrees/、*.log");

const hash = createHash("sha256");
for await (const chunk of createReadStream(archive)) hash.update(chunk);
say("校验和(可一并发给对方核对):");
say(`${hash.digest("hex")}  ${archive}`);
say();
say("告诉收件人这么做:");
if (FORMAT === "zip") {
  say(`  Windows:在资源管理器里右键「全部解压缩」,或 PowerShell:Expand-Archive ${name}.zip .`);
  say(`  然后:cd ${name} && node scripts/setup.mjs`);
} else {
  say(`  tar xzf ${name}.tar.gz && cd ${name} && node scripts/setup.mjs`);
}
say("(细节与排错见包内 docs/install.md)");
