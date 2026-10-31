// 硬拦资格的**最后一道**:这条命令的执行语义，我这一层还读得懂吗（见
// shared/src/command-never-exits.ts 文件头 ⑪⑫）。从 test-monitor-block-eligibility.ts 拆出来
// （单文件 700 行的约定），判据那一侧同期拆成了 shared/src/command-perturbation.ts。
//
// 钉的是**不变量**，不是实现的形状（本轮 D1）:
//
//   **这一层没有处置的东西 ⇒ 不许硬拦** —— 「我不知道」一路往上冒，到顶就是取消硬拦资格。
//
// 所以这个文件**一行实现都不读**:不 grep 源码、不认那张表叫什么名字、也不管它住在哪个文件。
// 判据那边改名、换数据结构、再拆一次文件，这些用例照旧钉得住；而少认一个 shell 词、或者把
// 白名单改回黑名单，立刻有用例红。上一版在这儿锁的是 `const SHAKERS = new Map` 这种源码形状，
// 它只证明「那张表还在」，证明不了「表**外**的那些算未知」—— 而 D1 要的恰恰是后者:那张表当年
// 就在，`unset PATH; tail -F /dev/null`（实测退出 0）照旧吃 409。
import assert from "node:assert/strict";
import { neverExitsOnItsOwn, neverExitsVerdict } from "@ash/shared/command-never-exits";

const passes = (command: string, why: string) =>
  assert.equal(neverExitsOnItsOwn(command), null, `${why}，这一条不许硬拦：${command}`);

/** 铁定该硬拦的那一条（事故的起因命令本体）:下面每一节都拿它当台子。 */
const BASE = "tail -F build.log 2>/dev/null | grep --line-buffered ERROR";
assert.equal(
  neverExitsOnItsOwn(BASE), "tail -f/-F",
  "这个文件的台子前提:基线那一条本来就该硬拦，不然下面每一条都验不出东西",
);

