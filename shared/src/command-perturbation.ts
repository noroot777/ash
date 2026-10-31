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
 *  · `wait`/`shift`/`umask`/`times` —— 不改后面那几段怎么执行;
 *  · `read`/`printf` —— **要看参数**才算得清,见 `ARGV_PROOF`;
 *  · `export` —— 赋值,而唯一要紧的那个变量单独扫（`PATH_ASSIGN`,`export PATH=…` 同样命中）;
 *  · `break`/`continue`/`exit`/`return`/`exec` —— 形状那一层专门处置过（`JUMPS`/`TERMINATORS`/
 *    `ESCAPES`),这里再算一次只会把真阳性也降级;
 *  · `set` —— 有自己那道白名单（`setShaken`）。
 *
 * **在这张表里不等于整词放行**（第 4 轮审查 F3）:`HANDLED` 答的是「这个词的执行语义这一层有
 * 处置」,而有几个词的语义**压在参数上** —— 实测 `read PATH; tail -F /dev/null; printf 'DONE\n'`
 * 退出 0 并打出 DONE（`sh: tail: No such file or directory`）却照旧吃 409:`read PATH` 把 PATH
 * 读成了空,后面那个 tail 压根没启动。所以进了这张表还要再过 `ARGV_PROOF`。
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
// 收尾那半句由调用方接（「它会不会让这条命令提前结束，这一层读不出来」），所以这儿**不要**
// 自己再写一遍「读不出来」—— 两句接起来会结巴。
const shellWordNote = (name: string): string =>
  `那个 ${name} 是 shell 自己的词，这一层没有它的处置 —— 它改不改得动后面每一条的执行语义`;

/** 给 `PATH` 赋值 ⇒ 后面那些工具还找不找得到,这一层读不出来（`PATH=/missing; tail -F x` 实测 127）。 */
const PATH_ASSIGN = /^PATH=/;
/**
 * 这一道**不自己扫文本了,只读词法层打在词上的标记**（第 4 轮审查 F3）。
 *
 * 上一版三条判据（`${…?…}`、`$( )`、`$…`）全是拿正则去扫 `Token.text`,而词法层**按设计**把
 * 不带引号的展开抹成了占位符 `?`、还把 `${` 当成分段符 —— 于是这三条正则只对**带引号**的那一半
 * 有效。我自己那三条 `${…:?…}` 回归恰好全写成了 `"${X:?required}"`（引号里的内容原样留在
 * `text` 里）,所以它们一直是绿的,而审查实测不带引号的同一件事照旧吃 409。
 *
 * 结论跟 D1 是同一条:**未知要向上传播,不能让中间某一层把它抹平**。标记的定义见
 * command-lex.ts 的 `Token.expanded` / `substitution` / `arithmetic` / `errorForm`。
 */
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
    if (t.expanded) return t.text;
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
 * `HANDLED` 里那几个**语义压在参数上**的词:给出第一个这一层证明不了的参数，全都证明得了就 `null`。
 *
 * 判据跟 `SET_HANDLED` 一个路子 —— **白名单,不是黑名单**。反过来写「哪些变量名危险」就是列反例:
 * `PATH` 之外还有 `IFS`（改词分割）、`ENV`/`BASH_ENV`（起 shell 时读的脚本）、`LD_PRELOAD`/
 * `DYLD_*`（动态库注入）排着队,而「哪些环境变量会改掉后面那几条怎么执行」这个集合压根不封闭。
 * 所以这里要的是**封闭的那一侧**:证明得出它谁都没赋值。
 *
 * · `read` —— 带操作数就算未知（`read X` 也算:这一层证明不出 X 不改执行语义）。
 *   不带操作数的 `read` 写的是固定的 `REPLY`,那是证明得出来的。
 * · `printf` —— bash 的 `printf -v 名字 …` 同样是赋值;没有 `-v` 就只往流里写字。
 *
 * **引号不反向证明「这不是开关」**（第 2 轮审查第 2 条）。上一版 printf 那一侧搜的是「不带引号
 * 且文本以 `-v` 开头」的参数,于是实测这两条都被当成「压根没赋值」、照旧硬拦,而真 shell 里
 * 赋值确实发生了（后面那个 tail 因此找不到,随后正常打出 DONE 退出 0）:
 *   · `printf '-v' PATH '%s' /no-such-directory; tail -F /dev/null; printf 'DONE\n'`
 *     —— `'-v'` 和 `-v` 是同一个开关,引号只影响它算不算命令词/关键字,不影响它的字面值;
 *   · `flag=-v; printf $flag PATH …` —— 开关本身是个展开,这一层压根读不出它是什么。
 * 要证明的是**封闭的那一侧**:「这条 printf 的选项区里不可能出现 `-v`」。证得出来才放行。
 */
