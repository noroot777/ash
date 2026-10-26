// 门禁红了，而红的原因**不是断言失败**：有东西没解析出来。
//
// 为什么要跟 rc≠0 分开（用户 2026-10-26）：`exit_code` 把两件出路完全不同的事混成一句
// 「未通过：命令退出码非 0」——
//   · 测试真跑了、红了   → 出路是 agent 去修代码；
//   · 命令点名要跑的东西不在这份快照里 → 代码跟这事无关。项目后来才把它加进去，而任务
//     的开工基线早于那次提交。本机四次都是后者，而门禁只把 npm 的原始报错扔出来。
//
// **这一层能证明什么、不能证明什么（第 1 轮审查 F1 实测，别再放宽）**
//
// 从一份日志里能证明的只有一件事：「某个名字没解析出来」。它**证明不了**「顶层命令没
// 启动」—— 验收命令是任意 shell 字符串，可以多步，runner 还能起子 runner。审查用真实
// npm 复现过：`test:accept` 存在且已经跑起来（日志里有它的输出），它内部调的
// `npm run helper-missing` 缺了，于是日志里出现 `Missing script: "helper-missing"`。
// 旧版本按「这条措辞天生就是 runner 在说找不到」把它判成顶层缺失，于是对着一条**可能正是
// 这次改动写错的**脚本名说「测试一行都没跑、不是代码红了，不要修」。make 缺 prerequisite
// 同样中招 —— 换个行数、再补一条正则都消不掉，判据本身就不成立。
//
// 所以判据收紧成一句可证的话：**那个没解析出来的名字，是不是这条命令自己点名的那个**。
//   · 是（`npm run test:accept` ↔ `test:accept`）→ `entry`：命令点名要跑的东西不在树里。
//     这是唯一会改写 failure、也是唯一敢说「不是断言失败」的一档。
//   · 不是（`npm run test:accept` ↔ `helper-missing`）→ `inner`：点名它的是命令内部某一步。
//     只报观察，**不改 failure、不给出路保证、不说「不用修」**。
//   · 什么都认不出来 → null，照旧按 exit_code 处理。
//
// 判据分两路，**没有一路依赖「这条命令是 npm」**：
//  ① 日志措辞 —— 下表一行一个 runner，加一行就多认一种；npm 只是其中一行。
//  ② 快照里有没有那个入口文件 —— 由调用方把答案喂进来（见 entryPresent），本模块不碰 fs。
//
// 退出码 127/126 **只够判 inner**：POSIX 约定是「shell 找不到要执行的东西」，可一个已经
// 跑起来的脚本最后一步撞上这种事，自己也会以 127 退出（审查 N1）。
//
// 本模块是纯函数：不碰 git、不碰库、不碰 fs，判据可以逐条点测。
import type { AcceptGateFailure } from "@ash/shared/accept-gate";

/** 认出来的是哪一种，以及凭什么。两档的语义差别见文件头。 */
export type MissKind = "entry" | "inner";

export type GateLaunchMiss = {
  kind: MissKind;
  /** 没解析出来的那个名字。只凭退出码认出来时为 null。 */
  name: string | null;
  /** 判定依据的原文一行，写给人看。 */
  evidence: string;
  /** 认出它的是哪一路判据，只用于措辞。 */
  by: string;
};

type MissPattern = { runner: string; re: RegExp };

/**
 * 「找不到某个东西」在各家 runner / shell 下的措辞。捕获组 1 = 那个名字。
 *
 * 全部按行锚定或带足够特征的字样：一份真跑起来的测试日志要正好在行首原样打出这些话才会
 * 误命中，而即便误命中，`inner` 这一档也不改写 failure（见文件头）。
 */
