// 「这条命令点名要跑的是什么，**起跑那一刻**它在被测树里解析得出来吗」。
//
// 这一层只回答这一句，而门禁「测试压根没启动」那个结论**只许**由它授权。
//
// 为什么非得在起跑前问、而且事后的任何痕迹都不能替它（第 2 轮审查 F1 实测两条反例）：
//  ① **日志不说是哪一层在喊。** 顶层 `test:accept` 存在、已经打出 `ACCEPTANCE STARTED`，
//     它内部调 `npm --prefix child run test:accept`，子项目没有同名脚本，于是日志里出现
//     `Missing script: "test:accept"` —— 跟顶层缺失长得一模一样。
//  ② **跑完之后看文件在不在也不行。** 一条先打印启动提示、`rm -- "$0"` 删掉自己、再报断言
//     失败的脚本，事后看就是「入口不存在」。
//
// **而光把时机挪到 spawn 前还不够（第 3 轮审查 F1）。** 查的那个对象必须跟 runner 真要查的
// 那个对象**等价**，否则只是换个地方猜。审查实测的三条：
//  · `npm --prefix child run test:accept` —— runner 读的是 `child/package.json`，这一层却读
//    根目录那份，于是把一次真的断言失败说成「一行都没跑」；
//  · `npm run 'test:accept'` —— 引号是 shell 的，runner 拿到的名字没有引号，这一层却带着
//    引号去查；
//  · `npm start` —— 没有 `scripts.start` 时 npm **有默认行为**（有 `server.js` 就跑
//    `node server.js`，实测如此），所以「manifest 里没有」推不出「没东西可跑」。
//
// **而命令行只是三个配置来源之一（第 5 轮审查 F1 实测四条）。** runner 去哪儿找 manifest，
// 命令行、继承的环境、仓库里的 npmrc 都能改掉，三者任缺一环这份「缺失」就不成立：
//  · `npm --workspace=child run test:accept` —— 带等号的 scope 选项（旧版「`--x=y` 自带值
//    就跳过」把它当成了无关选项）；
//  · `npm_config_workspace=child npm run test:accept` —— 配置从环境进来（旧版无条件剥掉
//    所有前置赋值）；
//  · `.npmrc` 里写着 `workspace=child` —— 配置从仓库进来，命令行上一个字都看不出来；
//  · `npm --prefix child run test:accept # --prefix .` —— shell 注释，旧版把注释里那个
//    `--prefix .` 当成了真的目录。
// 四条里 runner 真跑的都是子项目那个脚本、真打了启动提示、真报了断言失败，却都被说成
// 「一行都没跑到、不要改代码」。
//
// 所以这一层的规矩是**证明不了就交白卷**。判据是「这条命令的执行目标我能不能完整解释」，
// 不是「它像不像我见过的形状」：
//  · 命令里有任何我读不准的 shell 语义（多步、变量、命令替换、通配、转义、未闭合引号），
//    返回 null；注释按 shell 语义截断，不当成参数；
//  · 选项**只认白名单**（换目录的、确定不吃词的开关、确定只影响输出的带值选项），其余一律
//    返回 null —— 带不带等号都一样。靠黑名单逐条堵组合这条路已经证明走不通：补掉一个写法，
//    换个写法又进来；
//  · 前置环境赋值里出现 runner 自己的配置（`npm_config_*`/`yarn_*`/`pnpm_*`），返回 null；
//    进程环境里已经生效的同类配置也一样查；
//  · 会生效的 npmrc 里出现改掉查找路径的键（`prefix`/`workspace`/…），或者那份文件存在却
//    读不动，返回 null；
//  · 只认那些**绝对没有默认行为**的子命令（`npm run X`、`npm test`），`start`/`restart`
//    一律不认，而且子命令必须在最前（`npm test run` 不是「跑 run 这个脚本」）；
//  · 查的 manifest 必须是 runner 真会读的那一份（跟着 `--prefix`/`-C`/`--dir`/`--cwd` 走）。
//
// 反方向也要说清：`resolved: true` **只证明它在树里，不证明它跑起来了**（审查实测：一个存在
// 但没有执行权限的脚本退 126，正文一行没跑）。所以 true 这一档的措辞里不许出现「确实跑起来
// 了」—— 那句话这一层给不出来。
//
// 答案在 spawn 之前取一次，连同判据一起落到那一行上（accept_gate_runs.entryProbe），结算时
// 只许读它、不许重算。
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, normalize, relative } from "node:path";