// ── ① 真 shell 实测过的那几条:执行语义读不懂 ⇒ 只配做提示 ──────────────────────────
// 前四条是上一轮（⑪）的，后两条是本轮 D1 的 —— 同一族、同一个机制，而上一版靠一张「我见过的
// 词」表，于是后两条照旧硬拦。全部 `sh -lc` 实测:退出码与输出记在各自那句话里。
{
  const cases = [
    ["while true; do eval 'break'; done; printf 'DONE\\n'", "`break` 在引号里，词表扫不进 eval 的字符串（实测 0 + DONE）"],
    ["set -n; while true; do :; done", "`-n` 是「读完一条都不执行」（实测 0）"],
    ["while true; do kill -TERM $$; done", "能终止这个 shell 的不只有 break/exit/return（实测 SIGTERM）"],
    ["PATH=/definitely-missing-ash-review; tail -F /dev/null", "跟随型压着「那个工具找得到」（实测 127）"],
    ["unset PATH; tail -F /dev/null; printf 'DONE\\n'", "赋值那一侧早认了，**取消**那一侧没人认（实测 0 + DONE）"],
    ["hash -p /usr/bin/true tail; tail -F /dev/null; printf 'DONE\\n'", "`hash -p` 把这个名字钉到了别的可执行文件上（实测 0 + DONE）"],
    // 报告原文给的那两条反例（它们是 D1 的起点:21 轮审查都没过的那一条）。
    ["action=break; while true; do \"$action\"; done; printf 'DONE\\n'", "要跑的那个命令词是个展开，这一层读不出它是 `break`（实测 0 + DONE）"],
    ["unset X; : \"${X:?required}\"; while true; do :; done", "`${…:?…}` 在变量没定义时当场让 shell 走人（实测 127）"],
    [": \"${ASH_REVIEW_UNDEFINED:?required}\"; while true; do :; done", "同上，而「这个变量定义过没有」这一层答不出来（实测 127）"],
    // 第 4 轮审查 F3 的三条:上面那两条 `${…:?…}` 当年之所以是绿的，是因为它们恰好**都写了引号**
    // —— 引号里的内容原样留在 `text` 里，正则正好扫得到。不带引号的那一半，词法层按设计抹成了
    // 占位符，三条判据一条都看不见（见下面 ②c）。
    [": $((1/0)); while true; do :; done", "算术展开除零，循环一次都没跑（实测 127）"],
    [": ${1:?required}; while true; do :; done", "位置参数的错误形式，而且 `${` 当年被当成分段符（实测 127）"],
    ["read PATH; tail -F /dev/null; printf 'DONE\\n'", "`read PATH` 把 PATH 读成了空，那个 tail 压根没启动（实测 0 + DONE）"],
    // 第 2 轮审查第 2 条给的三条输入本体（同族的根因与对照组在 ②c、②d 两节）。前者丢的是
    // **嵌套**进参数展开里那一层语义,后两者是把「带引号/展开出来的 `-v`」当成了没赋值。
    [": ${CK_REVIEW_UNSET:-$((1/0))}; while true; do :; done", "套在 `${…:-…}` 里的算术照样让 shell 当场走人（实测 127，division by 0）"],
    ["printf '-v' PATH '%s' /no-such-directory; tail -F /dev/null; printf 'DONE\\n'", "引号不反向证明「这不是开关」（实测 0 + DONE，PATH 真的被改成 /no-such-directory）"],
    ["flag=-v; printf $flag PATH '%s' /no-such-directory; tail -F /dev/null; printf 'DONE\\n'", "开关自己是个展开，读不出来就证明不了它没赋值（实测 0 + DONE）"],
    // 第 1 轮审查 F2 给的那一条（同族的封闭性对照组在 ②e）。本机 /bin/sh 自测:
    // `/bin/sh -c ': $[1/0]; while true; do :; done'` ⇒ rc=127、`1/0: division by 0`,
    // 循环一次都没跑 —— 而上一版的词法层对 `$[` 一个标记都不打。
    [": $[1/0]; while true; do :; done", "`$[…]` 是这一层没见过的展开形式（旧式算术，实测 127 division by 0）"],
    // 自由工作流第 1 轮审查 F1 给的三条输入本体(同族的封闭性对照组在 ②f)。三条真 shell 里
    // 都是 `status=1, signal=null`、tail 一次都没跑到:前者是「位置参数赋不上值」,后两者是
    // bash 3.2 不认的参数形式。词法层上一版对它们只打一个 expanded,于是硬拦资格照旧。
    [": ${1:=default}; tail -F /dev/null; printf 'DONE\\n'", "往位置参数上赋值当场报错走人（实测 1，`$1: cannot assign in this way`）"],
    [': "${value!}"; tail -F /dev/null; printf \'DONE\\n\'', "`${X!}` 是这一层没正面证明过的参数形式（实测 1，bad substitution）"],
    [": ${value@Q}; tail -F /dev/null; printf 'DONE\\n'", "`${X@Q}` 同上（bash 4.4 才有，本机 /bin/sh 是 3.2，实测 1 bad substitution）"],
  ] as const;
  for (const [command, why] of cases) passes(command, `执行语义这一层读不懂（${why}）`);
  console.log(`✓ 执行环境:真 shell 实测会自己结束的那 ${cases.length} 条，一条都不许硬拦`);
}

