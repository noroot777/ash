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
// **而「起跑前核过它解析不出来」一件事也不够**（第 8 轮审查 F1 实测）。那一层现在是纯读的
// （读文件系统、读一份 manifest 的文本，见 accept-gate-entry.ts），读出来的东西有两种错法：
//   · **落点可能不是真要跑的那份**：`.npmrc` / 环境变量 / 自带 npm 包装器都能把 runner 指到
//     别处（第 5、6、7 轮的三条反例）；
//   · **状态可能在真跑那一刻才变**：审查那条反例给命令带了 `NODE_OPTIONS='--require
//     ./preload.cjs'`，preload 只在 argv 里有 `test:accept` 时才生成那个脚本 —— 读的时候没有，
//     真跑时有、跑了、报了断言失败。
// 第 6、7 轮试过「起跑时问 npm 自己」（甚至插进同一次执行里问），第 8 轮判死：查询答的仍是
// **查询那一次**的状态，而且替用户多跑了两次项目代码（F2）。
//
// 所以「测试一行都没跑到 + 不用你改代码」这副面孔，现在要**三件事同时成立**才给，另两件都
// 来自**真跑那一次自己的输出**：
//   ① 起跑前核过：那个名字在它该在的地方没有（必要条件，不是充分条件）；
//   ② **runner 自己说了**它解析不出这个名字，且那个名字就是命令点名的那个（路径那一档可以
//      由 127/126 顶上，那是 POSIX 的约定）—— 它要是解析到了别的东西，就不会这么说；
//   ③ 这次日志里**除了门禁自己的记事和那家 runner 自己的报错，没有别的程序写过东西** ——
//      任何被测程序一跑起来就会在这儿留下痕迹（npm 非 silent 时还会先回显 `> 包名@版本
//      脚本名`）。这是「一行都没跑到」仅有的直接证据。
// 三件缺一件就只报观察、不改 failure、不免修（`withheld` 记的就是缺了哪一件）。残余的那个
// 口子写在 `foreignOutputIn` 的注释里。
//
// 所以三档：
//   · `entry`：上面三件事同时成立。**唯一会改写 failure、唯一敢说「这不是断言失败」。**
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
import { gateEntryAsk, type GateEntryProbe } from "./accept-gate-entry.js";

/** 认出来的是哪一种，以及凭什么。两档的语义差别见文件头。 */
export type MissKind = "entry" | "inner";

/** 三件必要条件里缺的是哪一件（见文件头）。 */
export type MissWithheld = "foreign-output" | "no-runner-claim" | "unreadable";

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
  /**
   * 起跑前核到「它不在」，但**另两件必要条件**没齐（见文件头），所以没给那副面孔。记下缺的
   * 是哪一件，措辞照它说 —— 这是用户唯一能据以自己去看一眼的线索。
   */
  withheld?: MissWithheld;
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

/** 门禁自己写进日志的那些行（`[ash] …`）—— 它不算「别的程序的输出」。 */
const ASH_NOTE = /^\[ash\]/;

/**
 * 一家 runner / shell **报错时自己那几行**长什么样。
 *
 * 只给这台机器上实测过的两家。别家没有定义 = 这一道**核不出来**（返回 null），不是「没有
 * 别人的输出」—— 外推错了要发出去的是「测试一行都没跑、不要改代码」。
 */
const RUNNER_SELF_OUTPUT: Record<string, RegExp> = {
  npm: /^npm(?:\s|$)/,
  shell: /^[^\s:]*(?:sh|bash|ksh|dash)(?:\[\d+\])?:/,
  zsh: /^zsh(?::\d+)?:/,
};

/**
 * 这次日志里有没有**别的程序**写过东西。`null` = 核不出来（日志被截断，或者认领这个名字的
 * 那家 runner 的输出形状这台机器上没实测过 —— 没实测过就不敢替它豁免任何一行）。
 *
 * `false` 是「被测的东西一行都没跑到」仅有的直接证据（第 8 轮审查 F1）：npm 一旦真去跑某个
 * 脚本，非 `--silent` 时会先把 `> 包名@版本 脚本名` 和脚本原文回显到 stdout，被测程序自己的
 * 输出也落在同一份日志里；缺脚本那一次的日志里只有 `npm error …`。
 *
 * **残余的口子**（知情保留）：一个完全静默、什么都不打印的被测程序，配上 `--silent`，仍然
 * 能让这一道通过。那时还有①②两道挡着（runner 得真说过它解析不出这个名字），三道同时被骗
 * 需要「配置把落点改到别处 + 那边有同名脚本 + 它内部又调一个缺同名的 + 全程静默」。再往下
 * 收就只能去执行点什么来观察，而那条路（多跑用户代码换一个答案）第 8 轮审查 F2 已经判死。
 */
