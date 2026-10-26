// 门禁红了，但**测试一行都没跑**：那条命令在任务那份快照里压根解析不出来。
//
// 为什么要单独认这一种（用户 2026-10-26）：`rc≠0` 把两件完全不同的事混成了一句
// 「未通过：命令退出码非 0」——
//   · 测试真跑了、红了   → 出路是 agent 去修代码；
//   · 命令根本没启动     → 代码跟这事毫无关系。项目后来才把这条命令加进去（脚本/
//     Makefile/package.json），而任务的开工基线早于那次提交，于是快照里没有它。
// 本机四次都是后者，而门禁只把 npm 的原始报错(`Missing script: "test:accept"` + rc=1)
// 扔出来：人和 agent 都读不出出路，于是每次都走成「执行者复跑两遍 → 停下来问用户」。
//
// 判据分两层，**没有一层依赖「这条命令是 npm」**（验收命令是任意 shell 字符串）：
//  ① 退出码 127/126 —— POSIX shell 对「找不到 / 不可执行」的标准约定，单独成立；
//  ② 日志措辞 —— 多数 runner 自己吞掉 127 改报 rc=1（npm 正是），只能认它们各自的
//     措辞。下表一行一个 runner，加一行就多认一种；npm 只是其中一行。
//
// **误判是安全的**：这一层只改「这条红叫什么、该怎么办」的措辞，不改「拦不拦」——
// command_missing 仍然是一次 failed 门禁，照样不合并、不清理。所以宁可认得宽一点，
// 也不要让人对着 npm 的原始报错猜。
import type { AcceptGateFailure } from "@ash/shared/accept-gate";

/**
 * 认出来的是哪一种「不存在」。
 *
 *  - `command` 这条命令**本体**没解析出来（runner 找不到这个 task/script，或 shell
 *    找不到这个可执行文件）。这就是要归类成 command_missing 的那一种。
 *  - `program` 命令跑起来了，但它中途要用的某个程序/模块不存在（典型是环境缺件）。
 *    出路不同（装依赖 / 换基线），所以**不**改写 failure，只在诊断里说一句。
 */
export type MissKind = "command" | "program";

export type GateLaunchMiss = {
  kind: MissKind;
  /** 缺的那个名字。只凭退出码认出来时为 null（日志里没有可抽的名字）。 */
  name: string | null;
  /** 判定依据的原文一行，写给人看。 */
  evidence: string;
  /** 认出它的是哪一条判据，只用于措辞。 */
  by: string;
};

type MissPattern = {
  /** 哪个 runner 的措辞。只进「判据」那句话，不参与判定。 */
  runner: string;
  re: RegExp;
  /**
   * 这条措辞**天然**就是在说「我找不到你让我跑的那个东西」（runner 报自己的 task
   * 名、PowerShell 报 CommandNotFoundException）。这类一命中就是 `command`。
   *
   * false = 它报的是某个程序/模块找不到，而那可能是命令本体、也可能是命令内部的一步。
   * 那时按「这个名字是不是命令里的一个词」区分（见 classifyGateLaunch）。
   */
  commandLevel: boolean;
};

