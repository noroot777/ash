#!/usr/bin/env node
// 跑 npm install 之前先回答一个问题:这份代码里的 workspace 齐不齐。
//
//   node scripts/workspace-check.mjs        # 单独跑;不齐就列出缺什么并退 1
//
// 为什么值得单独一道闸:workspace 之间靠 `"@ash/shared": "*"` 互相引用,而
// `@ash/*` 这些名字**公共 registry 上根本不存在**。只要 npm 没能把 shared/ 认成
// 本地 workspace(目录没解出来、workspaces 数组漏了它、在子目录里跑的 install),它就
// 会拿这个名字去 registry.npmjs.org 上找,然后报:
//
//   npm error code E404
//   npm error 404 Not Found - GET https://registry.npmjs.org/@ash%2fshared
//
// 这条错**读起来像断网**,于是人会去查代理、换镜像源、重装 node —— 而真正缺的是一个
// 本地目录。2026-08-20 一台 Windows 新机装机就卡在这儿;当时 setup.mjs 给的提示
// (「没网/代理没配/npm registry 不通」)还把方向指反了。所以在开始下载之前先自查,
// 把这类失败翻译成人话 —— 顺带省掉「等几分钟才炸」。
//
// 判据不写死 `@ash`:先收集本地 workspace 的 name,取它们的 scope,再看有没有哪个
// 依赖落在同一个 scope 下却找不到对应 workspace。以后换 scope 名不用回来改这里。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NPM, NPM_SPAWN_OPTS } from "./npm.mjs";

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

/**
 * 一个 workspace 坏了,得说清坏在哪一层 —— 「目录空的」和「JSON 少个逗号」是两种完全不同的
 * 处置。2026-08-20 那台 Windows 机器上三个 workspace 同时报「清单读不出来」,而 existsSync
 * 已经过了(目录在),光看这句话没法判断该重新解包还是该 git checkout。所以这里把现场也带上:
 * 目录里实际有什么、文件多大、JSON 报什么错。
 */
