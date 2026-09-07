// 「缺 node 依赖时，可借的那一份到底在不在」（server/src/preview-deps.ts）。
// 跑：npm -w server run test:preview-deps
//
// 钉的是一条**说了等于没说**的建议：预览因为 `vite: not found` 退出时，ash 让用户
// 「把主仓已经装好的那份 node_modules 软链进来」。这句话假设主仓那份存在 —— 而目标项目
// （a4sms-allinone）的 a4sms-front 在主仓里也没有 node_modules。于是建议指向一个不存在
// 的源目录，照做只会得到一个断链，整件事没有闭环。
//
// 所以这里核对三件事：缺依赖的是哪个包目录、该用哪个包管理器（按锁文件）、主仓那份在不在。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeDepsAdvice } from "../src/preview-deps.js";
import { missingDepsHint } from "../src/preview-log.js";

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

const root = mkdtempSync(join(tmpdir(), "ash-preview-deps-"));
const dir = (...parts: string[]) => {
  const p = join(root, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
};
const file = (p: string, name: string, body = "") => writeFileSync(join(p, name), body);
/** 按 git 的真实布局搭一份主仓 + worktree：worktree 里的 `.git` 是**文件**，写着主仓在哪。 */
function worktreeOf(repo: string, name: string): string {
  const wt = dir(name);
  file(wt, ".git", `gitdir: ${join(repo, ".git", "worktrees", name)}\n`);
  return wt;
}

try {
  // —— 主仓那份在：把两条真实路径直接给出来 ——
  const repo = dir("repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  file(dir("repo", "front"), "package.json", "{}");
  file(join(repo, "front"), "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  mkdirSync(join(repo, "front", "node_modules"), { recursive: true });
  const wt = worktreeOf(repo, "wt-ready");
  file(dir("wt-ready", "front"), "package.json", "{}");
  file(join(wt, "front"), "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  const ready = nodeDepsAdvice(wt);
  check("只报缺依赖的那个子目录", ready.map((a) => a.rel), ["front"]);
  check("按锁文件认包管理器", ready[0]?.pm, "pnpm");
  check("主仓那份在", ready[0]?.sourceReady, true);
  check("源路径是主仓里的真实目录", ready[0]?.source, join(repo, "front", "node_modules"));
  check("目标路径是任务工作区里的真实目录", ready[0]?.target, join(wt, "front", "node_modules"));
  const readyHint = missingDepsHint("sh: 1: vite: not found\n", ready) ?? "";
  check("提示里是可以整行粘走的真实命令", readyHint.includes(`ln -s ${join(repo, "front", "node_modules")} ${join(wt, "front", "node_modules")}`), true);
  check("不再出现占位符", readyHint.includes("<项目目录>"), false);

  // —— 主仓那份也不在：这正是目标项目的形状，必须说破并给出唯一那一步 ——
  const bare = dir("bare-repo");
  mkdirSync(join(bare, ".git"), { recursive: true });
  file(dir("bare-repo", "a4sms-front"), "package.json", "{}");
  file(join(bare, "a4sms-front"), "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  const bareWt = worktreeOf(bare, "wt-empty");
  file(dir("wt-empty", "a4sms-front"), "package.json", "{}");
  file(join(bareWt, "a4sms-front"), "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  const empty = nodeDepsAdvice(bareWt);
  check("认出来「借不到」", empty[0]?.sourceReady, false);
  const emptyHint = missingDepsHint("sh: 1: vite: not found\n", empty) ?? "";
  check("明说主仓那份也不在", emptyHint.includes("主仓那份也不在"), true);
  check("给出在自己主仓装一次的真实命令", emptyHint.includes(`cd ${join(bare, "a4sms-front")} && pnpm install`), true);
  check("并说明那样不会进任何任务 diff", emptyHint.includes("不会进任何任务的 diff"), true);
  check("仍然明说 ash 不替你装", emptyHint.includes("ash 不会替你装"), true);
  // 「装完之后呢」也得说，否则用户装完还得自己想起来软链。
  check("装完那一步也给了", emptyHint.includes("装完再"), true);

  // —— 装好了就不该再被点名 ——
  mkdirSync(join(bareWt, "a4sms-front", "node_modules"), { recursive: true });
  check("有 node_modules 的目录不算缺", nodeDepsAdvice(bareWt), []);
  check("一个都不缺时退回通用说法", (missingDepsHint("sh: 1: vite: not found\n", nodeDepsAdvice(bareWt)) ?? "").includes("<项目目录>"), true);

  // —— 不是 worktree（就是主仓本身）：没有「别处那一份」可借，只能在这儿装 ——
  const plain = dir("plain");
  mkdirSync(join(plain, ".git"), { recursive: true });
  file(plain, "package.json", "{}");
  const plainAdvice = nodeDepsAdvice(plain);
  check("根目录自己也算一个包", plainAdvice.map((a) => a.rel), ["."]);
  check("主仓本身没有来源", plainAdvice[0]?.sourceDir, null);
  const plainHint = missingDepsHint("sh: 1: vite: not found\n", plainAdvice) ?? "";
  check("对主仓说的是「在这儿装一次」", plainHint.includes(`cd ${plain} && npm install`), true);

  // —— 产物/依赖目录不参与扫描（跟识别预览候选同一份理由）——
  const noisy = dir("noisy");
  mkdirSync(join(noisy, ".git"), { recursive: true });
  file(dir("noisy", "dist"), "package.json", "{}");
  file(dir("noisy", "web"), "package.json", "{}");
  check("只报真项目目录", nodeDepsAdvice(noisy).map((a) => a.rel), ["web"]);

  // —— 好几个子项目都缺依赖时，这次卡住的那个排最前 ——
  // a4sms-allinone 就是这个形状（a4sms-app 和 a4sms-front 都没装），但用户这次点的是前端。
  const many = dir("many");
  mkdirSync(join(many, ".git"), { recursive: true });
  file(dir("many", "app"), "package.json", "{}");
  file(dir("many", "front"), "package.json", "{}");
  check("默认按目录名排", nodeDepsAdvice(many).map((a) => a.rel), ["app", "front"]);
  check("命令里提到谁，谁排最前", nodeDepsAdvice(many, "cd front && pnpm run dev").map((a) => a.rel), ["front", "app"]);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} 条没过` : "\npreview-deps 全部通过");
process.exit(failures ? 1 : 0);
