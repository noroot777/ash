// 预览要跑的那条命令缺 node 依赖时，**由 ash 在用户项目之外备一份**，再挂进任务工作区。
//
// 这是整件事的落点，所以把来龙去脉写完整：
//
// 目标项目（a4sms-allinone，Java 多模块 + 一个 vue 前端）点预览起不来，因为任务 worktree
// 是一份干净检出，`node_modules` 被 gitignore，`vite` 当然找不到。第一版的答复是让 ash
// 或用户在项目里 install —— 用户明确否掉了：「这个肯定不可以啊，怎么能因为 ash 去『污染』
// 正常的项目呢？」，并要求「从这个根基出发解决问题」。
//
// 后来几版都没跳出那个圈：先是让用户自己去主仓 install（只是把同一次污染从 ash 手里换到
// 用户手里），再是让他软链主仓那份（可主仓那份也不存在，建议指向一条断链）。**两条都还是
// 在用户的检出里做事**。
//
// 所以这版把依赖装到 ash 自己的地盘：`data/deps/<包名>-<内容哈希>/`，只从项目里**读**
// `package.json` 和锁文件（复制过去，install 改写的是那份拷贝，用户的锁文件一个字节不动），
// 装完在任务工作区里挂一条 `node_modules` 软链。用户的项目全程只被读，没有被写。
// 哈希是清单 + 锁文件 + 一起复制过去的那几份配置 + 平台/ABI（见 cacheDir），所以同一份
// 依赖多个任务、多次点预览都只装一次，而其中任何一样一改就自动重装。
//
// 挂软链而不是拷贝：`node_modules` 动辄几百兆，每个任务拷一份是纯浪费；ash 也早就认得
// 这条软链（工作区脏判定不会因此把它算成改动）。
//
// 仍然会失败的几种情况（没网、私有 registry 没凭据、package.json 声明了 workspaces 或者
// 有 `file:../shared` 这类相对路径依赖——隔离安装装不出正确的树），一律**如实说**并退回
// preview-log.ts 那几条人工建议，不假装装好了；包管理器退出码 0 也不算数，装完还要扫一眼
// 有没有断链（见 danglingLink）。那几条建议里「去主仓装一次」仍然要提醒 lock 文件可能被改写：node_modules 被
// gitignore 不等于 install 不写跟踪文件。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { augmentedEnv } from "./executors/bin-resolve.js";
import { killByPid } from "./executors/spawn.js";
import { DEPS_DIR } from "./paths.js";
import { userShellLaunch } from "./platform.js";
import { previewDirectories } from "./preview-directories.js";

/** 一个缺依赖的包目录，以及它能从哪儿借。 */
export interface NodeDepsAdvice {
  /** 相对工作区的包目录；`.` = 工作区根。 */
  rel: string;
  /** 这次要跑的预览命令点名了它 —— 那它就是这次真正卡住的那个。 */
  mentioned: boolean;
  /** 按锁文件认出来的包管理器 —— 装的时候得用对，不然锁文件对不上。 */
  pm: PackageManager;
  /** 工作区里这个包目录的绝对路径。 */
  dir: string;
  /** 该软链到哪（任务工作区里的绝对路径）。 */
  target: string;
  /** 主仓里对应的那个包目录；null = 这个工作区就是主仓本身（没有别处可借）。 */
  sourceDir: string | null;
  /** 主仓那份 node_modules 的绝对路径；null 同上。 */
  source: string | null;
  /** 主仓那份**能用吗**（在、非空、而且有这次要的那个可执行文件）。 */
  sourceReady: boolean;
}

export type PackageManager = "npm" | "pnpm" | "yarn";

/** 各家的锁文件名。复制到隔离目录里装的就是它 —— 装出来的树才跟项目里一致。 */
const LOCKFILES: Record<PackageManager, string> = {
  pnpm: "pnpm-lock.yaml",
  yarn: "yarn.lock",
  npm: "package-lock.json",
};

/** 跟着 package.json 一起复制过去的配置：registry / 私服 / hoist 规则都写在这些文件里。 */
const EXTRA_FILES = [".npmrc", ".yarnrc", ".yarnrc.yml", ".nvmrc", "pnpm-workspace.yaml"];

/** 装一次最多等多久。装不完就算了，退回人工建议 —— 总比让「打开预览」无限期挂着强。 */
const INSTALL_TIMEOUT_MS = 6 * 60_000;