function diagnoseWorkspace(repo, dir) {
  const abs = join(repo, dir);
  if (!existsSync(abs)) return `workspace 目录不存在:${dir}/`;

  const manifest = join(abs, "package.json");
  if (!existsSync(manifest)) {
    let listing = "";
    try {
      const entries = readdirSync(abs);
      listing = entries.length ? `里面只有:${entries.slice(0, 6).join("、")}${entries.length > 6 ? " …" : ""}` : "而且是空目录";
    } catch {
      listing = "而且这个目录读不动(权限?)";
    }
    return `${dir}/package.json 不见了 —— 目录在,${listing}`;
  }

  let raw;
  try {
    raw = readFileSync(manifest, "utf8");
  } catch (e) {
    return `${dir}/package.json 读不动:${e.code || e.message}(权限,或被杀软/网盘占着)`;
  }
  let size = raw.length;
  try {
    size = statSync(manifest).size;
  } catch {}
  if (!raw.trim()) return `${dir}/package.json 是空文件(0 字节)—— 多半是解包/同步只创建了文件没写内容`;

  try {
    const pkg = JSON.parse(raw);
    if (!pkg?.name) return `${dir}/package.json 能解析,但没有 name 字段 —— npm 不会把它当 workspace`;
    return { name: pkg.name, pkg };
  } catch (e) {
    return `${dir}/package.json 解析失败(${size} 字节):${e.message}`;
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
 * 这份检出/解包在不在 git 管理下 —— 决定了修复建议该怎么给。
 * 解包出来的目录不是 git 仓库,叫人 `git checkout` 是句废话;反过来对着一个 git 检出
 * 说「重新解一次包」同样没用。2026-08-20 那台机器上出事的是 D:\ai_workspace\ash,
 * 一个日常 `git pull` 的仓库,而当时的提示只会说重新解包。
 */
function gitRestoreHint(repo, broken) {
  const res = spawnSync("git", ["-C", repo, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (res.status !== 0 || (res.stdout ?? "").trim() !== "true") {
    return ["这不是 git 检出(是解包出来的),重新解一次包,再 cd 到解出来的那个目录跑一遍。"];
  }
  const dirs = broken.join(" ");
  // REPO 一路是 new URL("..") 来的,带尾斜杠;贴进命令行给人看要去掉。
  const at = repo.replace(/[\\/]+$/, "") || repo;
  return [
    "这是个 git 仓库,别重新解包 —— 先看看 git 怎么说:",
    `  git -C "${at}" status --short ${dirs}`,
    "文件确实被删/被改坏的话,从 HEAD 恢复回来:",
    `  git -C "${at}" checkout -- ${dirs}`,
    "如果 git status 说这些文件「没动过」,那就是杀软/网盘按需下载在骗你,把仓库目录加进白名单再恢复。",
  ];
}

/**
 * @param {string} repo 仓库根的绝对路径
 * @returns {{ ok: boolean, problems: string[], hints: string[], names: string[], fix: string[] }}
 */
export function inspectWorkspaces(repo) {
  /** @type {string[]} */ const problems = [];
  /** @type {string[]} */ const hints = [];
  /** @type {string[]} */ const broken = [];

  const root = readJson(join(repo, "package.json"));
  if (!root) {
    problems.push(`${join(repo, "package.json")} 读不出来 —— 这里不是仓库根,或者文件没解出来/损坏了`);
    return { ok: false, problems, hints, names: [], fix: [] };
  }

  const globs = workspaceGlobs(root);
  if (!globs.length) {
    problems.push("根 package.json 里没有 workspaces 字段 —— 本地包会被当成公共包去 registry 上找");
    return { ok: false, problems, hints, names: [], fix: [] };
  }

  // 通配条目不展开:这个仓库的 workspaces 全是字面量目录,真加了 glob 也只是少查一条 ——
  // 不值得在这里塞一个半吊子的实现去猜 npm 的匹配规则,那种「查了但查得不对」更坏。
  for (const g of globs) if (g.includes("*")) hints.push(`workspaces 里的通配条目 ${g} 没做展开检查`);

  /** @type {Map<string, { dir: string, pkg: any }>} */ const found = new Map();
  for (const dir of globs.filter((g) => !g.includes("*"))) {
    const res = diagnoseWorkspace(repo, dir);
    if (typeof res === "string") {
      problems.push(res);
      broken.push(dir);
      continue;
    }
    found.set(res.name, { dir, pkg: res.pkg });
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

  return {
    ok: problems.length === 0,
    problems,
    hints,
    names: [...found.keys()],
    fix: problems.length ? gitRestoreHint(repo, broken.length ? broken : globs.filter((g) => !g.includes("*"))) : [],
  };
}

/**
 * 读一条 npm 配置。没设时 `npm config get` 回的是字符串 "null",这里统一成空串。
 * 参数全是调用点写死的字面量,Windows 上 shell:true 也没有可注入的东西(见 npm.mjs 顶部)。
 */
export function npmConfigValue(key) {
  const res = spawnSync(NPM, ["config", "get", key], { encoding: "utf8", windowsHide: true, ...NPM_SPAWN_OPTS });
  const v = (res.stdout ?? "").trim();
  return v && v !== "null" && v !== "undefined" ? v : "";
}

/**
 * 上面那道文件自查够不着的盲区:目录齐全,npm 却不按 workspace 处理 —— 而且**不报错**。
 *
 * `workspaces=false` 实测下来最坏:npm 只装根 package 的依赖,workspace 的一个都不装,
 * 然后正常退出说「装好了」。人要到后面构建时才撞上去,而那时的报错(`Cannot use
 * --no-workspaces and --workspace at the same time`)跟真正的病因已经隔了十万八千里。
 * 所以两个装依赖的入口(setup / restart)都必须在**下载之前**过这道闸,而不是只拦装机那次:
 * 老机器上 `npm run restart` 撞见同一个配置,看到的错一样看不懂。
 *
 * @returns {{ blockers: string[], warnings: string[] }} blockers 非空就该直接停,别开始装。
 */
export function inspectNpmConfig() {
  /** @type {string[]} */ const blockers = [];
  /** @type {string[]} */ const warnings = [];

  if (npmConfigValue("workspaces") === "false") {
    blockers.push(
      "npm 配置里 workspaces=false —— 这样装只会装根依赖,workspace 的依赖一个都不装(而且不报错)。" +
        "\n     先 npm config delete workspaces(或去掉 npm_config_workspaces 环境变量)再重跑。",
    );
  }
  if (npmConfigValue("install-links") === "true") {
    warnings.push("npm 配置里 install-links=true:本地包会被复制安装而不是软链,改了 shared/ 得重装才生效。");
  }
  return { blockers, warnings };
}

// 直接 `node scripts/workspace-check.mjs` 跑时的入口;被 import 时这段不执行。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const res = inspectWorkspaces(repo);
  const cfg = inspectNpmConfig();
  for (const h of res.hints) console.log(`  ⚠ ${h}`);
  for (const w of cfg.warnings) console.log(`  ⚠ ${w}`);
  if (res.ok && !cfg.blockers.length) {
    console.log(`  ✓ workspace 齐全(${res.names.length} 个):${res.names.join("、")}`);
    process.exit(0);
  }
  for (const p of res.problems) console.error(`  ✕ ${p}`);
  for (const b of cfg.blockers) console.error(`  ✕ ${b}`);
  if (res.problems.length) {
    console.error("");
    for (const line of WORKSPACE_FAIL_HINT) console.error(`     ${line}`);
    for (const line of res.fix) console.error(`     ${line}`);
  }
  process.exit(1);
}