/**
 * 证明没过的那个参数,以及**这一层对它到底知道到什么程度**。
 *
 * 三档不能用同一句话说(报告第 2 条的措辞要求):把「我读不出来」说成「它在给变量赋值」是替
 * 用户编了一个事实 —— 他照着这条提示去找一个可能压根不存在的赋值;反过来把读得出来的
 * `printf -v PATH` 说成「可能」,又把一件确定的事说软了。
 *  · `assigns`    —— 读出来了,它确实在赋值（`printf -v NAME`）;
 *  · `operand`    —— 它落在操作数位置上,而这一层**分不开**「变量名」和「某个选项的参数」
 *    （`read -p 提示 X` 里那个提示跟 X 长在同一个位置），所以只说位置,不替它断定是哪一种;
 *  · `unreadable` —— 它是个展开,是什么要等执行时才知道（`printf $flag`）。
 */
type ArgvFlaw = { arg: string; claim: "assigns" | "operand" | "unreadable" };
const ARGV_PROOF = new Map<string, (argv: readonly Token[]) => ArgvFlaw | null>([
  // 引号同样不反向证明「这不是开关」(与 printf 一个口径)。**选项的参数和变量名这一层分不开**
  // (`read -p 提示 X` 里那个提示落在同一个位置上),分不开就一起算未知 —— 结论是同一个,而
  // 文案只说「带着操作数」,不替用户断定那个词就是变量名。
  ["read", (argv) => {
    for (const t of argv) {
      if (t.expanded) return { arg: t.text, claim: "unreadable" }; // 操作数展开成什么读不出来
      if (!/^-/.test(t.text)) return { arg: t.text, claim: "operand" }; // 不是开关 ⇒ 落在操作数位置上
    }
    return null;
  }],
  // 只看**选项区**:选项得排在格式串前面（POSIX 的工具语法,`--` 显式收口),格式串之后的
  // `-v` 是操作数,printf 会把它当字打出去。所以这一侧两个方向都能证:
  //  · 选项区里读得出一个 `-v` ⇒ 它在赋值（引号照样算);
  //  · 选项区里有个读不出来的词 ⇒ 证明不了它不是 `-v` ⇒ 未知;
  //  · 选项区收口了（撞上 `--`、或撞上一个读得出来且不以 `-` 开头的词) ⇒ 证明得出谁都没赋值。
  // 上一版连「选项区」这个概念都没有,于是 `printf '%s\n' -v` 和 `printf -- -v PATH` 这两条
  // 不是赋值的也被当成了赋值（方向相反的同一个错:拿「长得像 -v」代替「它是不是开关」)。
  ["printf", (argv) => {
    for (let i = 0; i < argv.length; i += 1) {
      const t = argv[i]!;
      if (t.expanded) return { arg: t.text, claim: "unreadable" };
      if (t.text === "--") return null;
      if (!t.text.startsWith("-")) return null;
      if (/^-v/.test(t.text)) {
        const arg = t.text === "-v" ? `-v ${argv[i + 1]?.text ?? ""}`.trim() : t.text;
        return { arg, claim: "assigns" };
      }
    }
    return null;
  }],
]);
const TAIL = "而被赋值的那个名字改不改得动后面每一条的执行语义";
const argvNote = (name: string, flaw: ArgvFlaw): string => {
  if (flaw.claim === "assigns") return `那个 ${name} ${flaw.arg} 是在给变量赋值，${TAIL}`;
  if (flaw.claim === "operand") return `那个 ${name} 带着操作数 ${flaw.arg}，${TAIL}`;
  return `那个 ${name} ${flaw.arg} 这一层读不出它是什么，证明不了它没在给变量赋值 —— ${TAIL}`;
};

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
  if (head.expanded) return { unreadable: "那一段要跑的命令词是个展开，它展开成哪个命令要等执行时才知道" };
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
      if (t.errorForm) return "那个 ${…?…} 展开在变量没定义时当场就让 shell 走人";
      if (t.substitution) return "那段命令替换跑的是一段这一层读不进去的代码";
      if (t.arithmetic) return "那段算术展开自己就能让 shell 当场出错走人（`$((1/0))` 实测 127）";
      if (t.unknownForm) return "那个 `$` 后面跟的形式这一层没有正面识别（`$[1/0]` 这类旧式算术实测除零退 127），读不懂就证明不了它不出错";
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
    // **进了 `HANDLED` 不等于整词放行**:语义压在参数上的那几个还要按 argv 证明一遍（F3）。
    const proof = ARGV_PROOF.get(cmd.name);
    if (proof) {
      const flaw = proof(cmd.argv);
      if (flaw !== null) return argvNote(cmd.name, flaw);
      continue;
    }
    const note = NOTES.get(cmd.name);
    if (note) return note;
    // **空间内的白名单**:shell 自己的词里凡是这一层没有处置的,一律算读不懂（见 `SHELL_WORDS`）。
    if (SHELL_WORDS.has(cmd.name) && !HANDLED.has(cmd.name)) return shellWordNote(cmd.name);
  }
  return null;
}