/**
 * 「这份缓存装完了」的标记。**判据不能是「node_modules 非空」**：那样一份正装到一半的
 * 树会被并发的另一个任务当成可用（见 build 的说明）。标记在 rename 之前写进临时目录，
 * 所以它出现在缓存位置的那一刻，整棵树已经是完整的。
 */
const READY_MARK = ".ash-deps-ready";

/** 装到一半的那份长这样 —— 前缀固定，好让 pruneNodeDeps 认出崩溃留下的残骸。 */
const TEMP_SUFFIX = ".installing.";
let tempSeq = 0;

/** 这个缓存目录装完了吗。 */
function ready(cache: string): boolean {
  return existsSync(join(cache, READY_MARK)) && populated(join(cache, "node_modules"));
}

/**
 * 任务 worktree 对应的主仓。
 *
 * git 的 worktree 里 `.git` 是个**文件**，内容是 `gitdir: <主仓>/.git/worktrees/<名字>`
 * —— 主仓路径就写在那儿，不用调用方一路传下来。`.git` 是目录则说明这本来就是主仓，
 * 没有「别处那一份」可借。
 */
function mainRepoOf(workspace: string): string | null {
  const dotGit = join(workspace, ".git");
  let raw: string;
  try { raw = readFileSync(dotGit, "utf8"); } catch { return null; } // 目录（主仓）或读不到
  const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(raw)?.[1];
  if (!gitdir) return null;
  const marker = gitdir.replace(/\\/g, "/").indexOf("/.git/worktrees/");
  if (marker < 0) return null;
  const repo = gitdir.slice(0, marker);
  return repo && repo !== workspace ? repo : null;
}

/** 路径相等：Windows 上分隔符和大小写都可能不一样，比字符串会把同一个目录判成两个。 */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const full = resolve(p).replaceAll("\\", "/").replace(/\/+$/, "");
    return process.platform === "win32" ? full.toLowerCase() : full;
  };
  return norm(a) === norm(b);
}

/**
 * 这个工作区**是不是 ash 自己建出来的隔离工作区**（`<主仓>/.worktrees/<taskId>`）。
 *
 * 这是「能不能往里挂 node_modules」的唯一判据，而且必须严到这个程度：
 *
 * 任务默认是**不开 worktree** 的（`tasks.use_worktree` 默认 false），那种任务的工作区
 * 就是项目仓库本身 —— 也就是用户自己的检出。往那儿挂一条软链，哪怕最后撤得掉，也是
 * ash 在用户的项目里写东西：他自己敲 `git status` 就会看见（前端的 `.gitignore` 写的是
 * 带尾斜杠的 `node_modules/`，只匹配目录，匹配不上软链），而 `life: "task"` 的预览可以
 * 挂上好几天。用户当初的原话是「怎么能因为 ash 去『污染』正常的项目呢？」，「最终会撤」
 * 不等于「没有写」。
 *
 * 光看「`.git` 是不是文件」不够：用户自己 `git worktree add` 出来的检出也是 worktree，
 * 那同样是他的目录。所以还要求它就住在主仓的 `.worktrees/` 下面 —— 那是 ash 建的，
 * 也只有 ash 会往里放东西。
 */
export function ashWorktree(workspace: string): boolean {
  const repo = mainRepoOf(workspace);
  return repo !== null && samePath(dirname(workspace), join(repo, ".worktrees"));
}

function packageManager(dir: string): PackageManager {
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  return "npm";
}

/** 目录在、而且不是空的。半截的安装会先留下一个空 `node_modules`，那不算装过。 */
function populated(dir: string): boolean {
  try { return readdirSync(dir).length > 0; } catch { return false; }
}

/**
 * 这份 `node_modules` 里有没有**这次要的那个东西**。
 *
 * 「目录在就算装好了」是个太粗的判据，而且粗在要命的地方：`--prod` 装出来的树是完整的，
 * 只是故意没有 devDependency 里的 `vite`；中断的安装也可能先把目录留下。这两种情况下
 * 「不缺依赖」的结论会让诊断整个哑火 —— 明明日志里写着 `vite: not found`，我们却回一句
 * 「没发现缺依赖」，再退回带占位符的通用模板。
 *
 * 所以日志里捞得出名字时就按名字核对：`.bin` 下有没有它（Windows 上是 `.cmd`/`.ps1`），
 * 或者有没有同名的包目录。捞不出名字（`want` 为 null）时只能退回「非空就算数」。
 */
function hasBin(nodeModules: string, want: string | null): boolean {
  if (!want) return true;
  const bin = join(nodeModules, ".bin", want);
  return existsSync(bin) || existsSync(`${bin}.cmd`) || existsSync(`${bin}.ps1`) || existsSync(join(nodeModules, want));
}