/** 这条命令点名要跑的东西，分能核实的两种。其余形状一律认不出（见文件头）。 */
export type GateEntryAsk =
  | { kind: "path"; name: string }
  /** `dir` = runner 真会读 manifest 的那个目录（相对被测树，默认 `.`）。 */
  | { kind: "script"; runner: "npm" | "pnpm" | "yarn"; name: string; dir: string };

export type GateEntryProbe = {
  /** 点名要跑的那个东西：脚本名，或相对这份树的路径。 */
  ask: string;
  /**
   * 起跑那一刻它解析得出来没有。
   *  - `false` 是「测试压根没启动」的**唯一**授权来源；
   *  - `true` 只说明它在树里 —— **不**说明它跑起来了（权限、解释器都可能挡在后面）。
   */
  resolved: boolean;
  /** 在哪儿核的，写给人看（也进结论正文）。 */
  by: string;
};

/**
 * 只认**绝对没有默认行为**的子命令。
 *
 * `npm test` 缺脚本就是报错；而 `npm start` 没有 `scripts.start` 时会去跑 `node server.js`、
 * `npm restart` 会退化成 stop+start（审查 F1 实测），所以那几个一律不认 —— 「manifest 里
 * 没有」在它们身上推不出「没东西可跑」。
 */
const NPM_LIFECYCLE = new Set(["test"]);

/**
 * 这几个名字**走 `run` 也一样**有默认行为：实测 `npm run start`（没有 `scripts.start`、
 * 目录里有 `server.js`）真的去跑了 `node server.js` 并打出那个脚本的输出（第 4 轮审查 F1）。
 * 旧版本只拦住了裸 `npm start`，于是同一件事换个写法就又被判成「没东西可跑」。
 *
 * 对 pnpm/yarn 一并保守对待：它们的默认行为我没有实测过，而这里多交一张白卷只是少下一个
 * 结论，认错了却要发出「测试一行都没跑、不要改代码」。
 */
const DEFAULTED_SCRIPTS = new Set(["start", "restart", "stop"]);

/** 这些**子命令**把「跑什么」整个换掉，不是在跑本项目的脚本。 */
const SCOPE_SUBCOMMANDS = new Set(["workspace", "workspaces", "exec", "dlx", "recursive"]);

/** 告诉 runner 换目录的选项。值可以跟在后面，也可以 `=` 连写。 */
const DIR_FLAGS = new Set(["--prefix", "-C", "--dir", "--cwd"]);

/**
 * runner 自己的配置也能从环境进来（实测 `npm_config_workspace=child npm run test:accept`
 * 真去跑了子项目那个脚本）。前缀命中这些、键又落在 SCOPE_CONFIG_KEYS 里的，一律交白卷。
 */
const RUNNER_CONFIG_ENV = /^(npm_config_|yarn_|pnpm_)/i;

/**
 * **实测**会改掉「`npm run` 去哪儿找 manifest」的配置键。只有 workspace 这一族：
 *  · `.npmrc` 写 `workspace=child`、或者环境给 `npm_config_workspace=child`，`npm run probe`
 *    真的跑到了 child（本机实测两种都成立）；
 *  · `prefix=child` 走 `.npmrc` 或走环境**都不改**（实测仍在根目录跑）—— 它是全局安装位置。
 *
 * 判据必须这么窄，否则会反过来废掉整个判定：`npm` 运行脚本时会把自己的配置全量注入子进程
 * （本机实测注入了 prefix / userconfig / globalconfig / local_prefix / global_prefix 等 12 个
 * `npm_config_*`），把那些内省变量算成「配置被改过」，等于在任何由 npm 启动的环境里永远
 * 交白卷。workspace 不在注入清单里，只有用户显式设置时才出现。
 *
 * 命令行侧不靠这张表：那边是**白名单之外一律白卷**，`--workspace=child`、`--userconfig X`
 * 之类自然都落进白卷，不需要逐个点名。
 */
const SCOPE_CONFIG_KEYS = new Set(["workspace", "workspaces", "include-workspace-root"]);