// ── ② 不变量:**这一层没处置的 shell 词，一个都不许留下硬拦** ────────────────────────
// 能改掉「后面那几段按什么规矩执行」的东西只有 **shell 自己的词**:外部程序改不动调用它的那个
// shell（它唯一能做的是结束这个进程，而「没人把这个进程结束掉」是哨兵这个功能的运行假设，不是
// 待证项）。shell 词是**封闭可枚举**的，所以这一道按「空间内的白名单」走 —— 下面这张表是**测试
// 自己持有**的一份（抄 sh/bash/zsh/ksh 手册，不是从实现里读出来的）:实现那边少认一个，这里立刻红。
{
  /** 这一层确实有处置、因此**不该**取消硬拦的那几个（理由逐条见判据那边的 `HANDLED`）。 */
  const HANDLED = new Set([
    ":", "true", "false", "test", "[", "echo", "printf", "cd", "pwd", "read", "wait",
    "shift", "umask", "times", "export", "break", "continue", "exit", "return", "exec", "set",
    // 这两个是**透明包装**（剥掉它们再看里面那条），判据那一层另有处置。
    "command", "time",
  ]);
  const SHELL_WORDS = [
    // POSIX 特殊内建 + 常规内建
    "break", ":", "continue", ".", "eval", "exec", "exit", "export", "readonly", "return",
    "set", "shift", "times", "trap", "unset",
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
  ];
  for (const word of SHELL_WORDS) {
    if (HANDLED.has(word)) continue;
    // 不带参数:参数本身可能改变形状，这一条要问的只是「这个词在命令词位置上」。
    passes(`${word}; ${BASE}`, `\`${word}\` 是 shell 自己的词、这一层没有它的处置`);
  }
  console.log(`✓ 执行环境:${SHELL_WORDS.length} 个 shell 词里，这一层没处置的 ${SHELL_WORDS.filter((w) => !HANDLED.has(w)).length} 个全部取消硬拦`);

  // **反过来也要钉住**:处置过的那几个不许把闸放掉 —— 全放的话这道闸就归零了（漏判虽然只是
  // 退回今天的行为，但「谁都能把闸关掉」就不是判据了）。
  for (const command of [
    `: ; ${BASE}`, `true; ${BASE}`, `false; ${BASE}`, `printf 'x\\n'; ${BASE}`,
    `echo x; ${BASE}`, `cd /tmp; ${BASE}`, `pwd; ${BASE}`, `umask 022; ${BASE}`,
    // `export`/`shift`/`times` 只有**不带操作数**那一种证明得出来 —— 带操作数的那一侧见 ②f
    // (上一版这里放的是 `export FOO=1`,而「只有 PATH 要紧」正是第 5 轮审查 F2 点名的列反例)。
    `shift; ${BASE}`, `wait; ${BASE}`, `times; ${BASE}`, `export; ${BASE}`,
    `test -f x; ${BASE}`, `[ -f x ]; ${BASE}`, `set -e; ${BASE}`, `set -x; ${BASE}`,
  ]) {
    assert.equal(
      neverExitsOnItsOwn(command), "tail -f/-F",
      `这个词的执行语义这一层已经算进去了，不许凭它把闸放掉：${command}`,
    );
  }
  console.log("✓ 执行环境:处置过的那几个 shell 词出现在前面，照旧硬拦");
}

// ── ②b 命令词 / 展开 / 替换:**要跑的是谁答不出来** ⇒ 不许硬拦 ──────────────────────
// 这三道跟②是同一条不变量的另外三个口子（报告原文:「任何必要执行节点、命令词、展开或前序状态
// 的语义不在已证明安全的封闭集合里，都必须使整条硬拦资格失效」）。上一版这里是一句 `continue`
// —— 「这一段的命令词是谁读不出来」被当成了「没什么可担心的」。
{
  for (const [command, why] of [
    ['"tail" -F build.log', "命令词在引号里"],
    ["$TOOL -F build.log", "命令词是个展开"],
    ["$(which tail) -F build.log", "命令词是段命令替换"],
    ["`which tail` -F build.log", "反引号同判"],
    ['tail -F "$(printf build.log)"', "参数里有命令替换 —— 括号里是另一层读不进去的执行"],
    [': "${ASH_X:?boom}"; ' + BASE, "带退出语义的展开，哪一段里出现都算"],
    [BASE + '; : "${ASH_X?boom}"', "`${X?…}` 这一种同判"],
    ["set $FLAGS; while true; do :; done", "`set` 的开关是个展开（FLAGS=-n 就是 noexec）"],
    ["sudo -X tail -F build.log", "包装命令的开关认不出来 ⇒ 剥不出真正要跑的是谁"],
  ] as const) passes(command, `要跑的是谁/怎么跑答不出来（${why}）`);
  // 这里头有几条是**明知的误降级**（见判据那边的不对称那段）:`tail -F "$(printf build.log)"`
  // 真 shell 里其实挂得住,而「读不出来」只能往放行那一侧站。代价方向对:提示照样说得清，
  // 人照样提交得了;反过来留着硬拦，就是拿一个没人核过的假设把一件做得成的事变成做不成。

  // **不许顺着这一道把闸整个放掉**:只有赋值前缀的那一段压根没有命令词 —— 那里什么都不执行，
  // 如实算「没有扰动」。读成未知的话，一句 `FOO=1;` 就能把闸关掉。
  for (const command of [
    "LOG=1 tail -F build.log",
    "FOO=1; " + BASE,
    "action=break; " + BASE,
  ]) {
    assert.equal(
      neverExitsOnItsOwn(command), "tail -f/-F",
      `只有赋值前缀的那一段什么都不执行，不算扰动：${command}`,
    );
  }
  console.log("✓ 执行环境:命令词/展开/替换读不出来一律降级；只有赋值前缀的段不算扰动");
}