function usable(nodeModules: string, want: string | null): boolean {
  return populated(nodeModules) && hasBin(nodeModules, want);
}

/** 这个目录是个 node 包、而且它的依赖不齐（没装，或者没有 `want` 那一个）。 */
function needsDeps(dir: string, want: string | null): boolean {
  return existsSync(join(dir, "package.json")) && !usable(join(dir, "node_modules"), want);
}

/**
 * 工作区里缺依赖的包目录，逐个核对「主仓那份能不能借」。
 *
 * 默认看根目录和下一层；命令点名的子目录可继续下探，与设置检测的三层范围一致。
 * 一个都不缺就返回空数组。
 *
 * `command` 是这次要跑的预览命令：一个仓库里可以有好几个 node 子项目都没装依赖
 * （a4sms-allinone 有 `a4sms-app` 和 `a4sms-front` 两个），但**这次卡住的只有命令里那个**。
 * 名字在命令里出现过的排最前，并标上 `mentioned` —— 自动备依赖只备它，免得为了点开前端
 * 去装一个跟这次无关的子项目。
 *
 * `want` 是日志里那个「没找到」的可执行文件名（`vite`）。有它就能识破「装过但不全」，
 * 见 hasBin。起进程**之前**还不知道会缺什么，那时传 null。
 */
export function nodeDepsAdvice(workspace: string, command = "", want: string | null = null): NodeDepsAdvice[] {
  const repo = mainRepoOf(workspace);
  const normalized = command.replaceAll("\\", "/");
  const mentions = (rel: string) => rel !== "." && normalized.includes(rel);
  const rels = previewDirectories(workspace, 3, mentions)
    .filter((rel) => needsDeps(join(workspace, rel), want));
  rels.sort((a, b) => Number(mentions(b)) - Number(mentions(a)));
  return rels.map((rel) => {
    const dir = rel === "." ? workspace : join(workspace, rel);
    const sourceDir = repo === null ? null : (rel === "." ? repo : join(repo, rel));
    const source = sourceDir === null ? null : join(sourceDir, "node_modules");
    return {
      rel,
      mentioned: mentions(rel),
      pm: packageManager(dir),
      dir,
      target: join(dir, "node_modules"),
      sourceDir,
      source,
      sourceReady: source !== null && usable(source, want),
    };
  });
}

/** ash 替某个包目录备依赖的结果。失败也要留下**能读**的理由，那是下一步建议的依据。 */
export interface NodeDepsPrepared {
  rel: string;
  ok: boolean;
  /** 一句话交代做了什么/为什么没做成。会同时进预览日志和失败提示。 */
  detail: string;
  /** 这次**我们自己挂上去**的那条软链；预览收掉时要按原样撤掉（见 removePreparedLinks）。 */
  link: string | null;
  /**
   * 「压根没去备」的那一种，以及为什么。目前只有一个值：`"workspace"` = 工作区不是 ash
   * 自己的隔离 worktree，所以一条软链都不挂（见 ashWorktree）。
   *
   * 它跟「试了没成」要分开：给用户的下一步开头那句话完全不同 —— 一个是「ash 备依赖这次
   * 没成」，另一个是「ash 根本不会往你的项目里放东西」。
   */
  blocked?: "workspace";
}

/**
 * 撤掉 ash 自己挂上去的那几条软链。
 *
 * 为什么要撤：任务 worktree 是用户的检出，`git status` 会把这条软链列成未跟踪 ——
 * 前端项目的 `.gitignore` 几乎都写成带尾斜杠的 `node_modules/`，那条**只匹配目录，匹配不上
 * 软链**（git 把软链当文件）。ash 自己的脏判定认得这种条目（git.ts 的 workspaceDirty 专门
 * 滤掉了），但用户自己敲 `git status` 是会看见的，而这套东西的前提就是「不在人家项目里留
 * 东西」。所以预览一收，我们挂的就撤干净，只在预览活着的这段时间存在。
 *
 * 只撤**软链**：真目录一律不动（那可能是用户自己装的）。撤掉的只是入口，依赖本体还在
 * `data/deps` 里，下次点预览是秒挂。
 */
export function removePreparedLinks(paths: readonly string[]): void {
  for (const path of paths) {
    try {
      if (safeLstat(path)?.isSymbolicLink()) rmSync(path, { force: true });
    } catch { /* 撤不掉不值得打断收预览 */ }
  }
}

