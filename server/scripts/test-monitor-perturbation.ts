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
  for (const [command, why] of [
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
  ] as const) passes(command, `执行语义这一层读不懂（${why}）`);
  console.log("✓ 执行环境:真 shell 实测会自己结束的那九条，一条都不许硬拦");
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
    `shift; ${BASE}`, `wait; ${BASE}`, `times; ${BASE}`, `export FOO=1; ${BASE}`,
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
