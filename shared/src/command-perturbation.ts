// **「默认执行环境」这个前提还成立吗** —— 硬拦判据的最后一道（见 command-never-exits.ts
// 文件头 ⑪⑫）。从那个文件拆出来（全局约定:单文件不超过 700 行），接口只有 `perturbed` 一个:
// 读不懂这条命令的执行语义 ⇒ 整条证明失效 ⇒ 降级成提示。
//
// 为什么单独成层:硬拦的证明压着一个说不出口的前提 —— shell 按常规语义执行每一段、工具找得到、
// 没人把这个进程结束掉。那个前提**不是待证项**,它是哨兵这个功能本身的运行假设（否则磁盘满、
// 外部信号、ulimit 都能让任何命令退出，闸直接归零）。可**命令自己就能把这个假设掀翻**，而那
// 几种写法全都写在 argv 里、这一层本来就看得见。
import { type Segment, type Token } from "./command-lex.ts";
import { BRANCH, LOOP_HEADS, SKELETON, headOf } from "./command-scan.ts";
import { commandOf } from "./command-wrappers.ts";

/**
 * **shell 自己的词**(内建命令)。这一道判据按「这个空间之内的白名单」走,理由是空间封闭:
 * 能改掉「后面那几段按什么规矩执行」的东西只有 shell 自己的词 —— 外部程序改不动调用它的那个
 * shell 的执行语义,它唯一能做的是**结束这个进程**，而「没人把这个进程结束掉」正是上面那条
 * 不作待证项的背景前提（`kill` 仍单独记在 `NOTES` 里:它是把那件事写进 argv 的那一种）。
 *
 * 所以这张表不需要穷举「哪些词危险」,只需要穷举「shell 有哪些自己的词」—— 后者是封闭的、
 * 查得到的,前者永远差下一个。
 *
 * **这替掉了原先那张「我见过的会掀翻前提的词」表**（eval/source/trap/kill/ulimit/shopt/
 * setopt）。那是列反例,于是同一族的下一个照旧硬拦 —— 本轮实测两条(`sh -lc`,都退出 0 并打出
 * DONE,却都吃 409):
 *   · `unset PATH; tail -F /dev/null; printf 'DONE\n'` —— `unset` 把 PATH 整个去掉,
 *     那个 tail 压根没启动（`sh: tail: No such file or directory`）。赋值那一侧早就认了
 *     (`PATH_ASSIGN`)，取消那一侧没人认。
 *   · `hash -p /usr/bin/true tail; tail -F /dev/null; printf 'DONE\n'` —— `hash -p` 把
 *     `tail` 这个名字钉到另一个可执行文件上,跑的根本不是 tail。
 * 再补两条进黑名单的话，`builtin`/`enable`/`let`/`local`/`alias` 还排着队。
 *
 * 表里收的是 sh(dash)/bash/zsh/ksh 的内建词并集。**宁可多收**:多收一个 ⇒ 那条命令从硬拦
 * 降成提示（人照样提交得了），少收一个 ⇒ 一件做得成的事做不成（见那边文件头的不对称那段）。
 */
const SHELL_WORDS = new Set([
  // POSIX 特殊内建
  "break", ":", "continue", ".", "eval", "exec", "exit", "export", "readonly", "return",
  "set", "shift", "times", "trap", "unset",
  // POSIX 常规内建
  "alias", "bg", "cd", "command", "false", "fc", "fg", "getopts", "hash", "jobs", "kill",
  "newgrp", "pwd", "read", "true", "umask", "unalias", "wait",
  // bash
  "bind", "builtin", "caller", "compgen", "complete", "compopt", "declare", "dirs", "disown",
  "echo", "enable", "help", "history", "let", "local", "logout", "mapfile", "popd", "printf",
  "pushd", "readarray", "shopt", "source", "suspend", "test", "[", "type", "typeset", "ulimit",
  // zsh / ksh
  "autoload", "bindkey", "compdef", "disable", "echotc", "emulate", "float", "functions",
  "getln", "integer", "limit", "log", "print", "rehash", "sched", "setopt", "stat", "ttyctl",
  "unfunction", "unhash", "unlimit", "unsetopt", "vared", "whence", "zcompile", "zle",
  "zmodload", "zparseopts", "zstyle", "redirect",
]);

/**
 * 这一层**确实有处置**的那几个 shell 词 —— 其余任何一个都算未知。
 *
 * 每一个的理由都得是「它的执行语义这一层已经算进去了」,不是「它看起来没害」:
 *  · `:`/`true`/`false`/`test`/`[` —— 只产出一个退出码,而退出码这一层有处置（`errexitAt`）;
 *  · `echo`/`printf` —— 只往流里写字;
 *  · `cd`/`pwd` —— 只动工作目录,而「它盯的那个东西在不在」整档已经移出硬拦（文件头 ⑩）;
 *  · `read`/`wait`/`shift`/`umask`/`times` —— 不改后面那几段怎么执行;
 *  · `export` —— 赋值,而唯一要紧的那个变量单独扫（`PATH_ASSIGN`,`export PATH=…` 同样命中）;
 *  · `break`/`continue`/`exit`/`return`/`exec` —— 形状那一层专门处置过（`JUMPS`/`TERMINATORS`/
 *    `ESCAPES`),这里再算一次只会把真阳性也降级;
 *  · `set` —— 有自己那道白名单（`setShaken`）。
 */