/** 把一段话写进预览日志（用户在弹窗里实时看得见这几行）。 */
function note(logPath: string, line: string): void {
  try { appendFileSync(logPath, `[ash] ${line}\n`); } catch { /* 日志写不动不该拖垮启动 */ }
}

/**
 * 挂软链：`<工作区>/<包>/node_modules` → 备好的那份。
 *
 * 目标位置已经有**非空的真目录**时一律不动它 —— 那是用户或别的什么东西放在他工作区里的
 * 东西，删掉是不可逆的。空目录（半截安装的残留）和上一次我们自己挂的软链才清掉重挂。
 */
function link(source: string, target: string): string | null {
  try {
    if (existsSync(target) || safeLstat(target) !== null) {
      const stat = safeLstat(target);
      if (stat?.isSymbolicLink()) rmSync(target, { force: true });
      else if (stat && populated(target)) return "工作区里已经有一份非空 node_modules，没有动它";
      else rmSync(target, { recursive: true, force: true });
    }
    symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function safeLstat(path: string): ReturnType<typeof lstatSync> | null {
  try { return lstatSync(path); } catch { return null; }
}

function readIfPresent(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

/**
 * 这份依赖装在哪：`data/deps/<包名>-<所有影响这棵树的东西的哈希>`。
 *
 * 用内容做键有两个好处：同一份依赖被多个任务、多次点预览共用，只装一次；内容一改键就变，
 * 下次自动装新的，不会拿旧树糊弄人。
 *
 * **凡是会改变装出来那棵树的东西，都必须进这个键**，否则「改了、没生效」比不缓存更坏：
 *   · 清单和锁文件 —— 显然。
 *   · **一起复制过去的那几份配置**（`.npmrc` / `.yarnrc*` …）。registry、私服凭据、
 *     `omit=dev`、hoist 规则全写在里面。漏掉它们的后果是实打实的：`.npmrc` 里写着
 *     `omit=dev` 时装出来的树没有 devDependency（vite 就在那儿），用户发现后把配置改对、
 *     再点预览 —— 键没变，命中的还是那棵缺东西的旧树，而且 ash 还告诉他「复用之前备好的
 *     依赖」。他要么等三十天，要么自己去翻 ash 的私有缓存目录。
 *   · **平台、架构、Node 大版本** —— 依赖树里有原生模块（esbuild / sharp / better-sqlite3
 *     都是），换了平台或 ABI 就装不同的二进制。同一个 data 目录被换台机器接手（备份还原、
 *     换 Node 大版本）时，复用一份 ABI 不对的树只会得到一句看不懂的加载错误。
 */
function cacheDir(rel: string, pm: PackageManager, manifest: string, lock: string | null, config: string): string {
  const abi = `${process.platform}-${process.arch}-node${process.versions.node.split(".")[0]}`;
  const key = createHash("sha256")
    .update(`${pm}\0${manifest}\0${lock ?? ""}\0${config}\0${abi}`)
    .digest("hex").slice(0, 12);
  const name = (rel === "." ? "root" : rel).replaceAll(/[^A-Za-z0-9._-]/g, "-");
  return join(DEPS_DIR, `${name}-${key}`);
}

/** 跟着一起复制过去的那几份配置，按固定顺序拼成一段文本 —— 它要进缓存键（见 cacheDir）。 */
function configOf(dir: string): string {
  return EXTRA_FILES.map((name) => `${name}\0${readIfPresent(join(dir, name)) ?? ""}`).join("\0");
}

/**
 * 清单里第一条**相对**路径依赖（`file:` / `link:` / `portal:`），没有就 null。
 *
 * 绝对路径的没问题（挪到哪儿都指得对），只有相对的会被隔离目录重新解释。
 */
function relativeFileDep(manifest: string): string | null {
  let deps: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(manifest) as Record<string, Record<string, unknown> | undefined>;
    deps = { ...parsed.dependencies, ...parsed.devDependencies, ...parsed.optionalDependencies };
  } catch { return null; } // 读不动就交给 install 自己去报错
  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec !== "string") continue;
    const path = /^(?:file|link|portal):(.*)$/.exec(spec)?.[1];
    if (path !== undefined && path.trim() !== "" && !isAbsolute(path.trim())) return `${name}: ${spec}`;
  }
  return null;
}

/**
 * 装完之后的体检：`node_modules` 顶层有没有**指向虚空**的软链。
 *
 * 包管理器的退出码只说明「它按清单做完了」，不说明做出来的东西能用。相对路径依赖是最
 * 典型的一种（上面已经挡在前面了），但同类的还有别的（锁文件里记着的本地路径、装到一半
 * 被打断的链接）。装完顺手扫一眼顶层，比事后让用户对着 `Cannot find module` 猜便宜得多。
 */
