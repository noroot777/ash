// 门禁红了，而红的原因**不是断言失败**：有东西没解析出来。
//
// 为什么要跟 rc≠0 分开（用户 2026-10-26）：`exit_code` 把两件出路完全不同的事混成一句
// 「未通过：命令退出码非 0」——
//   · 测试真跑了、红了   → 出路是 agent 去修代码；
//   · 命令点名要跑的东西不在这份快照里 → 那条命令一行都没跑到，出路跟修代码无关。本机
//     四次都是后者（命令都是 `npm run test:accept`），而门禁只把 npm 的原始报错扔出来。
//
// **「测试压根没启动」这句话只有一个授权来源：起跑前核过的那份事实**
// （accept-gate-entry.ts，第 2 轮审查 F1）。日志里的措辞和跑完之后的文件状态都不行：
//   · 日志不说是哪一层在喊 —— 顶层 `test:accept` 已经在跑、它内部的 `npm --prefix child
//     run test:accept` 缺了**同名**脚本，日志长得和顶层缺失一模一样。第 1 轮把判据收紧到
//     「这个名字是不是命令自己点名的那个词」，这条反例正好从那个口子穿过去；
//   · 跑完看文件在不在也不行 —— 一条先打印启动提示、`rm "$0"` 删掉自己、再报断言失败的
//     脚本，事后看就是「入口不存在」。
//
// 所以三档：
//   · `entry`：起跑前核过，它解析不出来。**唯一会改写 failure、唯一敢说「这不是断言失败」。**
//   · `inner`：别的都归这儿 —— 日志里认出某个名字没解析出来，但谁点名的、命令整体有没有
//     跑起来，这一层**都不敢断定**。只报观察，不改 failure，不给出路保证，不说「不用修」。
//   · null：什么都认不出，照旧按 exit_code 处理。
//
// 日志措辞表（MISS_PATTERNS）因此降格成**线索**：它提供那个名字，让 inner 那段话说得具体，
// 并在 entry 成立时充当旁证。加一行只是多认一种措辞，不会多授权任何断言。
//
// 退出码 127/126 同样只够判 inner：POSIX 约定是「shell 找不到要执行的东西」，可一个已经
// 跑起来的脚本最后一步撞上这种事，自己也会以 127 退出（第 1 轮审查 N1）。
//
// 本模块是纯函数：不碰 git、不碰库、不碰 fs，判据可以逐条点测。
import type { AcceptGateFailure } from "@ash/shared/accept-gate";
import type { GateEntryProbe } from "./accept-gate-entry.js";

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
  /**
   * 起跑前核到的那份事实（accept-gate-entry.ts）。
   *  - `false` → 它解析不出来。这是 `entry` 的**唯一**授权来源。
   *  - `true`  → 它在树里。那么命令确实跑起来了，inner 的措辞才敢这么说。
   *  - `null`  → 没核出来（命令形状认不了、manifest 读不动）。**这时一个字都不许推断。**
   */
  entryResolved: boolean | null;
  /** 日志里那个名字跟命令点名的那个同名，但起跑前没核实到。只影响 inner 的措辞。 */
  sameName?: boolean;
};

type MissPattern = { runner: string; re: RegExp };

/**
 * 「找不到某个东西」在各家 runner / shell 下的措辞。捕获组 1 = 那个名字。
 *
 * 这张表只提供**线索**（那个名字），不授权任何断言：谁点名要跑它、命令整体有没有启动，
 * 一行日志都答不了（见文件头 F1 两条反例）。所以误命中的代价只是 inner 那段话说得不准，
 * 不会把一次真的断言失败说成「没启动、不要修」。
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

/**
 * 判定前多少行算「还没来得及干活」。只当 inner 的噪音过滤用：一份真跑起来的测试日志，
 * 几十行之后出现的 `Cannot find module` 更可能是被测代码自己的输出。
 */
const ANCHOR_LINES = 40;

function anchoredWithin(log: string, index: number): boolean {
  let lines = 0;
  for (let at = 0; at < index; at++) if (log.charCodeAt(at) === 10 && ++lines >= ANCHOR_LINES) return false;
  return true;
}

type PatternHit = { runner: string; name: string | null; text: string; index: number };

function firstPatternHit(log: string): PatternHit | null {
  for (const pattern of MISS_PATTERNS) {
    const match = pattern.re.exec(log);
    if (!match) continue;
    return { runner: pattern.runner, name: (match[1] ?? "").trim() || null,
      text: match[0].trim(), index: match.index };
  }
  return null;
}