// ── ②c 不变量:**同一件事的每一种拼写都要判得一样** ────────────────────────────────
// 这一节钉的是第 4 轮审查 F3 的根因:判据不许依赖「它恰好长什么样」。词法层按设计把不带引号的
// 展开抹成占位符 `?`、还把 `${` 当成分段符，于是「拿正则扫 `Token.text`」这种写法对**不带引号**
// 的那一半天生无效 —— 而我自己那几条 `${…:?…}` 回归恰好全写了引号，所以一直是绿的。
//
// 所以这里不按「某条命令该不该拦」列，按**拼写的对照组**列:同一件事的两三种写法必须同判。
// 少传播一次未知（抹成占位符、切碎、只认命名变量不认位置参数），对照组里立刻有一半红。
{
  const spellings: readonly (readonly [string, readonly string[]])[] = [
    ["命令替换", ["$(printf build.log)", "`printf build.log`", '"$(printf build.log)"']],
    ["算术展开", ["$((1/0))", '"$((1/0))"', "$(( 1 / 0 ))"]],
    ["带退出语义的展开（命名变量）", ["${ASH_X:?boom}", '"${ASH_X:?boom}"', "${ASH_X?boom}"]],
    ["带退出语义的展开（位置参数）", ["${1:?boom}", '"${1:?boom}"', "${1?boom}"]],
    ["带退出语义的展开（特殊参数）", ["${@:?boom}", "${#:?boom}"]],
    // **套在参数展开里面的那一层也算**（第 2 轮审查第 2 条）。整段马上要被抹成一个占位符,
    // 内层那个算术/替换/error form 不在词法层记下来就永远找不回来 —— 上一版只问了最外层是不是
    // error form,于是 `: ${X:-$((1/0))}` 这条**真 shell 里除零退 127** 的命令被硬拦。
    // 带引号那一半一直是对的（引号里的内容原样留在 text 里,被同一个扫描看了个遍）,所以这个
    // 对照组里只有不带引号的那一侧会红 —— 这正是「按拼写列对照」要抓的那种偏科。
    // 实测（/bin/sh -lc）:`: ${CK_REVIEW_UNSET:-$((1/0))}` 报 division by 0、退 127;
    // `: ${CK_A:-${CK_B:?boom}}` 报 CK_B: boom、退 127。
    ["嵌套在参数展开里的算术", ["${ASH_X:-$((1/0))}", '"${ASH_X:-$((1/0))}"', "${ASH_X-$((1/0))}"]],
    ["嵌套在参数展开里的命令替换", ["${ASH_X:-$(printf x)}", '"${ASH_X:-$(printf x)}"', "${ASH_X:+`printf x`}"]],
    ["嵌套在参数展开里的退出语义", ["${ASH_X:-${ASH_Y:?boom}}", '"${ASH_X:-${ASH_Y:?boom}}"']],
    // 自由工作流第 1 轮审查 F1:参数展开那一道也得是**封闭**的(见 shared 的 parameterForm)。
    // 赋值只有名字赋得上,位置参数和特殊参数当场报错走人;而这一层没正面证明过的形式一律未知。
    ["往位置/特殊参数上赋值", ["${1:=v}", '"${1:=v}"', "${1=v}", "${@:=v}", "${#=v}"]],
    ["没正面证明过的参数形式", ["${ASH_X!}", '"${ASH_X!}"', "${ASH_X@Q}", "${!ASH_X}", "${ASH_X/a/b}", "${ASH_X:1:2}", "${ASH_X^^}", "${}"]],
  ];
  for (const [kind, forms] of spellings) {
    for (const form of forms) {
      passes(`: ${form}; ${BASE}`, `${kind}这一种（写法 \`${form}\`）的执行语义读不出来`);
    }
  }
  console.log(`✓ 执行环境:${spellings.length} 类未知展开 × 每类两三种拼写，带不带引号都判得一样`);

  // **反过来钉死三件不许跟着松的事** —— 这一道是往放行那侧走的，松过头闸就归零了。
  for (const [command, why] of [
    // ① 单引号里的是**字面量**:shell 不展开它，所以这一层证明得出那条 tail 照旧永不结束。
    ["tail -F '$(printf x)'", "单引号不展开"],
    ["tail -F '${X:?boom}'", "同上"],
    // ② 参数位上的**值展开**不破证明:`tail -F` 不管跟的是什么都不结束。
    ["tail -F $LOG", "值展开在参数位"],
    ["tail -F ${LOG}", "换成大括号同理"],
    [`echo ${"${HOME}"}; ${BASE}`, "没有退出语义的普通展开"],
    // F1 往「未知」那侧翻默认值,**POSIX 列过的那几种不许跟着翻**:它们证明得出没有退出语义,
    // 跟着翻一遍这道闸就只剩纯内建循环还拦得住了。实测 `: ${CK_UNSET:=d}; tail -F /dev/null`
    // 永不结束(被 2.5 秒超时 SIGTERM 掉),`${#X}` / `${X%.log}` 同理。
    [`: ${"${CK_UNSET:=d}"}; ${BASE}`, "名字赋得上值 ⇒ 没有退出语义"],
    [`: ${"${#CK_UNSET}"}; ${BASE}`, "取长度"],
    [`: ${"${CK_UNSET%.log}"}; ${BASE}`, "模式剥除"],
    [`: ${"${CK_UNSET:-fallback}"}; ${BASE}`, "默认值"],
    [`echo $HOME; ${BASE}`, "同上，不带大括号"],
    // ③ `${…}` 不再当分段符之后，**真正的分组 `{ …; }` 必须还认得**。
    ["{ tail -F build.log; }", "大括号分组"],
    ["{ tail -F a.log; } | grep x", "分组接管道"],
    ["{ cd /tmp; tail -F a.log; }", "组里有多段"],
    // 注:`while true; do { :; }; done` 在这一层**本来就**判不出来（改动前后都是 null），是既有的
    // 漏判、方向安全，不在本轮范围里 —— 写进来只会把一条既有行为钉成「本轮保证」。
  ] as const) {
    assert.notEqual(
      neverExitsOnItsOwn(command), null,
      `这一条的执行语义是证明得出来的，不许跟着松掉（${why}）：${command}`,
    );
  }
  console.log("✓ 执行环境:单引号是字面量、参数位的值展开不破证明、`{ …; }` 分组照旧认得");
}