function danglingLink(nodeModules: string): string | null {
  const scan = (dir: string, prefix: string): string | null => {
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      // `@scope/pkg` 得进去一层才看得到真正的包目录。
      if (entry.isDirectory() && entry.name.startsWith("@")) {
        const inner = scan(full, `${prefix}${entry.name}/`);
        if (inner) return inner;
        continue;
      }
      if (!entry.isSymbolicLink()) continue;
      if (!existsSync(full)) return `${prefix}${entry.name}`;
    }
    return null;
  };
  return scan(nodeModules, "");
}

/**
 * 跑一条安装命令，输出直接进预览日志。返回 null = 成功，否则是失败原因。
 *
 * `onChild` 一拿到 pid 就调用（结束时再调一次 0）：**装依赖这一段也必须是可取消的**。
 * 它可以跑满六分钟，用户在这中间点「关闭预览」、或者任务续跑，如果这个 pid 没人知道，
 * 停止就只是删了条记录 —— 包管理器还在后台跑，项目自己的生命周期脚本（preinstall /
 * postinstall，用户仓库里什么都可能有）也还在跑，而新一轮已经在改同一个工作区了。
 */
async function install(
  pm: PackageManager,
  cwd: string,
  logPath: string,
  onChild: (pid: number) => void = () => {},
): Promise<string | null> {
  // 用户平时怎么装，这儿就怎么装（`npm install` 而不是 `npm ci`：锁文件跟 package.json
  // 对不上时 ci 直接失败，而我们宁可装出一份能跑的，也不要在这儿替他做版本仲裁）。
  const line = `${pm} install`;
  const launch = userShellLaunch(line);
  note(logPath, `在项目外备依赖：${cwd}$ ${line}`);
  return await new Promise<string | null>((resolve) => {
    let fd: number | undefined;
    try {
      // 输出直接追加进预览日志：下载和编译要跑好几分钟，用户在弹窗里看得见进度
      // （日志弹窗在「正在启动」这一段是自动续读的）。
      fd = openAppend(logPath);
      const child = spawn(launch.file, launch.args, {
        cwd,
        // POSIX 上自成进程组：包管理器底下还有一层层的 node/python/生命周期脚本，
        // 只杀 shell 那个 pid 是杀不干净的（Windows 反过来靠 taskkill /T 按父子收树）。
        detached: process.platform !== "win32",
        windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
        stdio: ["ignore", fd, fd],
        // 不设 `CI=1`：pnpm/yarn 在 CI 下会自动切成 frozen-lockfile，锁文件跟 package.json
        // 稍有出入就直接失败 —— 我们宁可装出一份能跑的。npm 的审计和捐助提示是纯噪音，
        // 关掉（这两个 env 只有 npm 认，别的包管理器当没看见）。
        env: { ...augmentedEnv(), ASH_PREVIEW: "1", npm_config_audit: "false", npm_config_fund: "false" },
      });
      if (child.pid) onChild(child.pid);
      const timer = setTimeout(() => {
        // 按树杀，不是 `child.kill()`：那只打得到最外层的 shell，install 自己派生的
        // 后代（生命周期脚本、node-gyp…）会活下来，超时于是变成「放弃等待 + 留一堆孤儿」。
        killByPid(child.pid ?? 0);
        resolve(`装了 ${Math.round(INSTALL_TIMEOUT_MS / 60_000)} 分钟还没装完，已经放弃`);
      }, INSTALL_TIMEOUT_MS);
      const done = (result: string | null) => { clearTimeout(timer); onChild(0); resolve(result); };
      child.on("error", (error) => done(error.message));
      child.on("exit", (code, signal) => {
        // 被外面杀掉（取消）时退出码是 null + 信号，说清楚是「被收掉了」而不是装挂了。
        done(code === 0 ? null : signal ? `${line} 被中止（${signal}）` : `${line} 退出码 ${code}（输出在上面）`);
      });
    } catch (error) {
      resolve(error instanceof Error ? error.message : String(error));
    } finally {
      if (fd !== undefined) closeLater(fd);
    }
  });
}

// spawn 之后就能关掉自己这份 fd（子进程已经继承了一份）。
function openAppend(path: string): number {
  return openSync(path, "a");
}

function closeLater(fd: number): void {
  try { closeSync(fd); } catch { /* 已经关了 */ }
}

