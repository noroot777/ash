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
// 所以这一层退回**纯读**：只看文件系统和那份 manifest 的文本，一个进程都不起。读出来的东西
// 因此**只够当必要条件之一**——「测试没启动」那个结论由归类层（accept-gate-miss.ts）在三件
// 事同时成立时才给，另两件都来自**真跑那一次自己的输出**。配置把落点改到别处时这一层会读错
// 那份 manifest，但那种读错在归类层被另外两件事挡住（见那边的文件头）。
//
// 规矩是**证明不了就交白卷**。判据是「这条命令的执行目标我能不能完整解释」，不是「它像不像
// 我见过的形状」：
//  · 命令里有任何读不准的 shell 语义（多步、分组、后台、变量、命令替换、通配、转义、未闭合
//    引号），返回 null；注释按 shell 语义截断，不当成参数。第 6 轮审查实测两条反例：
//    `(./runner.sh)` 旧版当成一个叫 `(./runner.sh)` 的文件去查、查不到就发免修令，而 shell
//    真把括号里那条跑了；`./missing & ./runner.sh` 旧版只认前半截，拿它的缺失代表整条命令。
//  · 选项**只认白名单**（换目录的、确定不吃词的开关、确定只影响输出的带值选项），其余一律
//    返回 null —— 带不带等号都一样。靠黑名单逐条堵组合这条路已经证明走不通。
//  · 只认那些**绝对没有默认行为**的子命令（`npm run X`、`npm test`），有默认行为的名字一律
//    不认（`start`/`restart`/`stop`，还有 npm 内建的 `env` —— 第 6 轮审查实测
//    `npm run env -- node fail.cjs` 真把 `fail.cjs` 跑了），而且子命令必须在最前
//    （`npm test run` 不是「跑 run 这个脚本」）。
//  · 只认 npm。pnpm/yarn 的配置层和内建脚本语义这台机器上没有实测环境，外推错了要发出去的
//    是「测试一行都没跑、不要改代码」—— 那张白卷只是少下一个结论。
//
// 反方向也要说清：`resolved: true` **只证明它在树里，不证明它跑起来了**（审查实测：一个存在
// 但没有执行权限的脚本退 126，正文一行没跑）。所以 true 这一档的措辞里不许出现「确实跑起来
// 了」—— 那句话这一层给不出来。
//
// 答案在 spawn 之前一次定下来，落到 accept_gate_runs.entryProbe 上，之后只许读它、不许重算
// （跑完再核一次拿到的是跑完之后的状态，见上面②）。
import { existsSync, readFileSync } from "node:fs";
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
   * 自己。归因层核 git 历史时必须核**同一个文件**，否则两边各按自己的理解去解释命令行，
   * 落点一挪就各说各话（第 9 轮审查 F2）。所以它是字段，不是从 `by` 那句话里抠出来的。
   */
  file: string;
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
 * 交白卷 —— 下游拿这个答案去说「测试一行都没跑、不要改代码」。
 */
export function gateEntryAsk(command: string): GateEntryAsk | null {
  const words = tokenize(command);
  if (!words) return null;
  // 前缀的环境变量赋值（`CI=1 npm run x`）不是入口，剥下来。它们也能换掉 runner 去哪儿找
  // 脚本（实测 `npm_config_workspace=child npm run test:accept` 真让它跑了子项目那个脚本）
  // 或者换掉 `npm` 本身（`PATH=bin`），所以这一层读出来的那份 manifest 可能不是真要跑的
  // 那份 —— 那种读错由归类层的另两件事挡住（见 accept-gate-miss.ts 文件头）。
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

/** 脚本那一档要核的那份 manifest；踩出树就没地方核（归因层还要拿它去查 git 历史）。 */
function manifestInTree(treeDir: string, ask: GateEntryAsk): string | null {
  if (ask.kind !== "script") return null;
  const file = askManifest(ask);
  return insideTree(treeDir, file) ? file : null;
}

/**
 * **spawn 之前**把这条命令点名要跑的东西核一眼。认不出的形状、读不动的 manifest 一律 null
 * （交白卷）。
 *
 * 一个进程都不起：只 `existsSync` 和读一份 manifest 的文本。为什么不去问 npm（它才最知道自己
 * 会读哪份 manifest）见文件头 —— 那条路第 8 轮被判死：它答的是**查询那一次**的状态，而且替
 * 用户多跑了两次项目代码。
 *
 * 所以这个答案**不是**「测试没启动」的充分条件，只是三件必要条件中的一件；另两件由归类层从
 * 真跑那一次自己的输出里取（accept-gate-miss.ts 文件头）。
 */
export function probeGateEntry(treeDir: string, command: string): GateEntryProbe | null {
  const ask = gateEntryAsk(command);
  if (!ask) return null;
  if (ask.kind === "path") {
    const resolved = insideTree(treeDir, ask.name);
    return resolved
      ? { ask: ask.name, file: entryFile(ask), resolved: existsSync(resolved), by: "被测快照里的文件" }
      : null;
  }
  const file = manifestInTree(treeDir, ask);
  if (!file) return null;
  let text: string;
  try { text = readFileSync(join(treeDir, file), "utf8"); } catch { return null; }
  const defined = scriptDefinedIn(text, ask.name);
  return defined === null ? null
    : { ask: ask.name, file, resolved: defined, by: `被测快照 ${file} 的 scripts` };
}

/** 落盘与读回。字段形状变了就当没核过 —— 跨机接力和旧行都可能带着老形状。 */
export const encodeGateEntryProbe = (probe: GateEntryProbe | null): string | null =>
  probe ? JSON.stringify(probe) : null;

export function decodeGateEntryProbe(raw: string | null | undefined): GateEntryProbe | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<GateEntryProbe>;
    return typeof value.ask === "string" && typeof value.file === "string"
      && typeof value.resolved === "boolean" && typeof value.by === "string"
      ? { ask: value.ask, file: value.file, resolved: value.resolved, by: value.by } : null;
  } catch { return null; }
}