export function foreignOutputIn(log: string, runner: string | null): boolean | null {
  const lines = log.split("\n").map(line => line.trim())
    .filter(line => line.length > 0 && !ASH_NOTE.test(line));
  if (!lines.length) return false;
  // 谁都没认领过这个名字解析不出来（runner=null）：那就没有哪一行可以拿「这是 runner 自己的
  // 报错」豁免 —— 剩下的每一行都是别的程序写的。这时真有东西跑过，比「核不出来」硬得多，
  // 也是更该告诉用户的那句（`.npmrc` 把落点改到子项目那一组对照就落在这里）。
  if (!runner) return true;
  const self = RUNNER_SELF_OUTPUT[runner];
  if (!self) return null;  // 认领了，可这家 runner 的输出形状这台机器上没实测过
  return !lines.every(line => self.test(line));
}

/**
 * 这条命令自己把 runner 的嘴堵上了没有。命中就返回那个开关，写进措辞。
 *
 * 为什么要专门认它（第 8 轮审查 F1 之后的实测）：`npm run --silent nosuch` **一个字都不打印**
 * （本机 npm 11.17.0），于是第二件必要条件（runner 自己说它解析不出这个名字）永远拿不到 ——
 * 这一层只能降级成观察。那时最有用的一句话不是「核不出来」，而是**去掉它再跑一次**：那样
 * runner 会自己说清它找不到哪个脚本，三件事就齐了。
 */
export function outputSilenced(command: string): string | null {
  return ["--silent", "--quiet", "--loglevel=silent", "--loglevel silent", " -s "]
    .find(flag => ` ${command} `.includes(` ${flag.trim()} `) || command.includes(flag)) ?? null;
}

/** 认措辞只在日志**开头**这一段里找：后面那些是跑起来之后的事（见 ANCHOR_LINES 同款判据）。 */
const PATTERN_HEAD_CHARS = 16_000;

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
 * `log` 要给**这一次日志的全文**（上限内），`logComplete` 说它是不是完整的 —— 第三件必要
 * 条件（日志里没有别的程序写过东西）得看完整份，截断了就核不出来。认措辞仍只在开头那一段
 * 里找（`PATTERN_HEAD_CHARS`）。
 *
 * `entry` 是**起跑前**核到的那份事实（accept-gate-entry.ts）；没有它，这个函数**绝不会**
 * 返回 `entry` 档。三件必要条件和它们各自挡住的反例见文件头，别再放宽到一件。
 */