const HANDLED = new Set([
  ":", "true", "false", "test", "[", "echo", "printf", "cd", "pwd", "read", "wait",
  "shift", "umask", "times", "export", "break", "continue", "exit", "return", "exec", "set",
]);

/** 值得多说一句的那几个（其余走 `shellWordNote` 那句通用的）。 */
const NOTES = new Map<string, string>([
  ["eval", "那个 eval 跑的是一段这一层读不进去的代码"],
  ["source", "那个 source 把另一个文件的内容当代码跑"],
  [".", "那个 . 把另一个文件的内容当代码跑"],
  ["trap", "那个 trap 挂的是一段收到信号才跑的代码"],
  ["kill", "那个 kill 可以把这条命令自己结束掉"],
  ["ulimit", "那个 ulimit 改掉了这条命令自己的资源上限"],
  ["shopt", "那个 shopt 改掉了 shell 的执行选项"],
  ["setopt", "那个 setopt 改掉了 shell 的执行选项"],
  ["unset", "那个 unset 可以把 PATH 一类变量整个去掉，后面那些工具还找不找得到"],
  ["hash", "那个 hash 可以把一个命令名钉到别的可执行文件上"],
]);
const shellWordNote = (name: string): string =>
  `那个 ${name} 是 shell 自己的词，这一层没有它的处置 —— 它改不改得动后面每一条的执行语义，读不出来`;

/** 给 `PATH` 赋值 ⇒ 后面那些工具还找不找得到,这一层读不出来（`PATH=/missing; tail -F x` 实测 127）。 */
const PATH_ASSIGN = /^PATH=/;
/**
 * **自带退出语义的那种展开**:`${X:?msg}` / `${X?msg}` —— X 没定义时 shell **在这一处**就走人
 * （报告实测 `unset X; : "${X:?required}"; while true; do :; done` 立刻退出 127）。而「X 定义过
 * 没有」这一层答不出来,所以它出现在哪一段里都算读不懂。其余展开形式（`:-` 取默认、`:=` 赋值）
 * 没有退出语义,不在这一道里。
 */
const ERROR_EXPANSION = /\$\{[A-Za-z_][A-Za-z0-9_]*(?::)?\?/;
/**
 * **命令替换**:`$( … )` / 反引号 —— 括号里是**另一层这一层读不进去的执行**（词法层按设计把它
 * 整段抹掉,见 command-lex.ts）。跟 `eval` 同一回事:读得见不等于读得懂,所以同判。
 */
const SUBSTITUTION = /\$\(|`/;
/** 这个词里有没有展开(`$…`)或替换(反引号)—— 有就说明它的内容要等执行时才定下来。 */
const EXPANDS = /[$`]/;
/** 这一段开头那几个**结构骨架词**:要跳过它们才轮到真正的命令词（判据同 `provableBlocker`）。 */
const isSkeleton = (head: string): boolean =>
  SKELETON.has(head) || LOOP_HEADS.has(head) || BRANCH.has(head);

/**
 * `set` 的开关里**第一个这一层没有处置的** —— 全都有处置就是 `null`。
 *
 * **白名单,不是黑名单**:认得的那几个放过,其余一律算未知（同⑩在下游那一侧的口径）。反过来
 * 列「哪几个危险」就是列反例 —— `set -n`（读完一条都不执行，实测退出 0 而恒真循环照旧被 409）
 * 只是第一个被抓到的,`-C` 挡得住重定向、`-f` 改通配展开,一张黑名单永远差下一个。
 *
 * 放过的三件事各有理由:`errexit` 那边有专门的处置（`errexitAt`）;`xtrace`/`verbose` 只是把执行
 * 过程打出来,一个字的执行语义都不改。**`+` 那一侧同样放过** —— 它是关掉,而这三个本来就默认
 * 关着（`set +e; false; tail -F x` 真 shell 里照旧挂住，是选定要拦的真阳性）。
 *
 * **明知的误降级:`set -eu` 这一类**。`-u`（未定义变量当错误）只在命令里真的引用了未定义变量
 * 时才改变结局,而「有没有引用、引用的定义了没有」这一层答不出来 —— 于是 `set -eu; tail -F x`
 * 从硬拦降成提示。代价方向是对的那一侧:提示照样说得清,人照样能提交（见那边文件头的不对称）。
 * 想把它收回硬拦,得先拿出「这条命令里每个变量都定义过」的证明,而不是把 `-u` 塞进白名单。
 */
const SET_HANDLED = new Set(["errexit", "xtrace", "verbose"]);
const SET_SHORT = /^[-+][exv]+$/;
function setShaken(argv: readonly Token[]): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i]!;
    if (t.quoted) return t.text;                 // 引号里的开关这一层读不出来
    // 开关本身是个展开 ⇒ 它到底开的是什么要等执行时才知道（`set $VAR`，VAR=-n 就是 noexec）。
    if (EXPANDS.test(t.text)) return t.text;
    if (!/^[-+]/.test(t.text)) break;            // 开关列表到此为止（后面是位置参数）
    if (/^[-+]o$/.test(t.text)) {
      const name = argv[i + 1];
      if (name && !name.quoted && SET_HANDLED.has(name.text)) { i += 1; continue; }
      return name ? `${t.text} ${name.text}` : t.text;
    }
    if (!SET_SHORT.test(t.text)) return t.text;
  }
  return null;
}