const MISS_PATTERNS: MissPattern[] = [
  // ── 各家 task runner：自己吞掉 127、改报 rc=1，只能认措辞 ──
  // npm 9/10 是 `npm error Missing script: "x"`，npm 6/8 是 `npm ERR! missing script: x`。
  { runner: "npm", re: /^npm (?:error|ERR!)\s+[Mm]issing script:\s*"?([^"\r\n]+?)"?\s*$/m, commandLevel: true },
  { runner: "pnpm", re: /Missing script:\s*"?([^"\r\n]+?)"?\s*$/m, commandLevel: true },
  { runner: "yarn", re: /^error Command "([^"\r\n]+)" not found\.?\s*$/m, commandLevel: true },
  { runner: "yarn", re: /Couldn't find a script named "([^"\r\n]+)"/, commandLevel: true },
  { runner: "make", re: /^[^\s:]*make(?:\[\d+\])?: \*\*\* No rule to make target ['`"]([^'`"\r\n]+)['`"]/m, commandLevel: true },
  { runner: "just", re: /^error: Justfile does not contain recipe ['`"]([^'`"\r\n]+)['`"]/m, commandLevel: true },
  { runner: "cargo", re: /^error: no such command: ['`"]([^'`"\r\n]+)['`"]/m, commandLevel: true },
  { runner: "go", re: /^go[^\r\n]*: unknown (?:command|subcommand) "?([^"\r\n]+?)"?\s*$/m, commandLevel: true },
  { runner: "task", re: /^task: Task "([^"\r\n]+)" does not exist/m, commandLevel: true },
  { runner: "gradle", re: /^(?:FAILURE: )?.*Task '([^'\r\n]+)' not found in (?:root )?project/m, commandLevel: true },
  // ── Windows ──
  // PowerShell: `foo : The term 'foo' is not recognized as the name of a cmdlet, ...`
  { runner: "powershell", re: /The term ['"]([^'"\r\n]+)['"] is not recognized as the name of a cmdlet/, commandLevel: true },
  { runner: "powershell", re: /(CommandNotFoundException)/, commandLevel: true },
  { runner: "cmd", re: /^'([^'\r\n]+)' is not recognized as an internal or external command/m, commandLevel: true },
  // ── POSIX shell：三家措辞各不相同，三条都要认 ──
  // zsh: `zsh: command not found: foo`
  { runner: "zsh", re: /^zsh(?::\d+)?: command not found: ([^\r\n]+)$/m, commandLevel: false },
  // bash: `bash: line 1: foo: command not found`；dash/sh: `sh: 1: foo: not found`
  { runner: "shell", re: /^[^\s:]*(?:sh|bash|ksh|dash)(?:\[\d+\])?: (?:line \d+: |\d+: )?([^\r\n]+?): (?:command )?not found$/m, commandLevel: false },
  // `./kb.sh: No such file or directory` —— 脚本文件本身不在这份快照里
  { runner: "shell", re: /^[^\s:]*(?:sh|bash|ksh|dash|zsh)(?:\[\d+\])?: (?:line \d+: |\d+: )?([^\r\n]+?): No such file or directory$/m, commandLevel: false },
  // ── 命令里那一步要用的程序/模块 ──
  { runner: "python", re: /: No module named ([^\s\r\n]+)/, commandLevel: false },
  { runner: "node", re: /Cannot find module '([^'\r\n]+)'/, commandLevel: false },
];

/** 把一条 shell 命令拆成「词」，用来判断日志里那个名字说的是不是命令本体。 */
function commandWords(command: string): Set<string> {
  return new Set(command.split(/[\s;&|()<>`'"]+/).filter(Boolean));
}

/**
 * 判定前多少行算「命令还没来得及干活」。命令没启动时输出本来就只有几行（本机那四条
 * 都在第 8 行），而一份真跑起来的测试日志，开头几十行之后出现的 `Cannot find module`
 * 更可能是被测代码自己的输出 —— 那种不该被改写成「命令不存在」。
 */
const ANCHOR_LINES = 40;

function anchoredWithin(log: string, index: number): boolean {
  let lines = 0;
  for (let at = 0; at < index; at++) if (log.charCodeAt(at) === 10 && ++lines >= ANCHOR_LINES) return false;
  return true;
}

/**
 * 这一次红到底是「命令没启动」还是「测试红了」。认不出来返回 null（那就照旧）。
 *
 * `log` 要给**日志开头**那一段（不是尾巴）：这一层问的是「命令有没有来得及干活」，
 * 而那件事只在开头看得出来。命令没启动时整份日志也就那么几行，头就是全文。
 *
 * 一条措辞命中还不够，必须同时能把它**挂到这条命令上**，二者有一即可：
 *   · 它报的那个名字是命令里的一个词（`npm run test:accept` ↔ `test:accept`）；
 *   · 它出现在命令自己输出的头几十行里（还没来得及跑任何东西）。
 * 两条都不成立 = 这段文字更可能是被测代码自己打出来的，不改写。
 */
export function classifyGateLaunch(opts: { command: string; exitCode: number | null; log: string }): GateLaunchMiss | null {
  const words = commandWords(opts.command);
  for (const pattern of MISS_PATTERNS) {
    const match = pattern.re.exec(opts.log);
    if (!match) continue;
    const captured = (match[1] ?? "").trim();
    // 没有名字可抽的那一条（CommandNotFoundException）捕获到的是异常名本身，不当名字用。
    const name = captured && captured !== "CommandNotFoundException" ? captured : null;
    const named = name !== null && words.has(name);
    if (!named && !anchoredWithin(opts.log, match.index)) continue;
    return { kind: pattern.commandLevel || named ? "command" : "program",
      name, evidence: match[0].trim(), by: pattern.runner };
  }
  // 没有哪条措辞命中，但 shell 已经用退出码说了：127 = 找不到，126 = 找到了但不能执行。
  if (opts.exitCode === 127 || opts.exitCode === 126) {
    return { kind: "command", name: null, by: "exit-code",
      evidence: opts.exitCode === 127 ? "退出码 127（POSIX shell：命令未找到）" : "退出码 126（POSIX shell：命令存在但不可执行）" };
  }
  return null;
}

/** 认出 `command` 这一档时该落的 failure；其余一律不改写。 */
export function missFailure(miss: GateLaunchMiss | null): AcceptGateFailure | null {
  return miss?.kind === "command" ? "command_missing" : null;
}

/** 门禁给出的 git 事实：这个名字在目标分支上是什么情形。 */
export type GateMissOrigin = {
  targetBranch: string;
  /** 目标分支现在的 HEAD（读不出为 null）。 */
  targetCommit: string | null;
  /** 任务这份快照落后目标分支几个提交（算不出为 null）。 */
  behind: number | null;
  /**
   * 目标分支上含这个名字、而快照里不含的文件，以及**在目标分支上**最早把它写进那个
   * 文件的那次提交。空数组 = 目标分支上也找不到新的落点（那就不是「落后了」这么简单）。
   */
  holders: { file: string; commit: string; date: string; subject: string }[];
  /** 名字没抽出来、或仓库读不出来时为 true：只能给「落后几个提交」这一条事实。 */
  partial: boolean;
};

const short = (commit: string) => commit.slice(0, 8);
const day = (iso: string) => iso.slice(0, 16).replace("T", " ");

/**
 * 写给人和 agent 的那段结论。三件事按需求定的顺序：**没启动** → **目标分支上的情形**
 * → **出路**。出路只摆出来，一条都不替用户做（合目标分支与跳过门禁都是他的决定）。
 */
export function gateCommandMissNotice(opts: {
  command: string;
  miss: GateLaunchMiss;
  sourceCommit: string | null;
  origin: GateMissOrigin | null;
}): string {
  const { miss, origin } = opts;
  const subject = miss.name ? `\`${miss.name}\`` : "这条命令";
  const lines: string[] = [];
  if (miss.kind === "command") {
    lines.push(`**这条命令在被测快照里不存在，所以测试一行都没跑 —— 不是代码红了。**`);
    lines.push(`判据：${miss.evidence}（这一次跑的是 \`${opts.command}\`${
      opts.sourceCommit ? `，被测快照 ${short(opts.sourceCommit)}` : ""}）。`);
  } else {
    lines.push(`**命令启动了，但它中途要用的 ${subject} 在这份快照里找不到 —— 这更像环境缺件，不是断言失败。**`);
    lines.push(`判据：${miss.evidence}（这一次跑的是 \`${opts.command}\`）。`);
  }
  lines.push(originSentence(origin, subject));
  lines.push(`出路有两条，**都要你自己定**（ash 不会替你合分支，也不会替你跳过门禁）：`);
  lines.push(`1. 把${origin ? ` ${origin.targetBranch} ` : "目标分支"}合进任务分支（或以它为基线重建任务分支），再点验收 —— 那时这条命令就在树里了；`);
  lines.push(`2. 在验收确认框里明确选「这次跳过前置命令」，直接合并 —— 那就是**没有任何测试凭据**地合，记录里会如实这么写。`);
  return lines.join("\n");
}

function originSentence(origin: GateMissOrigin | null, subject: string): string {
  if (!origin) return "目标分支上的情形这次没能核对出来（仓库或分支读不出来），所以只能确定「这份快照里没有它」这一件事。";
  const behind = origin.behind === null ? "" : origin.behind > 0
    ? `任务分支现在落后 ${origin.targetBranch} ${origin.behind} 个提交。`
    : `任务分支并不落后于 ${origin.targetBranch}。`;
  if (!origin.holders.length) {
    return `${behind}${origin.targetBranch}${origin.targetCommit ? `（${short(origin.targetCommit)}）` : ""} 上也找不到 ${subject} 的新落点`
      + ` —— 它不是「任务分支落后了」这么简单，这条命令可能从来没进过仓库（比如只写在某个人的本地脚本里），请核对项目设置里这条命令本身。`;
  }
  const holders = origin.holders
    .map(holder => `\`${holder.file}\` ← ${short(holder.commit)}（${day(holder.date)}）${holder.subject}`)
    .join("；");
  return `${subject} 在 ${origin.targetBranch} 上有、在这份快照里没有，落点是：${holders}。这些提交都不在被测快照里。${behind ? ` ${behind}` : ""}`;
}