/**
 * 起预览**之前**：这条命令要的 node 依赖不齐就由 ash 自己备一份，挂进任务工作区。
 *
 * 只管这次命令点名的那个包目录（没点名就只管工作区根）—— 为了看一眼前端去装一个无关的
 * 子项目，等于把「点一下预览」变成一次十分钟的仪式。
 *
 * 三条路，从便宜到贵：
 *   ① 主仓里已经有一份**能用的**，而且清单、锁文件和安装配置跟工作区里这份完全一致 →
 *      直接软链。不用联网、瞬间完成，也不写主仓（只读它）。有一样对不上就不借：这个任务
 *      很可能刚加了依赖或者刚升过锁，借一份旧树轻则报错、重则拿错版本跑给用户看。
 *   ② ash 自己在 `data/deps` 里装过同样内容的一份 → 直接软链。
 *   ③ 都没有 → 复制 package.json + 锁文件到 `data/deps` 装一次，再软链。
 *
 * 前提是工作区得是 ash 自己的隔离 worktree —— 不是的话一条也不挂，见 ashWorktree。
 *
 * 任何一步失败都不抛：如实记一笔，让预览命令照常去跑（它会以 `vite: not found` 失败），
 * 由 preview-log.ts 拿着这些理由给下一步建议。**装不上不是不能预览的理由**——用户可能
 * 本来就填了一条不需要依赖的命令。
 */
export async function prepareNodeDeps(
  workspace: string,
  command: string,
  logPath: string,
  /** 装依赖的那个进程起来了/结束了（0）。调用方拿它把这一段也纳入「能被取消」的范围。 */
  onChild: (pid: number) => void = () => {},
): Promise<NodeDepsPrepared[]> {
  const all = nodeDepsAdvice(workspace, command);
  const targets = all.filter((one) => one.mentioned);
  if (!targets.length) targets.push(...all.filter((one) => one.rel === "."));
  // 不是 ash 自己的隔离工作区就**一条软链都不挂**（判据和理由见 ashWorktree）。这条在
  // 最前面：依赖装在项目外只解决了「依赖本体」，入口那条软链照样是写进用户的检出。
  // 如实记一笔，让 preview-log.ts 拿着它给人工的下一步（自己装一次，或者给这个任务
  // 打开 worktree），预览命令照常去跑。
  if (targets.length && !ashWorktree(workspace)) {
    return targets.map((one) => {
      const detail = "这个任务直接跑在项目检出里（没有开 worktree），ash 不往用户的项目里挂东西，"
        + "所以没有代备依赖：给这个任务打开 worktree，或者自己在项目里装一次";
      note(logPath, `${one.rel}：${detail}`);
      return { rel: one.rel, ok: false, detail, link: null, blocked: "workspace" as const };
    });
  }
  const done: NodeDepsPrepared[] = [];
  for (const one of targets) {
    done.push(await prepareOne(one, logPath, onChild));
  }
  return done;
}