/**
 * 确定**不吃下一个词**的开关。不在这张表里、又不是 `--x=y` 自带值的选项，一律交白卷：
 * 我说不准它会不会把后面那个词当成自己的值。
 *
 * 旧版本按「以 `-` 开头就跳过」来找位置参数，于是 `npm run --loglevel warn test:accept`
 * 里的 `warn`（其实是 `--loglevel` 的值）被当成了脚本名，报出「没有名为 warn 的脚本」——
 * 而 npm 真跑的是 `test:accept`（第 4 轮审查 F1 同类，本机实测）。
 */
const SAFE_SWITCHES = new Set(["--silent", "-s", "--quiet", "--no-audit", "--no-fund",
  "--no-progress", "--no-color", "--ignore-workspace-root-check"]);

/** 确定只影响**输出**、不影响「去哪儿找脚本」的带值选项。 */
const SAFE_VALUED = new Set(["--loglevel", "--log-level"]);

/**
 * 把命令切成词。**读不准就返回 null**，绝不猜。
 *
 * 只处理一件 shell 语义：成对的引号（`npm run 'test:accept'` 里那个名字，runner 拿到的是
 * 不带引号的 —— 审查 F1 实测）。变量、命令替换、通配、转义、未闭合引号、多步一律交白卷。
 */