// ── ②d 不变量:**在白名单里不等于整词放行** ────────────────────────────────────────
// `HANDLED` 答的是「这个词的执行语义这一层有处置」，而有几个词的语义**压在参数上**。②那一节
// 按不带参数的形态枚举，正好绕开了这一层 —— F3 实测 `read PATH` 把 PATH 读成空、后面的 tail
// 压根没启动，却照旧吃 409。判据同样只能往封闭的那一侧写:证明得出它谁都没赋值才算放行。
{
  for (const [command, why] of [
    [`read PATH; ${BASE}`, "读进 PATH ⇒ 后面那些工具还找不找得到"],
    [`read X; ${BASE}`, "读进别的名字也算:这一层证明不出 X 不改执行语义（IFS/ENV/LD_PRELOAD 排着队）"],
    [`read -r LINE; ${BASE}`, "带开关也一样，看的是有没有操作数"],
    [`read "$NAME"; ${BASE}`, "名字读不出来 ⇒ 更不知道它赋给谁"],
    [`printf -v PATH '%s' /missing; ${BASE}`, "bash 的 `printf -v` 是赋值"],
    [`printf -vPATH '%s' /missing; ${BASE}`, "开关和名字连写同判"],
    // **引号不反向证明「这不是开关」**（第 2 轮审查第 2 条）。上一版搜的是「不带引号且以 `-v`
    // 开头」的参数 —— 引号只决定这个词算不算命令词/关键字,不改它的字面值。实测
    // （/bin/sh -lc）:`printf '-v' PATH '%s' /no-such-directory` 之后 PATH 真的变成了
    // /no-such-directory、tail 找不到,整条命令退 0 并打出 DONE。
    [`printf '-v' PATH '%s' /missing; ${BASE}`, "`'-v'` 和 `-v` 是同一个开关（实测 0 + DONE）"],
    [`printf "-v" PATH '%s' /missing; ${BASE}`, "双引号同判"],
    [`printf $flag PATH '%s' /missing; ${BASE}`, "开关自己是个展开 ⇒ 证明不了它不是 -v（实测 0 + DONE）"],
    [`printf "$flag" PATH '%s' /missing; ${BASE}`, "带引号的展开同判"],
  ] as const) passes(command, `这个词的语义压在参数上（${why}）`);

  // 不带操作数的那一种**证明得出来**:`read` 写的是固定的 `REPLY`，`printf` 只往流里写字。
  // 后两条钉的是**反方向的同一个错**:判据不许拿「长得像 -v」代替「它是不是开关」。选项排在格式串
  // 前面（`--` 显式收口）,之后的 `-v` 是操作数 —— 实测 `printf '%s\\n' -v` 与 `printf -- -v PATH`
  // 都只把 `-v` 打出来、PATH 一个字没动,所以那条 tail 照旧证明得出永不结束,闸不许松。
  for (const command of [
    `read; ${BASE}`, `read -r; ${BASE}`, `printf 'x\\n'; ${BASE}`, `printf '%s' x; ${BASE}`,
    `printf '%s\\n' -v; ${BASE}`, `printf -- -v PATH; ${BASE}`,
  ]) {
    assert.equal(
      neverExitsOnItsOwn(command), "tail -f/-F",
      `这一种证明得出它谁都没赋值，不许凭它把闸放掉：${command}`,
    );
  }
  console.log("✓ 执行环境:白名单里的词按 argv 再证一遍，证得出没赋值的才放行");
}

