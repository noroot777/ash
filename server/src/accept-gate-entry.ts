// 「这条命令点名要跑的是什么，**起跑那一刻**它在被测树里解析得出来吗」。
//
// 这一层只回答这一句。为什么非得在起跑前问、而且事后的任何痕迹都不能替它（第 2 轮审查 F1 实测两条反例）：
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
// **而「runner 去哪儿找」压根不是这一层能解释完的**（第 5、6 轮审查 F1 实测：`--workspace=
// child`、`npm_config_workspace=child`、`.npmrc` 里 `workspace=child`、再到数组写法
// `workspace[]=child`）—— 四层配置、数组写法、别名都是 npm 的语义，逐条枚举补一个漏一个。
//
// 为此第 6、7 轮试过「让 npm 自己回答」：先 execFile 起 npm，后来改成把 `npm run --json` /
// `npm prefix` 插在用户命令前面、同一次 `sh -lc` 里跑。**这条路第 8 轮审查判死，别再走**：
//  · 它答的是**查询那一次**的状态，不是**真跑那一次**的（F1 实测：命令带
//    `NODE_OPTIONS='--require ./preload.cjs'`，preload 只在 argv 里有 `test:accept` 时才生成
//    那个脚本。两问的 argv 里没有它 → 答「没有」；真跑那次生成了、跑了、报了断言失败 ——
//    于是一次真的失败被说成「一行都没跑到、不要改代码」）。查询和执行之间的任何副作用都能
//    把答案变成谎话，而「同一个 shell」只对齐了环境，对齐不了时点；
//  · 它**替用户多跑了两次项目代码**（F2 实测：一次验收 = 3 次 preload，不带它是 1 次）。
//    继承的 `NODE_OPTIONS`、前置赋值里的 preload、自带 npm 包装器的初始化动作都会跟着跑，
//    「npm 列脚本不执行 script body」证明不了「整次查询没跑任何项目代码」。诊断没有资格
//    擅自增加用户代码的执行次数。
//
// 所以这一层退回**纯读**：只看文件系统和那份 manifest 的文本，一个进程都不起。
//
// 读出来的东西分两种，处置不同：
//  · **核得准**（`certain`）：入口是一个具体文件（`./kb.sh`、`scripts/verify.sh`）。shell 对含
//    `/` 的名字不查 PATH，也没有配置能把它挪走 —— 快照里没有，这条命令就不可能跑起来。这一档
//    **不起跑**，直接说「被测的这棵树里没有它」，再附一句它在目标分支上有没有。
//    「没有」必须是**内核对同一个字符串**给出的 ENOENT/ENOTDIR：拿原样的路径从快照根去 stat，
//    不先做 `normalize`。词法折叠 `..` 跟内核不等价 —— `./alias/../runner.sh` 里 alias 是目录
//    软链时，内核先进软链再退一级，跑的是 `real/runner.sh`，而折叠后核的是根目录下并不存在的
//    `runner.sh`，一条能跑绿的命令就被挡在门外（第 1 轮审查 F1 实测）。读不出来（权限之类）不算
//    「没有」，交白卷。目标分支那半句另有一套（accept-gate-entry-target.ts）。
//  · **核不准**：npm 脚本。runner 去哪份 manifest 找脚本，四层配置（命令行、环境变量、`.npmrc`、
//    workspace）都能改，这一层读的只是命令行上解释出来的那份。所以照常起跑；红了只把起跑前
//    看到的那件事和原始输出并排摆出来，不下结论。
//
// 曾经还有第三种用法：跑完之后从日志里反推「刚才到底跑没跑起来」，拿这份事实当三件必要条件
// 之一。那条路证明不了日志里那句报错是顶层命令喊的还是测试内部的子命令喊的，审查十轮后降级成
// 「只给线索」，2026-11 整个删掉了。
//
// 规矩是**证明不了就交白卷**。判据是「这条命令的执行目标我能不能完整解释」，不是「它像不像
// 我见过的形状」：
//  · 命令里有任何读不准的 shell 语义（多步、分组、后台、变量、命令替换、通配、转义、未闭合
//    引号），返回 null；注释按 shell 语义截断，不当成参数。第 6 轮审查实测两条反例：
//    `(./runner.sh)` 旧版当成一个叫 `(./runner.sh)` 的文件去查，而 shell 真把括号里那条跑了；
//    `./missing & ./runner.sh` 旧版只认前半截，拿它的缺失代表整条命令。路径那一档据此拦下
//    起跑，认错一次就是把一条能跑的命令挡在门外。
//  · 选项**只认白名单**（换目录的、确定不吃词的开关、确定只影响输出的带值选项），其余一律
//    返回 null —— 带不带等号都一样。靠黑名单逐条堵组合这条路已经证明走不通。
//  · 只认那些**绝对没有默认行为**的子命令（`npm run X`、`npm test`），有默认行为的名字一律
//    不认（`start`/`restart`/`stop`，还有 npm 内建的 `env` —— 第 6 轮审查实测
//    `npm run env -- node fail.cjs` 真把 `fail.cjs` 跑了），而且子命令必须在最前
//    （`npm test run` 不是「跑 run 这个脚本」）。
//  · 只认 npm。pnpm/yarn 的配置层和内建脚本语义这台机器上没有实测环境，白卷只是少说一句事实。
//
// 反方向也要说清：`resolved: true` **只证明它在树里，不证明它跑起来了**（审查实测：一个存在
// 但没有执行权限的脚本退 126，正文一行没跑）。
//
// 答案在 spawn 之前一次定下来，落到 accept_gate_runs.entryProbe 上，之后只许读它、不许重算
// （跑完再核一次拿到的是跑完之后的状态，见上面②）。
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";