export function classifyGateLaunch(opts: { command: string; exitCode: number | null; log: string;
  logComplete?: boolean; entry?: GateEntryProbe | null }): GateLaunchMiss | null {
  const entry = opts.entry ?? null;
  const entryResolved = entry ? entry.resolved : null;
  const hit = firstPatternHit(opts.log.slice(0, PATTERN_HEAD_CHARS));
  // ① 三件事同时成立才给那副面孔（见文件头）。
  if (entry && !entry.resolved) {
    // ② runner 自己说了它解析不出这个名字，而且就是命令点名的那个名字。
    const claimed = hit && hit.name === entry.ask ? hit : null;
    // 路径那一档可以由退出码顶上②：127/126 是「shell 找不到要执行的东西」的 POSIX 约定。
    // 「已经跑起来的脚本最后一步也会这么退」那条反例（第 1 轮审查 N1）由③挡住。
    const shellSaid = gateEntryAsk(opts.command)?.kind === "path"
      && (opts.exitCode === 127 || opts.exitCode === 126);
    // ③ 这次日志里除了它自己的报错，没有别的程序写过东西。
    const foreign = opts.logComplete === true
      ? foreignOutputIn(opts.log, claimed?.runner ?? (shellSaid ? "shell" : null))
      : null;
    if ((claimed || shellSaid) && foreign === false) {
      const said = claimed ? claimed.text
        : `退出码 ${opts.exitCode}（POSIX shell：${opts.exitCode === 127 ? "有东西没找到" : "找到了但不可执行"}）`;
      return { kind: "entry", name: entry.ask, by: entry.by, entryResolved: false,
        evidence: `${said}；起跑前核过 ${entry.by}：没有 ${entry.ask}；`
          + "这一次的日志里除了它自己的报错，没有别的程序写过东西" };
    }
    // 缺一件就只报观察：如实说核到了什么、哪一件没过，**不**改写 failure，也不免修。
    return { kind: "inner", name: entry.ask, by: entry.by, entryResolved: false,
      sameName: !!claimed,
      withheld: foreign === true ? "foreign-output" : foreign === null ? "unreadable" : "no-runner-claim",
      evidence: `${claimed ? `${claimed.text}；` : ""}起跑前核过 ${entry.by}：没有 ${entry.ask}` };
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
   *
   * `commit` 可以是 null：存在性核实了、但「哪次提交带进来的」追不出来时，**只丢时间、不丢
   * 存在性**（第 3 轮审查 F3 末段：旧版本没有时间就整段退成「没能核对出来」）。
   */
  holders: { file: string; how: "definition" | "path" | "text";
    commit: string | null; date: string | null; subject: string | null }[];
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
  /**
   * 这个定义**是不是目标分支新加的**（共同祖先上没有）。`null` = 没核出来。
   *
   * 它只是两份内容事实，**推不出合并结果**（第 7、8 轮审查 F3）：
   *  - `false`（共同祖先上就有、任务这一侧弄没的）：合并一般会保留这个删除，所以绝不许说
   *    「合进来就有」；
   *  - `true`（目标新加）：**也不许**说「合进来它就在树里了」—— 第 8 轮实测一个合法的
   *    `.gitattributes` 自定义合并驱动让 `git merge` 退 0、不冲突，却保留了任务侧那份
   *    manifest，合完照旧缺这条命令。合并策略/驱动/多共同祖先/冲突都能改掉结果。
   * 所以这一档的措辞只能是「它是目标分支新加的，合完先核一眼它在不在树里，再点验收」。
   */
  targetAddedIt: boolean | null;
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
  if (miss.kind === "inner") return innerLines(miss, subject, ran, opts.command).join("\n");
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
  // 归因未知也要说破（第 3 轮审查 F2）：「没证明是这次删的」不等于「证明不是这次删的」。
  // 免修那副面孔由 attribution 决定（accept-gate-messages.ts），这里负责把话说清楚。
  if (!origin || origin.removedByTask === null) {
    lines.push(`这是不是这次改动把它弄没的（删掉、改名、或者改了项目设置里那条命令），ash 这次判不出来 —— `
      + `先核一眼这件事：是的话就去改代码，不是的话再看下面。`);
  }
  lines.push(...originLines(origin, subject));
  return lines.join("\n");
}

/**
 * inner 这一档能说的话。
 *
 * **三种都不敢断定命令整体跑起来了**（第 3 轮审查 F1 反方向实测：一个存在但没有执行权限的
 * 脚本退 126，正文一行没跑 —— 所以「它在树里」证明不了「它跑起来了」）。能说的只是：
 *  - 核过、入口在树里 → 至少不是「不在树里」那一种；
 *  - 同名但没核到     → 必须明说两件事可能不是一回事；
 *  - 什么都没核到     → 连启动都不提，只报那条观察。
 * 三种都不改写 failure、不给出路保证、不说「不用修」。
 */
function innerLines(miss: GateLaunchMiss, subject: string, ran: string, command: string): string[] {
  const tail = `这可能是环境缺件（依赖没装、机器上没这个程序），也可能是这次改动把名字写错了 —— `
    + `两种都要核一遍才知道，不能当成「不用修」。`;
  if (miss.entryResolved === true) {
    return [
      `这条命令点名要跑的东西起跑前核过、在这份快照里是有的，所以不是「它不在树里」那一种；`
        + `红的原因看起来是 ${subject} 没解析出来，不像是断言失败。`,
      `判据：${miss.evidence}${ran}。`,
      `它到底跑进去多少，这一层说不了（在树里不等于跑起来了：权限、解释器都可能挡在前面）。${tail}`,
    ];
  }
  // 起跑前读到「它不在」，但另两件必要条件没齐（第 8 轮审查 F1）。说清缺的是哪一件 ——
  // 那是用户唯一能据以自己去看一眼的线索。
  if (miss.withheld) {
    const why = miss.withheld === "foreign-output"
      ? "可是这一次的日志里有别的程序写过东西 —— 有东西真的跑了，所以「它一行都没跑到」这句话不成立"
      : miss.withheld === "unreadable"
        ? "可是这一次的日志核不出来是谁写的（太大被截断了，或者那家 runner 的输出形状这台机器上没实测过）"
        : "可是 runner 自己并没说它解析不出这个名字 —— 那它很可能解析到了别的东西：配置能把 runner 指到另一份 manifest，命令也能在跑的过程中把这个脚本生成出来";
    // 嘴被命令自己堵上时，最有用的一句是「去掉它再跑一次」—— 那样 runner 会自己说清。
    const silenced = miss.withheld === "no-runner-claim" ? outputSilenced(command) : null;
    return [
      `起跑前在 ${miss.by} 里没找到 ${subject}，${why}。`,
      `判据：${miss.evidence}${ran}。`,
      `所以这一层不敢说它没启动，更不敢说这条红不用你修。`
        + (silenced ? `想拿到确切结论：把这条命令里的「${silenced.trim()}」去掉再点一次验收 —— 它把 runner 的报错一起吞了（实测带上它连「找不到哪个脚本」都不打印）。` : "")
        + tail,
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
    // 时间追不出来就只报文件：**存在性已经核实了**，不许因为缺个时间把它一起丢掉（F3）。
    // 定义级/文件级那两档的提交是**核过 absent→present 这个转换**的（第 7 轮审查 F4：只核
    // 「那次提交上有」会把一次只改说明文字的提交报成引入提交）。但核的范围是目标分支独有的
    // 那段历史，所以措辞是「加进去的」而不是「最早」。文字档走的是 `-S`（这串字的出现次数
    // 最早变化），那一档本来就只是线索。
    const where = (holder: GateMissOrigin["holders"][number]) => holder.commit
      ? `${holder.file}（${holder.how === "path" ? "把它加进来的" : holder.how === "definition"
        ? "把这个定义加进去的" : "这串字最早出现在"}是 `
        + `${short(holder.commit)}${holder.date ? `，${day(holder.date)}` : ""}${holder.subject ? `，${holder.subject}` : ""}）`
      : `${holder.file}（哪次提交带进来的，这次没追出来）`;
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
    // 出路只许说核过的那两件事（目标上有、落后多少），**不许预测合并结果**（第 7、8 轮
    // 审查 F3）：源侧删除会被合并保留，自定义合并驱动连「目标新加」也能挡掉 —— 实测
    // `git merge` 退 0、不冲突，合完那条命令照旧不在树里。所以每一档都带上「合完先核一眼」。
    const check = `合完先核一眼这条命令在不在树里（合并策略、仓库自己配的合并驱动、冲突都可能让它没进来），再点验收。`;
    const merge = origin.targetAddedIt === false
      ? [`出路：`,
        `1. 它在两边的共同祖先上就有，是任务这一侧把它弄没的 —— 合 ${origin.targetBranch} 进来一般保留这个删除，`
          + `所以更直接的办法是把那个定义取回来（从 ${origin.targetBranch} 上把那份文件或那条定义改回来）再点验收。`,
        `2. ${skip}`]
      : [`出路：`,
        `1. 把 ${origin.targetBranch} 合进任务分支（或以它为基线重建任务分支）—— `
          + (origin.targetAddedIt === true
            ? `它是 ${origin.targetBranch} 上新加的（共同祖先上没有）。`
            : byText.length
              ? `如果上面那个落点就是它的定义，合进来这条命令就该在树里了；仍然报同样的错说明定义不在那儿，按下面第 2 条或核对项目设置里这条命令。`
              : `这次没核出它是目标分支新加的、还是任务这一侧删掉的 —— 是后者的话合并保留那个删除，得把那个定义取回来。`)
          + check,
        `2. ${skip}`];
    return [`${facts}${behind}`, ...merge, mine];
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