// ── ②e 不变量:**`$` 后面跟什么,这一层认不认得是封闭的** ────────────────────────────
// 第 1 轮审查 F2 的根因:上一版的默认值是反的 —— 枚举过的几种展开（`$(`、`${`、`$NAME`）打标,
// **其余一律不打标**。于是一个这一层没见过的形式连「这里有读不懂的东西」都报不出来:
// `$[1/0]`（bash 的旧式算术）在真 shell 里当场除零退 127（本机 /bin/sh 自测 rc=127），判据
// 却给出硬拦。再加一条 `$[` 的黑名单只修得掉这一个输入;要修这一类,只能把默认值翻过来 ——
// **字面值那一侧才是白名单**,不在白名单里的形式一律算读不懂。
//
// 所以这一节按②c 的办法列对照组:认不出来的形式**每一种拼写**都要降级,而字面的美元号一个都
// 不许跟着松（松了这道闸就被一句 `echo x$` 拆了）。
{
  for (const [command, why] of [
    [": $[1/0]; while true; do :; done", "旧式算术除零（实测 127）"],
    [`: $[1+1]; ${BASE}`, "同一种形式，算得出来也一样:读不懂的是形式本身"],
    [`: "$[1/0]"; ${BASE}`, "双引号里的展开真的会执行，同判"],
    [`: ${"${ASH_X:-$[1/0]}"}; ${BASE}`, "套在参数展开里的那一层也要带上来（②c 同一条不变量）"],
    [`: $'\\n'; ${BASE}`, "`$'…'` 是 bash 的 ANSI-C 引用，POSIX sh 里没有这一种"],
    [`: $"x"; ${BASE}`, "`$\"…\"` 是 locale 翻译，同样随 shell 而变"],
    [`tail -F $[1]`, "参数位上也算:它展开成什么、会不会出错，这一层都读不出来"],
  ] as const) passes(command, `\`$\` 后面那个形式这一层没有正面识别（${why}）`);
  // 这里头 `$'…'` / `$"…"` 是**明知的误降级**:本机 /bin/sh 自测 `: $'\n'; while true; do :; done`
  // 被我 1.2 秒后杀掉（rc=137）—— 它真的永不结束。方向仍按文件头那段不对称站:多认一个未知
  // ⇒ 降成提示、人照样提交得了;少认一个 ⇒ 拿一个没人核过的假设把一件做得成的事变成做不成。

  // **反过来钉住字面的美元号** —— POSIX 明文:`$` 后面不是能起一个展开的字符，它就是字面值。
  // 这几条要是跟着降级，这道闸就归零了（`$` 在命令行里到处都是）。
  for (const command of [
    `echo x$; ${BASE}`, `echo $ ; ${BASE}`, `echo a=$:; ${BASE}`, `echo $=1; ${BASE}`,
    `echo p$,q; ${BASE}`, `echo $.x; ${BASE}`, `echo $/x; ${BASE}`,
    `echo $$; ${BASE}`,                 // `$$` 是 pid，值展开,参数位上不破证明
    `echo '$[1/0]'; ${BASE}`,           // 单引号里的是字面量，shell 不展开它
    `printf 'cost 5$\\n'; ${BASE}`,
  ]) {
    assert.equal(
      neverExitsOnItsOwn(command), "tail -f/-F",
      `这个 \`$\` 是字面值（或参数位上的值展开），不许凭它把闸放掉：${command}`,
    );
  }
  console.log("✓ 执行环境:`$` 的形式按白名单封闭 —— 认不出来的每种拼写都降级，字面的美元号一个都不松");
}