function tokenize(command: string): string[] | null {
  if (/(\|\||&&|[;\n|])/.test(command)) return null;      // 多步：没有「一个入口」可言
  if (/[`$]/.test(command)) return null;                   // 命令替换 / 变量：入口是算出来的
  if (/[\\*?[\]{}~]/.test(command)) return null;           // 转义 / 通配 / 花括号展开
  const words: string[] = [];
  let at = 0;
  while (at < command.length) {
    if (/\s/.test(command[at]!)) { at++; continue; }
    // shell 注释：词首的 `#` 之后整条都不执行。旧版把它当普通词，于是注释里的
    // `# --prefix .` 覆盖掉了真正的 `--prefix child`（第 5 轮审查 F1 实测）。
    if (command[at] === "#") break;
    // 重定向整段跳过：它不是一个步骤，也不是入口。
    const redirect = /^\d*[<>]{1,2}\s*\S+/.exec(command.slice(at));
    if (redirect) { at += redirect[0].length; continue; }
    let word = "";
    while (at < command.length && !/\s/.test(command[at]!)) {
      const quote = command[at]!;
      if (quote === "'" || quote === '"') {
        const close = command.indexOf(quote, at + 1);
        if (close < 0) return null;                        // 引号没闭合：读不了
        word += command.slice(at + 1, close);
        at = close + 1;
      } else { word += quote; at++; }
    }
    // 词中间夹着重定向符（`x>log`）那种，我切不准。
    if (/[<>]/.test(word)) return null;
    words.push(word);
  }
  return words;
}

/**
 * 把 runner 自己的那段参数读出来：位置参数（`run` / 脚本名 / 子命令）+ 它会去哪个目录读
 * manifest。**任何一个词解释不了就返回 null**（交白卷）。
 *
 * 两条都是实测来的（第 4 轮审查 F1）：
 *  · `--` 之后的词是**传给脚本的**，npm 自己不再解释 —— `npm run x -- --prefix child` 跑的
 *    是根目录那个 `x`，`--prefix child` 只是它的 argv。旧版本把整条命令扫一遍找 `--prefix`，
 *    于是去读了 `child/package.json`，把一次真跑起来、真报断言失败的红说成「一行都没跑到」。
 *  · 未知选项可能吃掉后面那个词（`--loglevel warn`），所以不许按「以 `-` 开头就跳过」去
 *    猜位置参数。
 */
function runnerArgs(words: string[]): { positional: string[]; dir: string } | null {
  let dir = ".";
  const positional: string[] = [];
  for (let at = 0; at < words.length; at++) {
    const word = words[at]!;
    if (word === "--") break;                      // 后面都是脚本的参数，入口身份到这儿定了
    if (!word.startsWith("-")) {
      if (SCOPE_SUBCOMMANDS.has(word)) return null;
      positional.push(word);
      continue;
    }
    const eq = word.indexOf("=");
    const flag = eq > 0 ? word.slice(0, eq) : word;
    const inlineValue = eq > 0 ? word.slice(eq + 1) : null;
    if (DIR_FLAGS.has(flag)) {
      const value = inlineValue ?? words[++at];
      if (!value || value.startsWith("-")) return null;
      dir = value;
      continue;
    }
    if (SAFE_VALUED.has(flag)) { if (inlineValue === null) at++; continue; }
    if (inlineValue === null && SAFE_SWITCHES.has(flag)) continue;
    // 白名单之外一律白卷，**带等号的也一样**：`--workspace=child` 换掉的正是「去哪儿找
    // 脚本」，而旧版「`--x=y` 自带值就跳过」把它当成了无关选项（第 5 轮审查 F1 实测）。
    return null;
  }
  return { positional, dir };
}

/**
 * 进程环境里**已经生效**的 runner 配置（门禁 spawn 继承它）。命中就交白卷。
 *
 * 命令行上看不出来的那一类：用户在 shell 里 export 过 `npm_config_workspace`，门禁跑的时候
 * 它照样生效，而这一层若只读命令行就会去核错一份 manifest。
 */
const scopeChangingEnv = (): boolean => Object.keys(process.env).some(key => {
  const prefix = RUNNER_CONFIG_ENV.exec(key);
  return !!prefix && SCOPE_CONFIG_KEYS.has(key.slice(prefix[0].length).replace(/_/g, "-").toLowerCase());
});

/**
 * 会生效的那几份 runner 配置文件里，有没有改掉「去哪儿找 manifest」的键。
 *
 *  · 有 → true（交白卷）；
 *  · 文件不存在 → 不影响；
 *  · **存在却读不动 → true** —— 读不出来不等于里面没有，这跟 git 那边同一条规矩。
 *
 * yarn 的 rc 文件不解析：那套语义我没实测过，存在就不敢下结论（只影响 yarn 这一路）。
 */
async function scopeChangingRc(treeDir: string, runner: "npm" | "pnpm" | "yarn"): Promise<boolean> {
  if (runner === "yarn" && [".yarnrc", ".yarnrc.yml"].some(name => existsSync(join(treeDir, name)))) return true;
  // 用户级那份读**生效的**那一个：npm 把它的位置注入成 `npm_config_userconfig`，默认就是
  // `~/.npmrc`。拿这个变量去读，而不是因为它存在就交白卷（它是注入值，不是用户改过的证据）。
  const userRc = process.env.npm_config_userconfig?.trim() || join(homedir(), ".npmrc");
  for (const file of [join(treeDir, ".npmrc"), userRc]) {
    if (!existsSync(file)) continue;
    const text = await readFile(file, "utf8").catch(() => null);
    if (text === null) return true;
    for (const line of text.split("\n")) {
      const key = line.split("=")[0]?.trim().toLowerCase();
      if (key && !/^[;#/[]/.test(key) && SCOPE_CONFIG_KEYS.has(key)) return true;
    }
  }
  return false;
}

/**
 * 这条命令点名要跑的是什么。认不出来返回 null。
 *
 * 判据全在文件头：能读准的 shell 语义 + 没有默认行为的子命令 + runner 真会读的那个目录。
 * 任何一条不满足就交白卷 —— 下游拿这个答案去说「测试一行都没跑、不要改代码」。
 */
export function gateEntryAsk(command: string): GateEntryAsk | null {
  const words = tokenize(command);
  if (!words) return null;
  // 前缀的环境变量赋值（`CI=1 npm run x`）不是入口，剥掉；后面出现的 `A=B` 是参数，留着。
  // 但 runner 自己的配置也能这么传进来（实测 `npm_config_workspace=child` 真让它去跑了子
  // 项目那个脚本），那一类改掉的正是「去哪儿找脚本」—— 解释不了就交白卷。
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) {
    if (RUNNER_CONFIG_ENV.test(words[0]!)) return null;
    words.shift();
  }
  const head = words[0];
  if (!head) return null;
  const runner = /^(npm|pnpm|yarn)$/.exec(head)?.[1] as "npm" | "pnpm" | "yarn" | undefined;
  if (runner) {
    const args = runnerArgs(words.slice(1));
    if (!args) return null;
    const { positional, dir } = args;
    // 子命令必须在最前：`npm test run` 是「跑 test 这个生命周期」，不是「跑 run 这个脚本」。
    const at = positional[0] === "run" || positional[0] === "run-script" ? 0 : -1;
    if (at >= 0) {
      const name = positional[at + 1];
      if (!name) return null;
      // `run` 也绕不开默认行为：`npm run start` 缺 `scripts.start` 时照样跑 `node server.js`。
      return DEFAULTED_SCRIPTS.has(name) ? null : { kind: "script", runner, name, dir };
    }
    // 只认 npm 那几个「缺了就是报错」的子命令;yarn/pnpm 的裸子命令和脚本简写混在一起,
    // 分不清就不猜。
    const sub = positional[0];
    return runner === "npm" && sub && NPM_LIFECYCLE.has(sub) ? { kind: "script", runner, name: sub, dir } : null;
  }
  // 相对路径形式的入口（`./runner.sh`、`scripts/verify.sh`）。绝对路径不算：那是机器上的
  // 东西，缺了跟「任务分支落后了」无关，给合分支的建议只会误导。
  return !isAbsolute(head) && head.includes("/") ? { kind: "path", name: head } : null;
}

/** runner 真会读的那份 manifest 的相对路径。 */
export const askManifest = (ask: GateEntryAsk & { kind: "script" }): string =>
  ask.dir === "." ? "package.json" : `${ask.dir.replace(/\/+$/, "")}/package.json`;

/** package.json 的文本里，`scripts` 定义了这个名字没有。读不动/解析不了返回 null。 */
export function scriptDefinedIn(packageJson: string, name: string): boolean | null {
  try {
    const scripts = (JSON.parse(packageJson) as { scripts?: Record<string, unknown> }).scripts;
    if (scripts === undefined) return false;
    if (scripts === null || typeof scripts !== "object") return null;
    return typeof scripts[name] === "string";
  } catch { return null; }
}

/** 这个相对路径有没有踩出这份树（`../` 那种一律不判，它本来就不在树里）。 */
export function insideTree(treeDir: string, name: string): string | null {
  if (isAbsolute(name)) return null;
  const resolved = normalize(join(treeDir, name));
  const inside = relative(normalize(treeDir), resolved);
  return !inside || (!inside.startsWith("..") && !isAbsolute(inside)) ? resolved : null;
}

/**
 * 起跑前核这一次。**调用点只能是 spawn 之前**，否则这份答案就不再是「起跑那一刻」的。
 *
 * 核不出来（命令认不出、manifest 读不动、目录踩出树）一律返回 null：这一层宁可交白卷，
 * 也不能交一个推出来的答案 —— 下游拿它去说「测试一行都没跑、不要改代码」。
 */
export async function probeGateEntry(treeDir: string, command: string): Promise<GateEntryProbe | null> {
  const ask = gateEntryAsk(command);
  if (!ask) return null;
  if (ask.kind === "path") {
    const resolved = insideTree(treeDir, ask.name);
    return resolved ? { ask: ask.name, resolved: existsSync(resolved), by: "被测快照里的文件" } : null;
  }
  // 命令行只是三个配置来源之一：环境和 npmrc 同样能把 runner 指到另一份 manifest
  // （第 5 轮审查 F1 实测）。这两处解释不了就交白卷 —— 这一层的结论会被下游当成
  // 「测试一行都没跑、不要改代码」。
  if (scopeChangingEnv() || await scopeChangingRc(treeDir, ask.runner)) return null;
  const file = askManifest(ask);
  const resolved = insideTree(treeDir, file);
  if (!resolved) return null;
  const manifest = await readFile(resolved, "utf8").catch(() => null);
  if (manifest === null) return null;
  const defined = scriptDefinedIn(manifest, ask.name);
  return defined === null ? null : { ask: ask.name, resolved: defined, by: `被测快照 ${file} 的 scripts` };
}

/** 落盘与读回。字段形状变了就当没核过 —— 跨机接力和旧行都可能带着老形状。 */
export const encodeGateEntryProbe = (probe: GateEntryProbe | null): string | null =>
  probe ? JSON.stringify(probe) : null;

export function decodeGateEntryProbe(raw: string | null | undefined): GateEntryProbe | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<GateEntryProbe>;
    return typeof value.ask === "string" && typeof value.resolved === "boolean" && typeof value.by === "string"
      ? { ask: value.ask, resolved: value.resolved, by: value.by } : null;
  } catch { return null; }
}