/** 这条命令点名要跑的东西，分能核实的两种。其余形状一律认不出（见文件头）。 */
export type GateEntryAsk =
  | { kind: "path"; name: string }
  /** `dir` = 按命令行解释出来的那个 manifest 目录（相对被测树，默认 `.`）。 */
  | { kind: "script"; name: string; dir: string };

export type GateEntryProbe = {
  /** 点名要跑的那个东西：脚本名，或相对这份树的路径。 */
  ask: string;
  /**
   * 起跑前**真去读的那个文件**（相对被测树）：脚本那一档是那份 manifest，路径那一档就是它
   * 自己。去目标分支上核「有没有」时核的就是这一个，不从 `by` 那句话里抠。
   */
  file: string;
  /**
   * 起跑那一刻它解析得出来没有。`true` 只说明它在树里 —— **不**说明它跑起来了（权限、
   * 解释器都可能挡在后面）。
   */
  resolved: boolean;
  /** 在哪儿核的，写给人看。 */
  by: string;
  /** 这份答案核得准不准（见文件头）：准的那一档答「不在」就不起跑。 */
  certain: boolean;
  /**
   * 核得准、又不在的时候，它在目标分支上有没有（`has: null` = 读不出来）。没有合并目标的任务
   * （直接在项目目录里干活）没有这一项。起跑前一次定下，跟着这一行落盘。
   */
  target?: { branch: string; has: boolean | null } | null;
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
 * 这几个名字**走 `run` 也一样**有默认行为，所以「表里没有」推不出「没东西可跑」：
 *  · `npm run start`（没有 `scripts.start`、目录里有 `server.js`）真的去跑了 `node server.js`
 *    并打出那个脚本的输出（第 4 轮审查 F1 实测）；
 *  · `npm run env -- node fail.cjs` 真的把 `fail.cjs` 跑了（第 6 轮审查 F1 实测）—— `env` 是
 *    npm 的内建脚本，而 `npm run --json` 列的表里**没有**它（实测），光看表只会得出「不存在」。
 */
const DEFAULTED_SCRIPTS = new Set(["start", "restart", "stop", "env"]);

/** 这些**子命令**把「跑什么」整个换掉，不是在跑本项目的脚本。 */
const SCOPE_SUBCOMMANDS = new Set(["workspace", "workspaces", "exec", "dlx", "recursive"]);

/** 告诉 runner 换目录的选项。值可以跟在后面，也可以 `=` 连写。 */
const DIR_FLAGS = new Set(["--prefix", "-C", "--dir", "--cwd"]);

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
 * 不带引号的 —— 审查 F1 实测）。其余一概交白卷：多步、分组 `( )`、后台 `&`、变量、命令
 * 替换、通配、转义、未闭合引号。分组和 `&` 是第 6 轮审查实测补上的 —— 它们不改变「有东西
 * 被跑了」这件事，却让旧版去查一个字面上并不存在的文件名。
 */
function tokenize(command: string): string[] | null {
  // `2>&1` 里那个 `&` 是重定向的一部分，不是后台 —— 先把 `>&1` / `<&0` 这类摘掉再筛控制符，
  // 否则一条普普通通的 `npm run x > out.log 2>&1` 会被整条拒掉（回归用例当场抓到）。
  // `&>` 留着不摘:那是另一种重定向写法,下面那个重定向正则读不准它,宁可交白卷。
  const control = command.replace(/[<>]&\d*/g, "");
  if (/[;\n\r|&()]/.test(control)) return null;            // 多步 / 分组 / 后台：没有「一个入口」可言
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
 * 把 runner 自己的那段参数读出来：位置参数（`run` / 脚本名 / 子命令）、它会去哪个目录读
 * manifest、以及**重放那两问时要原样带上的目录选项**。任何一个词解释不了就返回 null。
 *
 * 两条都是实测来的（第 4 轮审查 F1）：
 *  · `--` 之后的词是**传给脚本的**，npm 自己不再解释 —— `npm run x -- --prefix child` 跑的
 *    是根目录那个 `x`，`--prefix child` 只是它的 argv。旧版本把整条命令扫一遍找 `--prefix`，
 *    于是去读了 `child/package.json`，把一次真跑起来、真报断言失败的红说成「一行都没跑到」。
 *  · 未知选项可能吃掉后面那个词（`--loglevel warn`），所以不许按「以 `-` 开头就跳过」去
 *    猜位置参数。
 *
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
      dir = value;                     // 规范成「选项 值」两词，重放时不必再管写法
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
 * 这条命令点名要跑的是什么。认不出来返回 null。
 *
 * 判据全在文件头：能读准的 shell 语义 + 没有默认行为的子命令 + 只认 npm。任何一条不满足就
 * 交白卷 —— 路径那一档的「不在」会直接拦下起跑。
 */
export function gateEntryAsk(command: string): GateEntryAsk | null {
  const words = tokenize(command);
  if (!words) return null;
  // 前缀的环境变量赋值（`CI=1 npm run x`）不是入口，剥下来。它们也能换掉 runner 去哪儿找
  // 脚本（实测 `npm_config_workspace=child npm run test:accept` 真让它跑了子项目那个脚本）
  // 或者换掉 `npm` 本身（`PATH=bin`）—— 脚本那一档因此只算核不准。路径那一档不受影响：
  // 含 `/` 的名字 shell 不查 PATH。
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift();
  const head = words[0];
  if (!head) return null;
  if (head === "npm") {
    const args = runnerArgs(words.slice(1));
    if (!args) return null;
    const { positional, dir } = args;
    // 子命令必须在最前：`npm test run` 是「跑 test 这个生命周期」，不是「跑 run 这个脚本」。
    const sub = positional[0];
    if (sub === "run" || sub === "run-script") {
      const name = positional[1];
      // `run` 也绕不开默认行为：`npm run start` 缺 `scripts.start` 时照样跑 `node server.js`，
      // `npm run env` 跑的是 npm 的内建 env。
      return !name || DEFAULTED_SCRIPTS.has(name) ? null : { kind: "script", name, dir };
    }
    return sub && NPM_LIFECYCLE.has(sub) ? { kind: "script", name: sub, dir } : null;
  }
  // 相对路径形式的入口（`./runner.sh`、`scripts/verify.sh`）。绝对路径不算：那是机器上的
  // 东西，缺了跟「任务分支落后了」无关，给合分支的建议只会误导。pnpm/yarn 这类名字落不进
  // 这一支（不含 `/`），于是自然交白卷 —— 见文件头最后一条。
  return !isAbsolute(head) && head.includes("/") ? { kind: "path", name: head } : null;
}

/** 这条命令点名的东西落在哪个文件上：脚本那一档是 manifest，路径那一档是它自己。 */
export const entryFile = (ask: GateEntryAsk): string =>
  ask.kind === "path" ? ask.name.replace(/^\.\/+/, "") : askManifest(ask);

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
 * 这个相对路径从 `treeDir` 起，内核解析得到没有。**原样拼接、不 normalize**：`..` 和软链交给内核按
 * 跟 shell 一模一样的规则解，核的就是 shell 真会去找的那个东西（见文件头）。只有 ENOENT / ENOTDIR
 * 才算「没有」；其余读不出来的一律 null。
 */
function entryOnDisk(treeDir: string, name: string): boolean | null {
  try { statSync(`${treeDir}/${name}`); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? false : null;
  }
}

/** 脚本那一档要核的那份 manifest；踩出树就没地方核。 */
function manifestInTree(treeDir: string, ask: GateEntryAsk): string | null {
  if (ask.kind !== "script") return null;
  const file = askManifest(ask);
  return insideTree(treeDir, file) ? file : null;
}

/**
 * **spawn 之前**把这条命令点名要跑的东西核一眼。认不出的形状、读不动的 manifest 一律 null
 * （交白卷）。
 *
 * 一个进程都不起：只 `stat` 一个路径和读一份 manifest 的文本。为什么不去问 npm（它才最知道自己
 * 会读哪份 manifest）见文件头 —— 那条路第 8 轮被判死：它答的是**查询那一次**的状态，而且替
 * 用户多跑了两次项目代码。
 */
export function probeGateEntry(treeDir: string, command: string): GateEntryProbe | null {
  const ask = gateEntryAsk(command);
  if (!ask) return null;
  if (ask.kind === "path") {
    const present = insideTree(treeDir, ask.name) ? entryOnDisk(treeDir, ask.name) : null;
    return present === null ? null
      : { ask: ask.name, file: entryFile(ask), resolved: present, by: "被测快照里的文件", certain: true };
  }
  const file = manifestInTree(treeDir, ask);
  if (!file) return null;
  let text: string;
  try { text = readFileSync(join(treeDir, file), "utf8"); } catch { return null; }
  const defined = scriptDefinedIn(text, ask.name);
  return defined === null ? null
    : { ask: ask.name, file, resolved: defined, by: `被测快照 ${file} 的 scripts`, certain: false };
}

/** 核得准、而且不在：这一档不起跑。 */
export const entryCertainlyMissing = (probe: GateEntryProbe | null): boolean =>
  !!probe && probe.certain && !probe.resolved;

/**
 * 卡片状态那一行、时间线、交回 agent 的输入共用的那句话。纯文本：日志和 MCP 回执都不渲染 markdown。
 *
 *  - 核得准的那一档（没起跑）：确定地说它不在，再附目标分支上的情形；
 *  - 核不准的那一档（跑了、红了）：只陈述起跑前看到的，原始输出就摆在旁边，结论留给读的人；
 *  - 其余（入口在、没核、绿了）：没有可说的，null。
 */
export function gateEntryNote(probe: GateEntryProbe | null, status: string): string | null {
  if (!probe || probe.resolved || status !== "failed") return null;
  if (!probe.certain) return `起跑前看到：${probe.by} 里没有 ${probe.ask}（这一项核不准，npm 可能按配置去别处找）。`;
  const target = probe.target;
  const there = !target ? ""
    : target.has === true ? `目标分支 ${target.branch} 上有它。`
      : target.has === false ? `目标分支 ${target.branch} 上也没有。`
        : `目标分支 ${target.branch} 上有没有它，这次没读出来。`;
  return `被测的这棵树里没有 ${probe.ask}，命令没有起跑。${there}`;
}

/** 落盘与读回。字段形状变了就当没核过 —— 跨机接力和旧行都可能带着老形状。 */
export const encodeGateEntryProbe = (probe: GateEntryProbe | null): string | null =>
  probe ? JSON.stringify(probe) : null;

export function decodeGateEntryProbe(raw: string | null | undefined): GateEntryProbe | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<GateEntryProbe>;
    if (typeof value.ask !== "string" || typeof value.file !== "string"
      || typeof value.resolved !== "boolean" || typeof value.by !== "string") return null;
    const target = value.target && typeof value.target.branch === "string"
      && (value.target.has === null || typeof value.target.has === "boolean")
      ? { branch: value.target.branch, has: value.target.has } : null;
    // 没有 `certain` 的旧行一律当核不准：那时候还没有「不起跑」这一档，不能事后替它说「没起跑」。
    return { ask: value.ask, file: value.file, resolved: value.resolved, by: value.by,
      certain: value.certain === true, target };
  } catch { return null; }
}