// ── ②f 不变量:**内建的参数、赋值效果、特殊内建的错误退出,三样都要证得出来** ───────────
// 第 5 轮审查 F2 的四条实测输入(`sh -lc`,前两条退 0 并打出 DONE、后两条当场报错走人),全都
// 吃了 409。根因是两处各缺一半封闭证明:
//   · **赋值那一侧按引号放行** —— `export PATH="/x"` 和 `export "PATH=/x"` 的词在词法层都带
//     `quoted`,而上一版那道 PATH 扫描只看不带引号的词。引号只决定这个词算不算命令词/关键字,
//     不改它的字面值(`export` 自己在引号去掉之后才做赋值解析)。
//   · **「只有 PATH 要紧」是列反例** —— `IFS`/`ENV`/`LD_PRELOAD` 排着队,这个集合压根不封闭;
//     而**特殊内建报错会把非交互 shell 带走**这一整类(`export -not-an-option`、
//     `shift not_a_number`)上一版连算都没算。
// 所以这一节按②c/②d 的办法列**拼写组**:同一件事的每一种写法都要判得一样,而封闭的那一侧
// (压根没有操作数)不许跟着松。
{
  for (const [command, why] of [
    [`export PATH="/missing-review-directory"; ${BASE}`, "值带引号:整个词被打上 quoted(实测 0 + DONE，PATH 真的改了)"],
    [`export "PATH=/missing-review-directory"; ${BASE}`, "连 `=` 一起括进去，同判(实测 0 + DONE)"],
    [`export 'PATH=/missing'; ${BASE}`, "单引号同判"],
    [`export PATH=/missing; ${BASE}`, "不带引号的那一半本来就认得，这里是对照"],
    [`export -not-an-option; ${BASE}`, "特殊内建报错当场走人(/bin/sh 实测 rc=2 且 AFTER 没打出来)"],
    [`shift not_a_number; ${BASE}`, "同上(实测 rc=1，AFTER 没打出来)"],
    [`shift 1; ${BASE}`, "`n` 合不合法要看 `$#`，这一层读不出来"],
    [`shift $n; ${BASE}`, "操作数是个展开，更读不出来"],
    [`times x; ${BASE}`, "POSIX 不收操作数;给了之后各家不一样(zsh 报 too many arguments)"],
    [`export IFS=x; ${BASE}`, "「只有 PATH 要紧」是列反例:IFS 改词分割"],
    [`export LD_PRELOAD=/x.so; ${BASE}`, "动态库注入同理"],
    [`export ENV=/tmp/rc; ${BASE}`, "起 shell 时读的脚本同理"],
    [`export PATH; ${BASE}`, "只给名字也算:导出一个名字同样改后面看得见的环境"],
    [`export -n PATH; ${BASE}`, "取消导出也在这一类里(选项认不认得随 shell 变)"],
    [`export $flag; ${BASE}`, "参数是个展开 ⇒ 既证不了没赋值，也证不了它不报错"],
  ] as const) passes(command, `内建的参数/赋值/退出语义这一层证明不了（${why}）`);

  // **封闭的那一侧不许跟着松**:不带任何操作数的这三个证明得出来 —— `export` 只把已导出的变量
  // 列出来,`shift` 与 `times` 都是它们的正常用法(本机 `/bin/sh -c 'shift; echo AFTER'` 与
  // `/bin/bash` 实测都是 rc=0 并打出 AFTER)。这三条要是跟着降级,这道闸就被一句 `export` 拆了。
  for (const command of [`export; ${BASE}`, `shift; ${BASE}`, `times; ${BASE}`]) {
    assert.equal(
      neverExitsOnItsOwn(command), "tail -f/-F",
      `不带操作数的这一种证明得出来，不许凭它把闸放掉：${command}`,
    );
  }
  console.log("✓ 执行环境:内建的赋值与特殊内建的错误退出按 argv 封闭证明，引号不算证明，无操作数的照旧拦");
}