/**
 * 这一次红到底是哪一种。认不出来返回 null（照旧按 exit_code 处理）。
 *
 * `log` 要给**日志开头**那一段（不是尾巴）：inner 那一档的噪音过滤只在开头看得出来。
 * `entry` 是**起跑前**核到的那份事实（accept-gate-entry.ts）；没有它，这个函数**绝不会**
 * 返回 `entry` 档 —— 这是第 2 轮审查 F1 两条反例换来的硬约束，别再放宽。
 */
export function classifyGateLaunch(opts: { command: string; exitCode: number | null; log: string;
  entry?: GateEntryProbe | null }): GateLaunchMiss | null {
  const entry = opts.entry ?? null;
  const entryResolved = entry ? entry.resolved : null;
  const hit = firstPatternHit(opts.log);
  // ① 起跑前核过、它解析不出来：命令点名要跑的东西不在这份树里，所以它一行都没跑到。
  //    日志里正好有同名的那条措辞就把原文也带上当旁证，没有也不影响这个结论 —— 命令
  //    可能把输出全吞了（`2>/dev/null`）。
  if (entry && !entry.resolved) {
    const corroborated = hit && hit.name === entry.ask ? `${hit.text}；` : "";
    return { kind: "entry", name: entry.ask, by: entry.by, entryResolved: false,
      evidence: `${corroborated}起跑前核过 ${entry.by}：没有 ${entry.ask}` };
  }
  // ② 日志里认出某个名字没解析出来。谁点名的、命令整体有没有跑起来，一律不推断。
  if (hit) {
    const sameName = hit.name !== null
      && (entry ? hit.name === entry.ask : commandWords(opts.command).has(hit.name));
    // 同名那一条是**最该说清楚**的（它正是上一轮判错的那个形状），不许被噪音过滤吃掉。
    if (sameName || anchoredWithin(opts.log, hit.index)) {
      return { kind: "inner", name: hit.name, evidence: hit.text, by: hit.runner, entryResolved, sameName };
    }
  }
  // ③ 只剩退出码：POSIX 约定说的是「shell 找不到要执行的东西」，但一个已经跑起来的脚本
  //    最后一步撞上同样的事也会这么退（第 1 轮审查 N1），所以只够判 inner。
  if (opts.exitCode === 127 || opts.exitCode === 126) {
    return { kind: "inner", name: null, by: "exit-code", entryResolved,
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
 * 「它在目标分支上是什么情形」—— 这一段的确定性分三档，**措辞必须跟着档位走**。
 *
 * 第 2 轮审查 F2 实测的那条反例逼出了「文字检索不能用来否定存在」这条铁律：基线
 * `package.json` 的 `description` 里本来就写着 `test:accept`（「CI will invoke
 * test:accept」），目标分支在**同一个文件**里把它加进了 `scripts`。按「出现这个名字的
 * 文件集合有没有新增」算，两边都是 `{package.json}`，差集为空 —— 于是结论变成「目标分支
 * 上也找不到，合进来也不会让它出现」，而它明明就在那儿。
 *
 * 所以存在性只认**定义级**的判据（`package.json` 的 scripts、或那个文件本身在不在树里）；
 * 文字命中降格成线索，它的**空结果什么都不证明**。
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
   * `how` 决定**措辞敢说多硬**，三档的确定性依次递减：
   *  - `definition` 读出了目标分支上那份 manifest 并确认它定义了这个名字 —— 定义级事实；
   *  - `path` 那个名字就是个文件路径，而这个文件只有目标分支上有 —— 文件级事实；
   *  - `text` 只是这个名字在那份文件里整词出现过。**它不等于定义在这儿**，措辞里必须说破。
   */
  holders: { file: string; how: "definition" | "path" | "text"; commit: string; date: string; subject: string }[];
  /**
   * 目标分支上**确实没有**，而且是定义级/文件级核出来的。文字检索的空结果**不许**写进
   * 这里（审查 F2）—— 只有这个字段非空，才敢说「合目标分支进来也不会让它出现」。
   */
  absent: "definition" | "path" | null;
  /**
   * 它在开工基线上是有的、在任务这份快照里没了 —— 也就是**这次改动自己把它弄没的**。
   *
   * 为什么非查这一条（审查 F1 末条）：「入口确实缺失」推不出「跟本次改动无关」。删掉或
   * 改名了验收脚本，门禁一样报「命令不在树里」，而那时正确的出路恰恰是去改代码。
   */
  removedByTask: boolean | null;
  /** 名字抽不出来、或核对没做完（读不出 / 超预算）：那时只有 behind 这一条算数。 */
  unverified: boolean;
};

const short = (commit: string) => commit.slice(0, 8);
const day = (iso: string) => iso.slice(0, 16).replace("T", " ");

/**
 * 写给人和 agent 的那段结论。**纯文本不带 markdown**（审查一 N4；回归里有一条断言扫
 * 整段有没有 `**` 和反引号，加措辞时别带）：它的四个去处里有三个
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
  if (miss.kind === "inner") return innerLines(miss, subject, ran).join("\n");
  // entry：起跑前核过、它解析不出来。这是唯一敢说「一行都没跑到」的一档。
  const lines = [
    `这条命令点名要跑的 ${subject} 在被测快照里解析不出来：它要测的东西一行都没跑到，这不是断言失败。`,
    `判据：${miss.evidence}${ran}。`,
  ];
  // 但「没启动」推不出「不是你改的」（审查 F1）：先核一眼是不是这次改动把它弄没的。
  if (origin?.removedByTask === true) {
    lines.push(
      `注意：它在任务分支的开工基线上是有的，是开工之后在任务这边没了 —— 看起来就是这次改动`
        + `删掉或改名了它。${origin.behind ? `（任务分支另外落后 ${origin.targetBranch} ${origin.behind} 个提交。）` : ""}`,
      `出路：先核一眼这次改动是不是动了这个名字；是的话改回来或同步改项目设置里那条命令，这是要改代码的一种。`,
      `如果核下来跟这次改动无关，再按「把目标分支合进来」或「这次显式跳过门禁」处理 —— 后两条是用户的决定。`,
    );
    return lines.join("\n");
  }
  lines.push(...originLines(origin, subject));
  return lines.join("\n");
}

/**
 * inner 这一档能说的话。
 *
 * **命令整体有没有跑起来，只许照起跑前那份事实说**（审查 F1）：
 *  - 核过、入口在树里 → 它确实跑起来了，可以直说；
 *  - 同名但没核到     → 这正是上一轮判错的形状，必须明说「不敢断定它跑没跑起来」；
 *  - 什么都没核到     → 连启动都不提，只报那条观察。
 * 三种都不改写 failure、不给出路保证、不说「不用修」。
 */
function innerLines(miss: GateLaunchMiss, subject: string, ran: string): string[] {
  const tail = `这可能是环境缺件（依赖没装、机器上没这个程序），也可能是这次改动把名字写错了 —— `
    + `两种都要核一遍才知道，不能当成「不用修」。`;
  if (miss.entryResolved === true) {
    return [
      `这条命令点名要跑的东西起跑前核过、在这份快照里是有的，所以它确实跑起来了；红的原因是中途点名的 ${subject} 没解析出来，不像是断言失败。`,
      `判据：${miss.evidence}${ran}。`,
      tail,
    ];
  }
  if (miss.sameName) {
    return [
      `日志里说 ${subject} 没解析出来，而这条命令点名要跑的也叫这个名字 —— 但这两件事可能不是一回事：`
        + `runner 能起子 runner，子项目里缺一个同名脚本，日志跟顶层缺失长得一模一样。`,
      `判据：${miss.evidence}${ran}。`,
      `这条命令起跑前没能核实（它不是我解析得了的那几种形状），所以这一层不敢断定它有没有跑起来。${tail}`,
    ];
  }
  return [
    `这一次红的原因看起来是有东西没解析出来（${subject}），不像是断言失败；但这条命令整体有没有跑起来，这一层核不出来。`,
    `判据：${miss.evidence}${ran}。`,
    tail,
  ];
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
    const byDefinition = origin.holders.filter(holder => holder.how === "definition");
    const byPath = origin.holders.filter(holder => holder.how === "path");
    const byText = origin.holders.filter(holder => holder.how === "text");
    const facts = [
      byDefinition.length ? `${origin.targetBranch} 上 ${subject} 是有定义的（读出那份 manifest 核过），这份快照里没有：${byDefinition.map(where).join("；")}。` : "",
      byPath.length ? `${subject} 这个文件只有目标分支上有、这份快照里没有：${byPath.map(where).join("；")}。` : "",
      byText.length ? `${subject} 在 ${origin.targetBranch} 上整词出现在这些文件里、而这份快照里没有：${byText.map(where).join("；")}。`
        + `这是文字命中，不等于它就是那条命令的定义，但这些提交确实都不在被测快照里。` : "",
    ].filter(Boolean).join("");
    return [
      `${facts}${behind}`,
      `出路：`,
      `1. 把 ${origin.targetBranch} 合进任务分支（或以它为基线重建任务分支），再点验收 —— `
        + (byText.length
          ? `如果上面那个落点就是它的定义，那时这条命令就在树里了；合完仍然报同样的错，说明定义不在那儿，按下面第 2 条或核对项目设置里这条命令。`
          : `那时它就在树里了。`),
      `2. ${skip}`,
      mine,
    ];
  }
  // ② 核实了：目标分支上也没有。合分支解决不了 —— 这一档**绝不能**给合入建议。
  //    判据只认 `absent`（定义级/文件级）。文字检索查空不算（审查 F2）。
  if (origin?.absent) {
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