async function prepareOne(
  one: NodeDepsAdvice,
  logPath: string,
  onChild: (pid: number) => void,
): Promise<NodeDepsPrepared> {
  const manifest = readIfPresent(join(one.dir, "package.json"));
  if (manifest === null) return { rel: one.rel, ok: false, detail: "读不到 package.json", link: null };
  const fail = (detail: string): NodeDepsPrepared => {
    note(logPath, `${one.rel}：${detail}`);
    return { rel: one.rel, ok: false, detail, link: null };
  };
  const linkTo = (source: string, how: string): NodeDepsPrepared => {
    const error = link(source, one.target);
    if (error) return fail(`${how}，但软链没挂上：${error}`);
    note(logPath, `${one.rel}：${how} → ${one.target}`);
    return { rel: one.rel, ok: true, detail: how, link: one.target };
  };

  const lockName = LOCKFILES[one.pm];
  const lock = readIfPresent(join(one.dir, lockName));

  // ① 主仓那份能用，而且**装出它的那几份输入跟这儿一模一样**。
  //
  // 「package.json 一样」远远不够：锁文件才是那棵树的实际内容。任务里常见的改动恰恰是
  // 只动锁文件（升传递依赖、重新解析版本、解冲突），清单一个字都不变 —— 只比清单就会
  // 绕过内容哈希缓存，直接挂上主仓按**旧锁**装的那棵树，预览页面于是由跟这次提交不一致的
  // 依赖生成，最会掩盖的正是锁文件升级引入的回归。配置（.npmrc 里的 registry/omit=dev…）
  // 同理，它们本来就进了缓存键，借用这条路没有理由更松。
  if (one.sourceReady && one.sourceDir !== null && one.source !== null
    && readIfPresent(join(one.sourceDir, "package.json")) === manifest
    && readIfPresent(join(one.sourceDir, lockName)) === lock
    && configOf(one.sourceDir) === configOf(one.dir)) {
    return linkTo(one.source, `借用主仓已经装好的那份（${one.source}，只读不写）`);
  }

  // workspaces 的树装在仓库根上，把一个成员的 package.json 单拎出去装是装不对的
  // （依赖会指回 `workspace:*` 这类只有在仓库里才解析得了的说明符）。认出来就别硬来。
  if (/"workspaces"\s*:/.test(manifest) || existsSync(join(one.dir, "pnpm-workspace.yaml"))) {
    return fail("package.json 声明了 workspaces，隔离安装装不出正确的依赖树，ash 没有代装");
  }
  // 同一类毛病的另一半，而且更阴：`"shared": "file:../shared"` 这种**相对**路径依赖。
  // 隔离目录不在项目里，`../shared` 于是指到 ash 缓存目录的隔壁 —— npm 照样退出码 0，
  // 只是给你留一条指向虚空的软链。等到应用真去 import 那个本地包才炸，而那时 ash 已经
  // 报过「依赖装好了」。宁可现在说清楚，也不要给一句会被后面拆穿的成功。
  const relativeDep = relativeFileDep(manifest);
  if (relativeDep) {
    return fail(`package.json 里有相对路径依赖（${relativeDep}），它指的是项目里的目录，`
      + "搬到 ash 的隔离目录里就指空了 —— 装出来是断链而不是报错，所以 ash 没有代装");
  }

  const cache = cacheDir(one.rel, one.pm, manifest, lock, configOf(one.dir));
  const cached = join(cache, "node_modules");

  // ② 之前装好过同样内容的一份
  if (ready(cache)) {
    touch(cache); // 「最后一次用是什么时候」——pruneNodeDeps 按它决定谁该被清掉
    return linkTo(cached, `复用 ash 之前备好的依赖（${cached}）`);
  }

  // ③ 现装。**只从项目里读**：清单和锁文件复制过去，install 改写的是那份拷贝。
  const error = await once(cache, () => build(one, cache, lockName, logPath, onChild));
  if (error) return fail(error);
  touch(cache);
  return linkTo(cached, `ash 已在项目外装好依赖（${cached}，你的项目没有被写）`);
}

/**
 * 真正装那一趟：**装在一个临时目录里，装完了才 rename 到缓存位置**。
 *
 * 直接往缓存目录里装是有代价的，而且代价在并发下必然兑现 —— 缓存的键是清单内容的哈希，
 * 所以「两个任务同时第一次预览同一个前端」不是巧合，是正常路径：
 *   · 判「装好没有」只看 node_modules 非空的话，第一个 install 刚落下第一个文件，第二个
 *     就会认为「已经备好了」，挂上软链直接开进程 —— 拿着一棵**仍在长**的依赖树跑，症状是
 *     随机的 module not found / `.bin` 里没有那个可执行文件。
 *   · 更糟的是装之前那句 `rmSync(cache)`：第二个会把第一个正装到一半的目录**删掉**。
 *
 * 所以：临时目录里装 → 写一个完成标记 → 原子 rename。rename 到已存在的非空目录会失败，
 * 那正好说明别人先装完了，用它们那份就是（先到先得，晚到的把自己那份丢掉）。判「装好没有」
 * 只认完成标记，半截的树永远不会被当成可用。
 */
async function build(
  one: NodeDepsAdvice,
  cache: string,
  lockName: string,
  logPath: string,
  onChild: (pid: number) => void,
): Promise<string | null> {
  const temp = `${cache}${TEMP_SUFFIX}${process.pid}-${tempSeq++}`;
  try {
    rmSync(temp, { recursive: true, force: true });
    mkdirSync(temp, { recursive: true });
    copyFileSync(join(one.dir, "package.json"), join(temp, "package.json"));
    for (const name of [lockName, ...EXTRA_FILES]) {
      const from = join(one.dir, name);
      if (existsSync(from)) copyFileSync(from, join(temp, name));
    }
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    return `没能把 package.json 复制到 ${temp}：${error instanceof Error ? error.message : String(error)}`;
  }
  const error = await install(one.pm, temp, logPath, onChild);
  if (error || !populated(join(temp, "node_modules"))) {
    rmSync(temp, { recursive: true, force: true });
    return error
      ? `在项目外装依赖没成功（${one.pm}）：${error}`
      : `${one.pm} install 说成功了，却没装出 node_modules`;
  }
  // 退出码 0 不等于这棵树能用（见 danglingLink）。断链就当没装成，别把它 rename 成缓存。
  const dangling = danglingLink(join(temp, "node_modules"));
  if (dangling) {
    rmSync(temp, { recursive: true, force: true });
    return `${one.pm} install 退出码是 0，但装出来的 node_modules/${dangling} 是条断链，`
      + "这棵树用不了（多半是清单里有指向项目内目录的路径依赖），ash 没有把它当成装好了";
  }
  try {
    writeFileSync(join(temp, READY_MARK), `${one.pm}\n`);
    renameSync(temp, cache);
  } catch (moveError) {
    rmSync(temp, { recursive: true, force: true });
    // 挪不过去的正常原因只有一个：别人先装完了，那个位置已经被占。用它们那份。
    if (ready(cache)) return null;
    return `装好了却挪不到 ${cache}：${moveError instanceof Error ? moveError.message : String(moveError)}`;
  }
  return null;
}