/**
 * 这一段**要跑的那个命令词**:读出来了给 `cmd`，有词却读不出来给 `unreadable`，整段压根没有
 * 命令词给 `null`（见 `perturbed` 里那段说明）。
 *
 * 读不出来有三种,每一种都是「它到底是哪个命令」要等执行时才定下来:
 *  · 命令词在引号里（`"$action"`、`'tail'`）—— 词法层按设计不把引号里的字当执行节点;
 *  · 命令词里有展开或替换（`$action`、`$(which tail)`）;
 *  · 包装命令的开关这一层认不出来（`commandOf` 自己答不出来，见 command-wrappers.ts）。
 */
type CommandWord =
  | { cmd: { name: string; argv: Token[] }; unreadable?: undefined }
  | { cmd?: undefined; unreadable: string };
function commandWord(tokens: Token[], at: number): CommandWord | null {
  let i = at;
  // 赋值前缀（`FOO=1 cmd …`）不是命令词,跳过去找真正那个。
  while (i < tokens.length && !tokens[i]!.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!.text)) i += 1;
  const head = tokens[i];
  if (!head) return null;                        // 整段没有命令词 ⇒ 什么都不执行
  if (head.quoted) return { unreadable: "那一段要跑的命令词藏在引号里，这一层读不出它是哪个命令" };
  if (EXPANDS.test(head.text)) return { unreadable: "那一段要跑的命令词是个展开，它展开成哪个命令要等执行时才知道" };
  const cmd = commandOf(tokens, i);
  return cmd ? { cmd } : { unreadable: "那一段的包装命令这一层认不出来，剥不出真正要跑的是谁" };
}

/**
 * 整条命令里第一处「执行语义这一层读不懂」的地方 —— 没有就是 `null`。
 *
 * 问的不是「它会不会结束」,而是「我这一层还读得懂它的执行语义吗」。读不懂 ⇒ 硬拦的那条证明
 * 失效 ⇒ 降级成提示。
 *
 * **不管执行资格,每一段都看**:`if false; then eval x; fi` 里那个 `eval` 确实跑不到,可
 * 「跑不到」这个结论本身也是这一层算出来的 —— 真要分清就得先读懂 eval。偏放行那一侧 ⇒ 一律算。
 *
 * **只认命令词位置**（文件头 ①）:`find . -name x`、`grep kill log` 里那两个词是参数,不是
 * 执行节点。`PATH=` 是唯一一个按整段词扫的 —— 它作为赋值前缀时压根不在命令词位置上。
 */
export function perturbed(segs: Segment[]): string | null {
  for (const seg of segs) {
    for (const t of seg.tokens) {
      if (!t.quoted && PATH_ASSIGN.test(t.text)) return "前面有一段改过 PATH，后面那些工具还找不找得到";
      if (ERROR_EXPANSION.test(t.text)) return "那个 ${…?…} 展开在变量没定义时当场就让 shell 走人";
      if (SUBSTITUTION.test(t.text)) return "那段命令替换跑的是一段这一层读不进去的代码";
    }
    let at = 0;
    while (at < seg.tokens.length && isSkeleton(headOf(seg.tokens, at))) at += 1;
    // **「这一段的命令词是谁」答不出来 ⇒ 未知,不是「没什么可担心的」**。原先这里是 `continue`,
    // 于是 `action=break; while true; do "$action"; done; printf 'DONE\n'`（实测退出 0 并打出
    // DONE）照旧硬拦:那个命令词藏在引号里的展开后面,这一层压根没读出它是 `break`。
    //
    // 两种 null 要分开:**整段没有命令词**（只有赋值前缀、或空段）那里什么都不执行,如实算没有
    // 扰动（`action=break` 自己一个字都不跑）;**有词却读不出来**才是未知。
    const word = commandWord(seg.tokens, at);
    if (word === null) continue;
    if (word.unreadable !== undefined) return word.unreadable;
    const { cmd } = word;
    if (cmd.name === "set") {
      const flag = setShaken(cmd.argv);
      if (flag !== null) return `那个 set 开的是 ${flag}，它改掉了后面每一条的执行语义（这一层只认得 errexit）`;
      continue;
    }
    const note = NOTES.get(cmd.name);
    if (note) return note;
    // **空间内的白名单**:shell 自己的词里凡是这一层没有处置的,一律算读不懂（见 `SHELL_WORDS`）。
    if (SHELL_WORDS.has(cmd.name) && !HANDLED.has(cmd.name)) return shellWordNote(cmd.name);
  }
  return null;
}