// ── ③ 机制本身:逐类掀翻那个前提，每一类都必须把硬拦取消 ────────────────────────────
// 这一节不是反例表，是**对照**:同一条铁定该拦的命令，每次只掀翻一类前提。
{
  for (const [command, which] of [
    [`eval 'printf x'; ${BASE}`, "另开一层这边读不进去的执行"],
    [`source ./env.sh; ${BASE}`, "把另一个文件的内容当代码跑"],
    [`trap 'exit 0' ALRM; ${BASE}`, "挂一段收到信号才跑的代码"],
    [`ulimit -t 1; ${BASE}`, "改掉这条命令自己的资源上限"],
    [`set -n; ${BASE}`, "改掉后面每一条的执行语义"],
    [`shopt -s extglob; ${BASE}`, "改掉 shell 的执行选项"],
    [`PATH=/nope; ${BASE}`, "动过工具查找路径"],
    [`unset PATH; ${BASE}`, "把工具查找路径整个去掉"],
    [`hash -p /usr/bin/true tail; ${BASE}`, "把一个命令名钉到别的可执行文件上"],
    [`${BASE}; kill -TERM $$`, "能把这条命令自己结束掉 —— 哪一段里出现都算"],
    [`if false; then eval x; fi; ${BASE}`, "连「它跑不到」这个结论都得先读懂 eval ⇒ 偏放行那一侧"],
  ] as const) {
    const note = neverExitsVerdict(command)?.unprovable ?? null;
    assert.notEqual(note, null, `这一类掀翻了执行环境那个前提，不许再硬拦（${which}）：${command}`);
    assert.ok((note ?? "").length > 8, `那句提示要说清是哪一处读不懂（${which}）：${command}`);
  }
  console.log("✓ 执行环境:逐类掀翻那个前提，每一类都把硬拦降成提示，而且说得出是哪一处");
}

// ── ④ 口径是**命令词位置**，不是搜文本（见判据文件头 ①）──────────────────────────────
// 同一个词出现在参数位上什么都不改 —— 这一组要是跟着放行，闸就被一条 `grep kill` 顺手拆了。
{
  for (const command of [
    "tail -F x.log | grep kill",                 // `kill` 是 grep 的模式
    "tail -F x.log | grep -e eval",              // 同上
    "tail -F set",                               // `set` 是 tail 的操作数
    "tail -F unset",                             // 本轮新收的那个词同判
    "find . -name '*.log' | xargs tail -F; tail -F y.log",   // `.` 是 find 的操作数
    "while true; do printf 'PATH=1\\n'; done",     // 引号里的字永远不是执行节点
  ]) {
    assert.equal(
      neverExitsVerdict(command)?.unprovable ?? null, null,
      `这几个词都在参数位上，执行语义一点没变，不许凭它把闸放掉：${command}`,
    );
  }
  console.log("✓ 执行环境:参数位上的同名词不算，闸不被一条 `grep kill` 拆掉");
}

// ── ⑤ 顺序:已经降过级的那一句，不许被这一道通用的盖掉 ──────────────────────────────
// 「压着一个没人核得了的前提」那一句说得具体（是哪个文件、哪个下游、哪个远端资源），而这一道
// 只说得出「执行语义读不懂」。先降级的留着自己那句，才是对用户有用的那一句。
{
  const remote = neverExitsVerdict("eval 'x'; kubectl logs -f pod-1")?.unprovable ?? "";
  assert.ok(
    /pod|容器|远端|核不了|在不在/.test(remote),
    `已经降级的那一条要留住它自己那句具体的话：${remote}`,
  );
  const downstream = neverExitsVerdict("eval 'x'; tail -F a.log | head -n 1")?.unprovable ?? "";
  assert.ok(/下游|读到头/.test(downstream), `下游那一句同理：${downstream}`);
  // 压根没判定的那一种:没什么可提示的，不许凭「读不懂」造出一个判定来。
  assert.equal(neverExitsVerdict("eval 'printf x'; printf 'done\\n'"), null,
    "没有判定就没有提示:这一道只改硬拦那一档");
  console.log("✓ 执行环境:这一道只改硬拦那一档，已降级的那句更具体、没判定的不造判定");
}

console.log("✓ 硬拦资格（执行环境）：没处置的一律取消硬拦，处置过的照旧拦，口径按命令词位置");
