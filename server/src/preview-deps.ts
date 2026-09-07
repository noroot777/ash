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
// 哈希是 `package.json` + 锁文件的内容，所以同一份依赖多个任务、多次点预览都只装一次。
//
// 挂软链而不是拷贝：`node_modules` 动辄几百兆，每个任务拷一份是纯浪费；ash 也早就认得
// 这条软链（工作区脏判定不会因此把它算成改动）。
//
// 仍然会失败的几种情况（没网、私有 registry 没凭据、package.json 声明了 workspaces——
// 隔离安装装不出正确的树），一律**如实说**并退回 preview-log.ts 那几条人工建议，不假装
// 装好了。那几条建议里「去主仓装一次」仍然要提醒 lock 文件可能被改写：node_modules 被
// gitignore 不等于 install 不写跟踪文件。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { augmentedEnv } from "./executors/bin-resolve.js";
import { DEPS_DIR } from "./paths.js";
import { userShellLaunch } from "./platform.js";

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

/** 扫描时跳过的目录名（跟 preview-command.ts 同一份理由：产物和依赖目录里全是假信号）。 */
const SKIP_DIRS = new Set(["node_modules", "target", "dist", "build", "out", "vendor", "venv", "__pycache__"]);

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
 * 只看根目录和往下一层 —— 跟识别预览候选同一个口径（前后端并排是常态），再深就不是
 * 「点一下预览」该替人想的事了。一个都不缺就返回空数组。
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
  const rels: string[] = [];
  if (needsDeps(workspace, want)) rels.push(".");
  try {
    for (const entry of readdirSync(workspace, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      if (needsDeps(join(workspace, entry.name), want)) rels.push(entry.name);
    }
  } catch { /* 工作区读不动就只回根目录那一条 */ }
  const mentions = (rel: string) => rel !== "." && command.includes(rel);
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
 * 这份依赖装在哪：`data/deps/<包名>-<package.json + 锁文件的哈希>`。
 *
 * 用内容做键有两个好处：同一份依赖被多个任务、多次点预览共用，只装一次；而 package.json
 * 或锁文件一改，键就变了，下次自动装新的，不会拿旧树糊弄人。
 */
function cacheDir(rel: string, pm: PackageManager, manifest: string, lock: string | null): string {
  const key = createHash("sha256").update(`${pm}\0${manifest}\0${lock ?? ""}`).digest("hex").slice(0, 12);
  const name = (rel === "." ? "root" : rel).replaceAll(/[^A-Za-z0-9._-]/g, "-");
  return join(DEPS_DIR, `${name}-${key}`);
}

/** 跑一条安装命令，输出直接进预览日志。返回 null = 成功，否则是失败原因。 */
async function install(pm: PackageManager, cwd: string, logPath: string): Promise<string | null> {
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
        windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
        stdio: ["ignore", fd, fd],
        // 不设 `CI=1`：pnpm/yarn 在 CI 下会自动切成 frozen-lockfile，锁文件跟 package.json
        // 稍有出入就直接失败 —— 我们宁可装出一份能跑的。npm 的审计和捐助提示是纯噪音，
        // 关掉（这两个 env 只有 npm 认，别的包管理器当没看见）。
        env: { ...augmentedEnv(), ASH_PREVIEW: "1", npm_config_audit: "false", npm_config_fund: "false" },
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(`装了 ${Math.round(INSTALL_TIMEOUT_MS / 60_000)} 分钟还没装完，已经放弃`);
      }, INSTALL_TIMEOUT_MS);
      child.on("error", (error) => { clearTimeout(timer); resolve(error.message); });
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? null : `${line} 退出码 ${code}（输出在上面）`);
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
 *   ① 主仓里已经有一份**能用的**、而且 package.json 跟工作区里这份一模一样 → 直接软链。
 *      不用联网、瞬间完成，也不写主仓（只读它）。package.json 不一致就不借：这个任务
 *      很可能刚加了依赖，借一份旧树只会得到一个更难懂的报错。
 *   ② ash 自己在 `data/deps` 里装过同样内容的一份 → 直接软链。
 *   ③ 都没有 → 复制 package.json + 锁文件到 `data/deps` 装一次，再软链。
 *
 * 任何一步失败都不抛：如实记一笔，让预览命令照常去跑（它会以 `vite: not found` 失败），
 * 由 preview-log.ts 拿着这些理由给下一步建议。**装不上不是不能预览的理由**——用户可能
 * 本来就填了一条不需要依赖的命令。
 */
export async function prepareNodeDeps(
  workspace: string,
  command: string,
  logPath: string,
): Promise<NodeDepsPrepared[]> {
  const all = nodeDepsAdvice(workspace, command);
  const targets = all.filter((one) => one.mentioned);
  if (!targets.length) targets.push(...all.filter((one) => one.rel === "."));
  const done: NodeDepsPrepared[] = [];
  for (const one of targets) {
    done.push(await prepareOne(one, logPath));
  }
  return done;
}

async function prepareOne(one: NodeDepsAdvice, logPath: string): Promise<NodeDepsPrepared> {
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

  // ① 主仓那份能用、而且 package.json 一致
  if (one.sourceReady && one.sourceDir !== null && one.source !== null
    && readIfPresent(join(one.sourceDir, "package.json")) === manifest) {
    return linkTo(one.source, `借用主仓已经装好的那份（${one.source}，只读不写）`);
  }

  // workspaces 的树装在仓库根上，把一个成员的 package.json 单拎出去装是装不对的
  // （依赖会指回 `workspace:*` 这类只有在仓库里才解析得了的说明符）。认出来就别硬来。
  if (/"workspaces"\s*:/.test(manifest) || existsSync(join(one.dir, "pnpm-workspace.yaml"))) {
    return fail("package.json 声明了 workspaces，隔离安装装不出正确的依赖树，ash 没有代装");
  }

  const lockName = LOCKFILES[one.pm];
  const lock = readIfPresent(join(one.dir, lockName));
  const cache = cacheDir(one.rel, one.pm, manifest, lock);
  const cached = join(cache, "node_modules");

  // ② 之前装好过同样内容的一份
  if (ready(cache)) {
    touch(cache); // 「最后一次用是什么时候」——pruneNodeDeps 按它决定谁该被清掉
    return linkTo(cached, `复用 ash 之前备好的依赖（${cached}）`);
  }

  // ③ 现装。**只从项目里读**：清单和锁文件复制过去，install 改写的是那份拷贝。
  const error = await once(cache, () => build(one, cache, lockName, logPath));
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
  const error = await install(one.pm, temp, logPath);
  if (error || !populated(join(temp, "node_modules"))) {
    rmSync(temp, { recursive: true, force: true });
    return error
      ? `在项目外装依赖没成功（${one.pm}）：${error}`
      : `${one.pm} install 说成功了，却没装出 node_modules`;
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
export function pruneNodeDeps(): void {
  let entries: string[];
  try { entries = readdirSync(DEPS_DIR); } catch { return; } // 还没装过任何东西
  for (const name of entries) {
    const dir = join(DEPS_DIR, name);
    try {
      // 装到一半的残骸（server 被杀在 install 中间）按天算，不按月：它谁也用不上，
      // 却照样占着几百兆。一天的余量足够让一趟还在跑的 install 跑完（上限 6 分钟）。
      const keep = name.includes(TEMP_SUFFIX) ? KEEP_TEMP_MS : KEEP_MS;
      if (Date.now() - statSync(dir).mtimeMs < keep) continue;
      rmSync(dir, { recursive: true, force: true });
    } catch { /* 清不掉就下次再说 */ }
  }
}