/**
 * 同一个进程里对同一个缓存目录只跑一趟。
 *
 * rename 那一层已经保证了正确性（谁先装完算谁的），这一层只是别做无用功：两个任务同时
 * 点预览时不必把同一份依赖装两遍。跨进程（两个 ash 实例）仍然靠 rename 收口。
 */
const running = new Map<string, Promise<string | null>>();

async function once(key: string, work: () => Promise<string | null>): Promise<string | null> {
  const inFlight = running.get(key);
  if (inFlight) return await inFlight;
  const task = work().finally(() => running.delete(key));
  running.set(key, task);
  return await task;
}

/** 记一笔「最后一次用到它」。 */
function touch(dir: string): void {
  const stamp = new Date();
  try { utimesSync(dir, stamp, stamp); } catch { /* 记不上不影响装 */ }
}

/** 备好的依赖多久没人用就清掉。 */
const KEEP_MS = 30 * 24 * 60 * 60_000;
/** 装到一半的残骸留多久（见 pruneNodeDeps）。 */
const KEEP_TEMP_MS = 24 * 60 * 60_000;

/**
 * 清掉长期没人用的那几份备用依赖。
 *
 * 这套东西每遇到一个新的 package.json 内容就装一份，一份前端依赖几百兆 —— 不清的话
 * `data/deps` 会无声地涨到几十 G，而且涨的是**用户的磁盘**。挂在预览清扫那趟车上（每 5
 * 分钟一次，见 startPreviewSweeper），按「最后一次被用到」算三十天。
 *
 * 正在被某个预览挂着的那份不会被误清：每次挂链都会 touch 一次，而预览撑不到三十天不重启。
 */
export function pruneNodeDeps(held: readonly string[] = []): void {
  let entries: string[];
  try { entries = readdirSync(DEPS_DIR); } catch { return; } // 还没装过任何东西
  const inUse = new Set(held);
  for (const name of entries) {
    const dir = join(DEPS_DIR, name);
    // **还挂在某个活着的预览上就不能删**，而且顺手续租。挂链时 touch 那一次是不够的：
    // 自由预览是 `life: "task"` —— 一个任务等人验收等上三十天完全合法，那份缓存的 mtime
    // 却停在挂链那一刻。删掉的后果不是「下次慢一点」：工作区那条软链还在、只是断了，
    // dev server 按需加载下一个模块时才炸，而记录上它明明还在跑，只能重启才恢复。
    if (inUse.has(dir)) {
      touch(dir);
      continue;
    }
    try {
      // 装到一半的残骸（server 被杀在 install 中间）按天算，不按月：它谁也用不上，
      // 却照样占着几百兆。一天的余量足够让一趟还在跑的 install 跑完（上限 6 分钟）。
      const keep = name.includes(TEMP_SUFFIX) ? KEEP_TEMP_MS : KEEP_MS;
      if (Date.now() - statSync(dir).mtimeMs < keep) continue;
      rmSync(dir, { recursive: true, force: true });
    } catch { /* 清不掉就下次再说 */ }
  }
}

/**
 * 一条我们挂出去的软链，现在指着哪个缓存目录（不指向 `data/deps` 就返回 null）。
 *
 * 给清扫用：活着的预览记录里存着 `links`，顺着它们就能知道哪几份缓存**正在被用**。
 */
export function heldCacheOf(link: string): string | null {
  let target: string;
  try { target = realpathSync(link); } catch { return null; } // 断链/已经撤掉了
  const cache = dirname(target); // <缓存>/node_modules → <缓存>
  return dirname(cache) === resolve(DEPS_DIR) ? cache : null;
}