const MISS_PATTERNS: MissPattern[] = [
  // ── 各家 task runner：自己吞掉 127、改报 rc=1，只能认措辞 ──
  // npm 9/10 是 `npm error Missing script: "x"`，npm 6/8 是 `npm ERR! missing script: x`。
  { runner: "npm", re: /^npm (?:error|ERR!)\s+[Mm]issing script:\s*"?([^"\r\n]+?)"?\s*$/m },
  { runner: "pnpm", re: /Missing script:\s*"?([^"\r\n]+?)"?\s*$/m },
  { runner: "yarn", re: /^error Command "([^"\r\n]+)" not found\.?\s*$/m },
  { runner: "yarn", re: /Couldn't find a script named "([^"\r\n]+)"/ },
  { runner: "make", re: /^[^\s:]*make(?:\[\d+\])?: \*\*\* No rule to make target ['`"]([^'`"\r\n]+)['`"]/m },
  { runner: "just", re: /^error: Justfile does not contain recipe ['`"]([^'`"\r\n]+)['`"]/m },
  { runner: "cargo", re: /^error: no such command: ['`"]([^'`"\r\n]+)['`"]/m },
  { runner: "go", re: /^go[^\r\n]*: unknown (?:command|subcommand) "?([^"\r\n]+?)"?\s*$/m },
  { runner: "task", re: /^task: Task "([^"\r\n]+)" does not exist/m },
  { runner: "gradle", re: /^(?:FAILURE: )?.*Task '([^'\r\n]+)' not found in (?:root )?project/m },
  // ── Windows ──
  { runner: "powershell", re: /The term ['"]([^'"\r\n]+)['"] is not recognized as the name of a cmdlet/ },
  { runner: "cmd", re: /^'([^'\r\n]+)' is not recognized as an internal or external command/m },
  // ── POSIX shell：三家措辞各不相同 ──
  { runner: "zsh", re: /^zsh(?::\d+)?: command not found: ([^\r\n]+)$/m },
  { runner: "shell", re: /^[^\s:]*(?:sh|bash|ksh|dash)(?:\[\d+\])?: (?:line \d+: |\d+: )?([^\r\n]+?): (?:command )?not found$/m },
  // 脚本文件本身不在这份快照里
  { runner: "shell", re: /^[^\s:]*(?:sh|bash|ksh|dash|zsh)(?:\[\d+\])?: (?:line \d+: |\d+: )?([^\r\n]+?): No such file or directory$/m },
  // ── 命令内部那一步要用的程序/模块（这些**天然**是 inner，名字不会出现在命令里）──
  { runner: "python", re: /: No module named ([^\s\r\n]+)/ },
  { runner: "node", re: /Cannot find module '([^'\r\n]+)'/ },
];

/** 把一条 shell 命令拆成「词」。判「这个名字是不是命令自己点名的」只认整词相等。 */
function commandWords(command: string): Set<string> {
  return new Set(command.split(/[\s;&|()<>`'"]+/).filter(Boolean));
}

/** 这条命令的第一个词（剥掉前面的环境变量赋值）。入口在不在快照里就是问它。 */
export function commandEntry(command: string): string | null {
  for (const word of command.split(/[\s;&|()<>`'"]+/).filter(Boolean)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) return word;
  }
  return null;
}

/**
 * 判定前多少行算「还没来得及干活」。只在**没有别的判据**时当 inner 的噪音过滤用：
 * 一份真跑起来的测试日志，几十行之后出现的 `Cannot find module` 更可能是被测代码自己
 * 的输出。它**不**用来判 entry —— 位置证明不了谁点名要跑的（审查 F1）。
 */
const ANCHOR_LINES = 40;

function anchoredWithin(log: string, index: number): boolean {
  let lines = 0;
  for (let at = 0; at < index; at++) if (log.charCodeAt(at) === 10 && ++lines >= ANCHOR_LINES) return false;
  return true;
}

/**
 * 这一次红到底是哪一种。认不出来返回 null（照旧按 exit_code 处理）。
 *
 * `log` 要给**日志开头**那一段（不是尾巴）：inner 那一档的噪音过滤只在开头看得出来。
 * `entryPresent` = 这条命令的第一个词在被测快照里在不在；只有确切的 `false` 才算证据
 * （null/undefined = 没法判，比如它不是路径、或快照已清理）。
 */
export function classifyGateLaunch(opts: { command: string; exitCode: number | null; log: string;
  entryPresent?: boolean | null }): GateLaunchMiss | null {
  const words = commandWords(opts.command);
  const entryAbsent = opts.entryPresent === false;
  for (const pattern of MISS_PATTERNS) {
    const match = pattern.re.exec(opts.log);
    if (!match) continue;
    const name = (match[1] ?? "").trim() || null;
    // **唯一**能把这次缺失挂到命令本体上的判据：那个名字就是命令自己点名的那个词。
    if (name !== null && words.has(name)) return { kind: "entry", name, evidence: match[0].trim(), by: pattern.runner };
    if (entryAbsent) break;  // 入口文件都不在，底下那几档更弱的判据没必要再问
    if (!anchoredWithin(opts.log, match.index)) continue;
    return { kind: "inner", name, evidence: match[0].trim(), by: pattern.runner };
  }
  // 入口文件不在这份快照里:这是硬证据,跟日志里说了什么无关(命令可能把输出全吞了)。
  if (entryAbsent) {
    const entry = commandEntry(opts.command);
    return { kind: "entry", name: entry, by: "entry-absent",
      evidence: `被测快照里没有 ${entry ?? "这条命令的入口"} 这个文件` };
  }
  // 只剩退出码:POSIX 约定说的是「shell 找不到要执行的东西」,但一个已经跑起来的脚本
  // 最后一步撞上同样的事也会这么退(审查 N1),所以只够判 inner。
  if (opts.exitCode === 127 || opts.exitCode === 126) {
    return { kind: "inner", name: null, by: "exit-code",
      evidence: opts.exitCode === 127 ? "退出码 127（POSIX shell：有东西没找到）" : "退出码 126（POSIX shell：找到了但不可执行）" };
  }
  return null;
}

/**
 * 这个名字在这份文本里**整词**出现过没有。
 *
 * 为什么不能用子串（第 1 轮审查 F3 实测）：原始事故那条命令叫 `test:accept`，而仓库里
 * 本来就有 `test:accept-merge`、`test:accept-gate-process`。按子串算，快照的
 * `package.json` 也算「含这个名字」，于是「目标分支有、快照没有」的文件集合把真正的
 * 落点排除掉，结论变成「目标分支上也找不到」—— 恰恰是事故那一种输入会踩中。
 *
 * 整词的判据是**两侧都不是名字可以接着长下去的字符**：`"test:accept"` 两侧是引号 → 命中；
 * `test:accept-merge` 右边是 `-` → 不命中。
 */
export function occursAsWord(text: string, name: string): boolean {
  const edge = /[A-Za-z0-9_\-:./]/;
  for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
    const before = at > 0 ? text[at - 1]! : "";
    const after = text[at + name.length] ?? "";
    if ((!before || !edge.test(before)) && (!after || !edge.test(after))) return true;
  }
  return false;
}

/** 只有 `entry` 这一档改写 failure；`inner` 和「认不出」一律原样留在 exit_code 上。 */
export function missFailure(miss: GateLaunchMiss | null): AcceptGateFailure | null {
  return miss?.kind === "entry" ? "command_missing" : null;
}

/**
 * 「它在目标分支上是什么情形」—— 这一段的确定性有三档，**措辞必须跟着档位走**
 * （审查 F3/F4：旧版本把文字命中当成命令存在性，又无条件保证「合进来就能跑」）。
 */
export type GateMissOrigin = {
  targetBranch: string;
  /** 目标分支现在的 HEAD（读不出为 null）。 */
  targetCommit: string | null;
  /** 任务这份快照落后目标分支几个提交（算不出为 null）。这一条总是可核的。 */
  behind: number | null;
  /**
   * 目标分支上有、而快照里没有的落点，以及最早把它写进去的那次提交。
   *
   * `how` 决定**措辞敢说多硬**，两者的确定性差一档：
   *  - `path` 那个名字就是个文件路径，而这个文件只有目标分支上有 —— 文件级的确定事实；
   *  - `text` 只是这个名字在那份文件里**整词**出现过。它不等于「命令定义就在这儿」，
   *    措辞里必须说破（审查 F3：旧版本把文字命中直接冒充命令存在性）。
   */
  holders: { file: string; how: "path" | "text"; commit: string; date: string; subject: string }[];
  /** 名字抽不出来、或核对没做完（读不出 / 超预算）：那时只有 behind 这一条算数。 */
  unverified: boolean;
};

const short = (commit: string) => commit.slice(0, 8);
const day = (iso: string) => iso.slice(0, 16).replace("T", " ");

/**
 * 写给人和 agent 的那段结论。**纯文本不带 markdown**（审查 N4）：它的四个去处里有三个
 * （门禁日志、验收卡、MCP 回执字符串）是纯文本，星号和反引号只会原样显示。
 *
 * 出路**只在核实过的前提下给**（审查 F4）：确认目标分支上有 → 才建议合进来；确认没有
 * → 那是命令本身或环境的问题，合分支解决不了；没核对出来 → 明说不能保证。
 */
export function gateCommandMissNotice(opts: {
  command: string;
  miss: GateLaunchMiss;
  sourceCommit: string | null;
  origin: GateMissOrigin | null;
}): string {
  const { miss, origin } = opts;
  const subject = miss.name ? `「${miss.name}」` : "它要跑的那个东西";
  const ran = `（这一次跑的是 ${opts.command}${opts.sourceCommit ? `，被测快照 ${short(opts.sourceCommit)}` : ""}）`;
  // inner：点名它的是命令内部某一步，不是这条命令本身。能说的到此为止 —— 既不敢说
  // 「测试没跑」，也不敢说「跟这次改动无关」，更不给出路保证（审查 F1/F2/F4）。
  if (miss.kind === "inner") {
    return [
      `这条命令跑起来了，红的原因是它中途点名的 ${subject} 没解析出来，不像是断言失败。`,
      `判据：${miss.evidence}${ran}。`,
      `这可能是环境缺件（依赖没装、机器上没这个程序），也可能是这次改动把名字写错了 —— `
        + `两种都要核一遍才知道，不能当成「不用修」。`,
    ].join("\n");
  }
  const lines = [
    `这条命令点名要跑的 ${subject} 在被测快照里解析不出来：它要测的东西一行都没跑到，这不是断言失败。`,
    `判据：${miss.evidence}${ran}。`,
  ];
  lines.push(...originLines(origin, subject));
  return lines.join("\n");
}

/** 第二件事（目标分支上的情形）+ 第三件事（出路）。两者必须同档，否则就是空头保证。 */
function originLines(origin: GateMissOrigin | null, subject: string): string[] {
  const skip = "在验收确认框里明确选「这次跳过前置命令」，直接合并 —— 那就是没有任何测试凭据地合，记录里会如实这么写。";
  const mine = "这两条都要你自己定：ash 不会替你合分支，也不会替你跳过门禁。";
  const behind = !origin || origin.behind === null ? ""
    : origin.behind > 0 ? `任务分支现在落后 ${origin.targetBranch} ${origin.behind} 个提交。`
      : `任务分支并不落后于 ${origin.targetBranch}（所以合它进来也不会多出什么）。`;
  // ① 核实了：目标分支上有落点、而快照里没有。只有这一档敢建议合分支。
  if (origin && origin.holders.length) {
    const where = (holder: GateMissOrigin["holders"][number]) =>
      `${holder.file}（最早写进它的是 ${short(holder.commit)}，${day(holder.date)}，${holder.subject}）`;
    // 文件级那一档是确定事实，可以直说；文字命中那一档必须带上对冲（审查 F3）。
    const byPath = origin.holders.filter(holder => holder.how === "path");
    const byText = origin.holders.filter(holder => holder.how === "text");
    const facts = [
      byPath.length ? `${subject} 这个文件只有目标分支上有、这份快照里没有：${byPath.map(where).join("；")}。` : "",
      byText.length ? `${subject} 在 ${origin.targetBranch} 上整词出现在这些文件里、而这份快照里没有：${byText.map(where).join("；")}。`
        + `这是文字命中，不等于它就是那条命令的定义，但这些提交确实都不在被测快照里。` : "",
    ].filter(Boolean).join("");
    return [
      `${facts}${behind}`,
      `出路：`,
      `1. 把 ${origin.targetBranch} 合进任务分支（或以它为基线重建任务分支），再点验收 —— `
        + (byPath.length && !byText.length
          ? `那时这个文件就在树里了。`
          : `如果上面那个落点就是它的定义，那时这条命令就在树里了；合完仍然报同样的错，说明定义不在那儿，按下面第 2 条或核对项目设置里这条命令。`),
      `2. ${skip}`,
      mine,
    ];
  }
  // ② 核实了：目标分支上也没有。合分支解决不了 —— 这一档**绝不能**给合入建议。
  if (origin && !origin.unverified) {
    return [
      `${origin.targetBranch}${origin.targetCommit ? `（${short(origin.targetCommit)}）` : ""} 上也找不到 ${subject}。`
        + `${behind}所以这不是「任务分支落后了」—— 合目标分支进来也不会让它出现。`,
      `出路：`,
      `1. 核对项目设置里这条验收前置命令本身：名字是不是拼错了，或者它只装在某台机器上、从没进过仓库。`,
      `2. ${skip}`,
      mine,
    ];
  }
  // ③ 没核对出来（不是 git 任务、分支读不出、或核对超了预算）：如实说不知道。
  return [
    `它在目标分支上是什么情形，这次没能核对出来${origin ? `（${behind || "连落后多少个提交都没算出来"}）` : "（读不到仓库或目标分支）"}，`
      + `所以不能保证「把目标分支合进来再验收」就能解决。`,
    `出路：`,
    `1. 自己核一眼目标分支上有没有这条命令：有就把它合进任务分支再验收，没有就去核对项目设置里这条命令。`,
    `2. ${skip}`,
    mine,
  ];
}
