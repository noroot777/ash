#!/usr/bin/env node
// 跑 npm install 之前先回答一个问题:这份代码里的 workspace 齐不齐。
//
//   node scripts/workspace-check.mjs        # 单独跑;不齐就列出缺什么并退 1
//
// 为什么值得单独一道闸:workspace 之间靠 `"@harness/shared": "*"` 互相引用,而
// `@harness/*` 这些名字**公共 registry 上根本不存在**。只要 npm 没能把 shared/ 认成
// 本地 workspace(目录没解出来、workspaces 数组漏了它、在子目录里跑的 install),它就
// 会拿这个名字去 registry.npmjs.org 上找,然后报:
//
//   npm error code E404
//   npm error 404 Not Found - GET https://registry.npmjs.org/@harness%2fshared
//
// 这条错**读起来像断网**,于是人会去查代理、换镜像源、重装 node —— 而真正缺的是一个
// 本地目录。2026-08-20 一台 Windows 新机装机就卡在这儿;当时 setup.mjs 给的提示
// (「没网/代理没配/npm registry 不通」)还把方向指反了。所以在开始下载之前先自查,
// 把这类失败翻译成人话 —— 顺带省掉「等几分钟才炸」。
//
// 判据不写死 `@harness`:先收集本地 workspace 的 name,取它们的 scope,再看有没有哪个
// 依赖落在同一个 scope 下却找不到对应 workspace。以后换 scope 名不用回来改这里。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

/** 缺一个目录和缺一个字段的处置是同一句话,两个调用点共用,别各写各的。 */
export const WORKSPACE_FAIL_HINT = [
  "这不是网络问题:npm 会把这些本地包名当公共包去 registry 上找,报一条读起来像断网的 404。",
  "多半是包没解全(或杀软/网盘按需下载吞了文件),也可能这条命令不是在仓库根跑的。",
];

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** npm 认两种写法:`workspaces: []` 和 `workspaces: { packages: [] }`。 */
function workspaceGlobs(root) {
  if (Array.isArray(root?.workspaces)) return root.workspaces;
  if (Array.isArray(root?.workspaces?.packages)) return root.workspaces.packages;
  return [];
}

const scopeOf = (name) => (name?.startsWith("@") && name.includes("/") ? name.slice(0, name.indexOf("/")) : null);

/**
 * @param {string} repo 仓库根的绝对路径
 * @returns {{ ok: boolean, problems: string[], hints: string[], names: string[] }}
 */
export function inspectWorkspaces(repo) {
  /** @type {string[]} */ const problems = [];
  /** @type {string[]} */ const hints = [];

  const root = readJson(join(repo, "package.json"));
  if (!root) {
    problems.push(`${join(repo, "package.json")} 读不出来 —— 这里不是仓库根,或者文件没解出来/损坏了`);
    return { ok: false, problems, hints, names: [] };
  }

  const globs = workspaceGlobs(root);
  if (!globs.length) {
    problems.push("根 package.json 里没有 workspaces 字段 —— 本地包会被当成公共包去 registry 上找");
    return { ok: false, problems, hints, names: [] };
  }

  // 通配条目不展开:这个仓库的 workspaces 全是字面量目录,真加了 glob 也只是少查一条 ——
  // 不值得在这里塞一个半吊子的实现去猜 npm 的匹配规则,那种「查了但查得不对」更坏。
  for (const g of globs) if (g.includes("*")) hints.push(`workspaces 里的通配条目 ${g} 没做展开检查`);

  /** @type {Map<string, { dir: string, pkg: any }>} */ const found = new Map();
  for (const dir of globs.filter((g) => !g.includes("*"))) {
    const abs = join(repo, dir);
    if (!existsSync(abs)) {
      problems.push(`workspace 目录不存在:${dir}/`);
      continue;
    }
    const pkg = readJson(join(abs, "package.json"));
    if (!pkg?.name) {
      problems.push(`workspace 清单读不出来:${dir}/package.json(文件缺失、损坏,或没有 name 字段)`);
      continue;
    }
    found.set(pkg.name, { dir, pkg });
  }

  const scopes = new Set([...found.keys()].map(scopeOf).filter(Boolean));
  for (const { dir, pkg } of found.values()) {
    for (const field of DEP_FIELDS) {
      for (const dep of Object.keys(pkg?.[field] ?? {})) {
        if (found.has(dep) || !scopes.has(scopeOf(dep))) continue;
        problems.push(`${dir}/package.json 的 ${field} 要 ${dep},但本地没有这个 workspace(registry 上也没有)`);
      }
    }
  }

  return { ok: problems.length === 0, problems, hints, names: [...found.keys()] };
}

// 直接 `node scripts/workspace-check.mjs` 跑时的入口;被 import 时这段不执行。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const res = inspectWorkspaces(repo);
  for (const h of res.hints) console.log(`  ⚠ ${h}`);
  if (res.ok) {
    console.log(`  ✓ workspace 齐全(${res.names.length} 个):${res.names.join("、")}`);
    process.exit(0);
  }
  for (const p of res.problems) console.error(`  ✕ ${p}`);
  console.error("");
  for (const line of WORKSPACE_FAIL_HINT) console.error(`     ${line}`);
  process.exit(1);
}
