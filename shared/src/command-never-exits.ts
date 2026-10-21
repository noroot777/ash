// 这条命令**自己会不会结束**:按结构判,不搜文本。创建闸（`server/src/monitor-create.ts`）和
// 手动挂哨兵那个表单（`web/src/monitors/MonitorComposer.tsx`）共用这一份判据。
//
// 从 monitor-end-condition.ts 拆出来（全局约定:单文件不超过 700 行）。两件事只在一处见面:
// 命令被判成「自己永远不会结束」而调用方又没给任何结束条件时**创建当场 409** —— 为什么是闸
// 而不是提醒、三条出路各对应哪种意图，都在那边（`endConditionDemand`）。这边只管「它会不会
// 自己收工」这一个判断。
//
// ── 四条判据 ─────────────────────────────────────────────────────────────────────
//
// ① **只看命令结构,不搜整串文本**（第 1 轮审查 F3）。上一版拿正则搜整条命令,于是
//    `printf '%s\n' 'tail -F build.log'` 被当成跟随型拦掉（实测 409）——匹配到的是 printf
//    的参数,那条命令打一行就退。反过来 `tail -n 0 -F /dev/null` 和 `timeout 1 true;
//    tail -F x` 又漏判。所以这一版先把命令切成**简单命令**（尊重引号、按
//    `; | && || & ( ) { } 换行` 断开）,只拿每条的**命令词和它自己的 argv** 去比;引号里的字、
//    `$( )`/反引号里的字一律不当执行节点。读不懂的形状（`eval`、脚本封装）**不拦**。
//
// ② **拦的凭据必须是「这一条真的会跑」**（第 2、3 轮审查 F3）。①只做到了「不搜整串文本」,
//    而切出来的简单命令里仍混着一堆**不是执行节点**的东西,于是八种会自己结束的命令被 409
//    拦掉（两轮审查实测,全部 `/bin/sh` 退出 0）：here-doc 的文档体、`#` 注释、从没被调用过
//    的函数体、`if false; then … fi` 这种走不到的分支、`tail -- -f`（`--` 之后那个 `-f` 是
//    文件名不是开关）、`false && tail -F x; printf done`（短路掉的右边）、`exit 0; tail -F x`
//    （退出之后的那一条）、`if false; then while true; do :; done; fi`（走不到的分支里的循环）。
//
// ③ **所以这一版是「先证明会跑、再问它会不会结束」,不是「先拦下来、再逐个豁免」**
//    （第 3 轮审查 F3）。上一版的形状是后者:一堆 if 往外豁免 —— 每次审查补一个写法,而漏
//    掉的那些照旧误拦。倒过来之后 `provableBlocker` 只走**证明得出会跑**的那几条简单命令:
//    不在 `if`/`case` 分支里、不在条件未知的循环体里、前面没有 `&&`/`||` 短路、前面没出现过
//    `exit`/`exec`,收尾符号也不是 `&`（放后台 ⇒ shell 不等它）。读不懂的结构一律放行,而
//    「读不懂」是**结构**读不懂（配不上对的 `fi`、认不出的循环条件），不是「这个写法没见过」。
//
// ④ **「会跑」这件事要在它自己的作用域里成立**（第 4 轮审查 F2）。③把形状倒了过来,但判据
//    还是「一个词 + 一小段」:于是四种会自己结束的命令照旧被 409（审查实测,全部退出 0 且
//    打出 DONE）——
//      · `while true && false; do :; done` —— 恒真只看了循环头第一个词,没看完整条件链
//      · `while true; do exec printf 'DONE\n'; done` —— `exec` 把本进程换掉了,循环没有第二圈
//      · `false && { printf x; tail -F /dev/null; }` —— 整组被短路,组内那个 `;` 却把执行
//        资格恢复成了 true（`reach` 当年是一个布尔,不分层）
//      · `for item in one; do break; tail -F /dev/null; done` —— 跳转之后那几条跑不到
//    所以这一版的三件事是对着作用域说的:条件要**在同一段里说完**才算读懂;执行资格按
//    **组**分层（`frames`）,一组被短路掉就整组不作数;循环体里有 `break`/`continue` ⇒
//    那一圈后面的命令证明不出会跑 ⇒ 整区不扫。
//
// ── 误判的代价不对称,所以只认**明确**的那几种 ───────────────────────────────────
//
// 漏判（把一条永不退出的命令放过去）= 退回今天的行为,不比现状坏;误判（把一条会自己结束
// 的命令拦下来）= 一件本来做得成的事做不成了。所以下面每一条都要求「这个写法不退出」是**这个
// 命令形状本身**决定的,而不是靠猜它的意图:`tail -f` 的语义就是不退出,`while true` 没有
// `break` 就是不退出。拿不准的一律不拦。
//
// 而「拦不拦」只决定**要不要你必须给一个**,不决定**你能不能给**:任何命令都可以配结束条件
// （表单一律给那个输入框），把同一份猜测拿去决定配置资格是第 1 轮审查 F3 点掉的那一半。


type Token = { text: string; quoted: boolean };

/** 引号内的内容换成等长空格:做文本判据时用，`echo 'waiting for exit'` 不该捐出一个 `exit`。 */
function blankQuoted(command: string): string {
  let out = "";
  let i = 0;
  while (i < command.length) {
    const c = command[i]!;
    if (c === "'" || c === '"') {
      const close = command.indexOf(c, i + 1);
      const end = close < 0 ? command.length : close;
      out += " ".repeat(end - i + 1);
      i = close < 0 ? command.length : close + 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * 两条简单命令之间那个符号。**它决定后面那一条证明不证明得出会跑**（见文件头 ③④）:
 *
 * · `;`、换行 —— 后面那条照跑（前一条的退出码不影响它）
 * · `&&`、`||` —— 后面那条跑不跑**要看前一条的退出码**,这一层答不出来
 * · `|` —— 管道各级都会跑,所以不打断「会跑」这件事
 * · `&` —— 放后台,**shell 不等它**:`tail -F x & printf done` 这条命令立刻就结束了
 * · `(` `{` `)` `}` —— 分组本身不决定任何事,**收尾那一组的那个符号才决定**:
 *   `{ tail -F x; } & printf done` 里那个 `;` 在组里,放不放后台要看 `}` 后面的 `&`
 */
type Sep = ";" | "&" | "&&" | "|" | "||" | "(" | ")" | "{" | "}" | "eof";
/** 一条简单命令 + 收尾它的那个符号。token 可以是空的（`(`、`;;`、注释行留下的空段）。 */
type Segment = { tokens: Token[]; sep: Sep };

/**
 * 把命令切成**简单命令 + 它的收尾符号**。
 *
 * 只认结构，不认意图：引号里的内容合成一个 token 并打上 `quoted`（**永远不会被当成命令词、
 * 也永远不会被当成关键字**），`$( )` 与反引号整段跳过（里面是另一层执行，这一层读不懂就不猜）。
 *
 * **空段也留着**（`tokens` 为空）:它身上那个符号还有用 —— `(cmd) && tail -F x` 里的 `&&`
 * 正好落在 `(` 留下的那个空段上,丢掉它就等于把「要看前一条退出码」这件事丢掉。
 */
function segments(command: string): Segment[] {
  const out: Segment[] = [];
  let cur: Token[] = [];
  let text = "";
  let quoted = false;
  let started = false;
  const endToken = () => {
    if (started) cur.push({ text, quoted });
    text = "";
    quoted = false;
    started = false;
  };
  const endSegment = (sep: Sep) => {
    endToken();
    out.push({ tokens: cur, sep });
    cur = [];
  };
  let i = 0;
  while (i < command.length) {
    const c = command[i]!;
    if (c === "'" || c === '"') {
      const close = command.indexOf(c, i + 1);
      text += close < 0 ? command.slice(i + 1) : command.slice(i + 1, close);
      quoted = true;
      started = true;
      i = close < 0 ? command.length : close + 1;
      continue;
    }
    if (c === "\\") { text += command[i + 1] ?? ""; started = true; i += 2; continue; }
    if (c === "$" && command[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      while (j < command.length && depth > 0) {
        if (command[j] === "(") depth += 1;
        else if (command[j] === ")") depth -= 1;
        j += 1;
      }
      // 占位成一个「不认识的词」:它是个参数，但也绝不该让后面那个词变成命令词。
      text += "?";
      started = true;
      i = j;
      continue;
    }
    if (c === "`") {
      const close = command.indexOf("`", i + 1);
      text += "?";
      started = true;
      i = close < 0 ? command.length : close + 1;
      continue;
    }
    // `#` 只在**词首**才是注释（shell 的规矩，`cmd -x#y` 里那个不是）。注释到行尾一个字都
    // 不执行 —— 上一版照旧切成简单命令，于是 `printf done # tail -F build.log` 被拦（F3）。
    if (c === "#" && !started) {
      const nl = command.indexOf("\n", i);
      endSegment(";");
      i = nl < 0 ? command.length : nl;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") { endToken(); i += 1; continue; }
    if (c === "\n" || c === ";") { endSegment(";"); i += 1; continue; }
    if (c === "&" || c === "|") {
      const twice = command[i + 1] === c;
      endSegment(twice ? (c === "&" ? "&&" : "||") : c === "&" ? "&" : "|");
      i += twice ? 2 : 1;
      continue;
    }
    if (c === "(" || c === ")" || c === "{" || c === "}") { endSegment(c); i += 1; continue; }
    text += c;
    started = true;
    i += 1;
  }
  endSegment("eof");
  return out;
}

/** 这些词只是**包一层**，真正跑的是后面那个命令。跳过它们和它们自己的开关。 */
const WRAPPERS = new Set(["env", "nohup", "nice", "ionice", "stdbuf", "unbuffer", "sudo", "command", "exec", "time"]);
/** 这些词带着死线:整条简单命令一定会结束，里面是什么都不看。 */
const TIMED = new Set(["timeout", "gtimeout"]);

/**
 * 一条简单命令的**命令词 + 它自己的 argv**。`bounded` = 它自带死线，无须再看。
 *
 * `from` = 从这一段的第几个词开始读。**结构骨架是靠挪这个下标剥掉的,不是靠切数组**
 * （第 5 轮审查 N1,同 `headOf`）—— `! ! ! … cmd` 这种一段里堆几万个骨架词的命令,切一次
 * 复制一遍剩下的全部,整条就成了平方级（实测 80000 个 `!` 要 1.6 秒;改下标后 12 毫秒）。
 */
function commandOf(tokens: Token[], from = 0): { name: string; argv: Token[]; bounded: boolean } | null {
  let i = from;
  while (i < tokens.length) {
    const t = tokens[i]!;
    // `VAR=value cmd …` 的赋值前缀；引号里的东西永远不是命令词。
    if (!t.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t.text)) { i += 1; continue; }
    if (t.quoted) return null;
    const name = t.text.split("/").pop() ?? t.text;
    if (TIMED.has(name)) return { name, argv: tokens.slice(i + 1), bounded: true };
    if (WRAPPERS.has(name)) {
      i += 1;
      while (i < tokens.length && !tokens[i]!.quoted && tokens[i]!.text.startsWith("-")) i += 1;
      continue;
    }
    return { name, argv: tokens.slice(i + 1), bounded: false };
  }
  return null;
}

/**
 * argv 里有没有这个短开关（含 `-qF` 这种并写）或长开关。
 *
 * **`--` 之后不再有开关**（第 2 轮审查 F3）：`tail -- -f` 盯的是一个名叫 `-f` 的文件，打完
 * 就退 —— 把那个操作数读成「跟随模式」，就是拿一条会自己结束的命令去换一个 409。
 */
function hasFlag(argv: Token[], short: RegExp, long: string): boolean {
  for (const { text, quoted } of argv) {
    if (quoted) continue;
    if (text === "--") return false;
    if (text.startsWith("--")) {
      if (text === long || text.startsWith(`${long}=`)) return true;
      continue;
    }
    if (text.startsWith("-") && short.test(text)) return true;
  }
  return false;
}
/** argv 里第一个不是开关的词（`watch` 要有活干、`docker logs` 的子命令）。 */
const operands = (argv: Token[]): string[] => argv.filter((t) => !t.text.startsWith("-")).map((t) => t.text);

/**
 * 跟随型：这些命令的语义就是「盯着不走」，放在管道里也一样 —— 它不退出，整条管道就不退出
 * （`tail -f x | grep -m1 y` 也救不了：日志安静下来 `tail` 收不到 SIGPIPE，管道照样挂着）。
 *
 * 判据全部落在**那一条简单命令自己的 argv** 上（见文件头 ①）。
 */
const FOLLOWERS: readonly { name: string; what: string; follows: (argv: Token[]) => boolean }[] = [
  { name: "tail", what: "tail -f/-F", follows: (a) => hasFlag(a, /^-[^-]*[fF]/, "--follow") },
  { name: "watch", what: "watch", follows: (a) => operands(a).length > 0 },
  { name: "inotifywait", what: "inotifywait -m", follows: (a) => hasFlag(a, /^-[^-]*m/, "--monitor") },
  { name: "journalctl", what: "journalctl -f", follows: (a) => hasFlag(a, /^-[^-]*f/, "--follow") },
  { name: "kubectl", what: "kubectl logs -f", follows: (a) => operands(a)[0] === "logs" && hasFlag(a, /^-[^-]*f/, "--follow") },
  { name: "docker", what: "docker logs -f", follows: (a) => operands(a)[0] === "logs" && hasFlag(a, /^-[^-]*f/, "--follow") },
  { name: "podman", what: "podman logs -f", follows: (a) => operands(a)[0] === "logs" && hasFlag(a, /^-[^-]*f/, "--follow") },
  // `fswatch` 默认就是盯着不走，`-1` 才是「等第一次事件就退」。
  { name: "fswatch", what: "fswatch", follows: (a) => !hasFlag(a, /^-[^-]*1/, "--one-event") },
];

/**
 * 把注释从**已经抹掉引号内容**的文本里也抹掉（按文本看的那两条判据用，长度保持不变）。
 *
 * 跟 `segments` 里那一支是同一条规矩的两处落点：那边决定「哪几条是简单命令」，这边决定
 * 「here-doc / 函数定义这些结构算不算出现过」。少一处，`# later() { … }` 这样的注释就又会
 * 把一条打一行就退的命令说成读不懂。
 */
function blankComments(text: string): string {
  let out = "";
  let wordStart = true;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "#" && wordStart) {
      const nl = text.indexOf("\n", i);
      const end = nl < 0 ? text.length : nl;
      out += " ".repeat(end - i);
      i = end;
      continue;
    }
    out += c;
    wordStart = /[\s;&|(){}]/.test(c);
    i += 1;
  }
  return out;
}

/**
 * 函数定义:`name() {` / `function name {`。**定义这一刻函数体一个字都不跑**,而「后面到底
 * 调没调过它」这一层答不出来 —— 答不出来就不拦（第 2 轮审查 F3 实测:一个从未被调用的
 * `later() { tail -F /dev/null; }` 把整条命令拦掉了）。
 */
const FUNC_DEF = /(?:^|[;&|\n])\s*(?:function\s+)?[A-Za-z_][A-Za-z0-9_-]*\s*(?:\(\s*\)\s*[{(]|\{)/;
/** here-doc / here-string:`<<EOF` 到终止词之间是**数据**,不是执行节点。 */
const HERE_DOC = /<</;

/** 分支结构:开它的词 → 关它的词。**整区不扫** —— 哪几支会跑是运行时的事。 */
const BRANCH: Record<string, string> = { if: "fi", case: "esac" };
/** 循环头。`do … done` 之间是循环体,它跑不跑得到另算（见 `loopShape`）。 */
const LOOP_HEADS = new Set(["while", "until", "for", "select"]);
/** 结构骨架:这些词不是命令词,剥掉之后那一段才是真正的简单命令（`then tail -F x`）。 */
const SKELETON = new Set(["then", "else", "elif", "do", "done", "fi", "esac", "in", "!"]);
/** 关键字只在**命令词位置**才算关键字（`grep -n fi src` 里那个 `fi` 是参数）。 */
const KEYWORDS = new Set([...Object.keys(BRANCH), ...LOOP_HEADS, ...SKELETON]);
/**
 * 一旦出现，**它后面的东西一条都证明不出会跑**:`exit 0; tail -F x` 里那个 tail 永远不会
 * 执行（第 1 轮审查 F3 实测:`/bin/sh` 当场退出 0,而创建闸照旧 409）。
 *
 * `exec` 在列是为了扫区（`if x; then exec foo; fi` 之后也证明不出什么），但它在**命令词
 * 位置**上另算:`exec tail -F x` 把本进程换成了那个 tail,这条命令该拦 —— 所以那一支先按
 * 它包着的命令判一次,再停止往后扫（见 `provableBlocker` 里那一行）。
 */
const TERMINATORS = new Set(["exit", "exec", "return"]);
/**
 * 恒真循环的**出路**。循环体里有它们，那个循环就不是「没有出路」。
 *
 * `exec` 在列（第 4 轮审查 F2）:`while true; do exec printf 'DONE\n'; done` 把本进程整个换
 * 成了那个 printf —— 这个循环连第二圈都没有（实测 409,而 `/bin/sh` 打完 DONE 就退出 0）。
 * `continue` **不在**列:它是回到循环开头,不是出路。
 */
const ESCAPES = new Set(["break", "exit", "return", "exec"]);
/**
 * 循环体里的**跳转**。它一出现，**这一圈里排在它后面的**那几条就证明不出会跑（第 4 轮审查
 * F2 实测:`for item in one; do break; tail -F /dev/null; done; printf 'DONE\n'` 被 409,而
 * `/bin/sh` 打完 DONE 就退出 0;`continue` 换上去同样）。
 *
 * 压住的只是**它后面**那一段,不是整个循环体 —— 不然 `do tail -F x; break; done` 这种
 * 「第一圈就挂在第一条上」的真阳会跟着一起放掉。跟 `ESCAPES` 问的不是同一件事:那边问
 * 「这个循环会不会结束」,这边问「这一圈剩下那几条证明得出会跑吗」—— 所以 `continue`
 * 只在这一边（它回到循环开头，不是出路）。
 */
const JUMPS = new Set(["break", "continue"]);
/** `while` 的恒真条件。`until` 的那一边是 `false`。 */
const TRUE_WORDS = new Set(["true", ":"]);

/** 这一段**从 `from` 起**那个词（引号里的永远不算）。没有就是空串。 */
function headOf(tokens: Token[], from = 0): string {
  const t = tokens[from];
  return t && !t.quoted ? t.text : "";
}

/** 这一段开头连着的那几个**结构关键字**（`do while true` 这种连写也要全认出来）。 */
function headKeywords(tokens: Token[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    if (t.quoted || !KEYWORDS.has(t.text)) break;
    out.push(t.text);
  }
  return out;
}

/**
 * 扫之前**一次算好**的两样东西:谁跟谁配对、哪一类词出现在哪儿（第 4 轮审查 N1）。
 *
 * 上一版这两样都是现算:`matchEnd` 每遇到一个 `if`/`do` 就从当前位置往后找配对，`wordsIn`
 * 每进一个区就把整区的词重列一遍 —— 嵌套一深就是平方级（审查实测:1 万层 `for` 嵌套单次
 * 1909ms,而创建入口和表单都是**同步**调用它,那段时间整条线程停着）。这一版把它们摊成
 * 两张表,各一次线性扫就建好,区的大小再也不进成本:配对是 O(1) 查表,「这个区里有没有
 * `break`」是一次减法。
 */
type Scan = {
  segs: Segment[];
  /** `${开它的词}@${开它那一段}` → 关它的那一段。配不上对的**不在表里**（读不懂 ⇒ 放行）。 */
  ends: Map<string, number>;
  /** 第 `i` 段**往后**第一个带 `do` 的段（循环头和它的 `do` 常常不在同一段）。-1 = 没有。 */
  doAt: Int32Array;
  /** 词表 → 前 `i` 段里它出现过几次（前缀和）。 */
  counts: Map<ReadonlySet<string>, Int32Array>;
};

/** 关它的词 → 开它的词。这三对都**只认命令词位置**（`grep -n fi src` 里那个 `fi` 是参数）。 */
const CLOSERS: Record<string, string> = { fi: "if", esac: "case", done: "do" };
const COUNTED: readonly ReadonlySet<string>[] = [TERMINATORS, ESCAPES, JUMPS];

function scanOf(segs: Segment[]): Scan {
  const n = segs.length;
  const ends = new Map<string, number>();
  const open: Record<string, number[]> = { if: [], case: [], do: [] };
  const doAt = new Int32Array(n + 1).fill(-1);
  const counts = new Map<ReadonlySet<string>, Int32Array>(COUNTED.map((set) => [set, new Int32Array(n + 1)]));
  for (let i = 0; i < n; i += 1) {
    for (const w of headKeywords(segs[i]!.tokens)) {
      open[w]?.push(i);
      const opener = CLOSERS[w];
      // 覆盖式写入:同一段里开了两个同类（`do while x` 这种连写）的话，留下**最外面**那个
      // 收尾段 —— 区更大 ⇒ 扫进去的更少 ⇒ 偏放行那一侧。
      if (opener !== undefined) {
        const from = open[opener]!.pop();
        if (from !== undefined) ends.set(`${opener}@${from}`, i);
      }
    }
    for (const set of COUNTED) {
      const pre = counts.get(set)!;
      let add = 0;
      for (const t of segs[i]!.tokens) if (!t.quoted && set.has(t.text)) add += 1;
      pre[i + 1] = pre[i]! + add;
    }
  }
  for (let i = n - 1; i >= 0; i -= 1) {
    doAt[i] = headKeywords(segs[i]!.tokens).includes("do") ? i : doAt[i + 1]!;
  }
  return { segs, ends, doAt, counts };
}

/** 跟第 `from` 段上那个 `if`/`case` 配对的收尾段。-1 = 配不上对（读不懂 ⇒ 放行）。 */
const branchEnd = (scan: Scan, from: number, open: string): number => scan.ends.get(`${open}@${from}`) ?? -1;

/** 第 `from` 段那个循环头的 `done` 落在哪一段（先找它的 `do`）。-1 = 配不上对。 */
function loopEnd(scan: Scan, from: number): number {
  const at = scan.doAt[from] ?? -1;
  return at < 0 ? -1 : scan.ends.get(`do@${at}`) ?? -1;
}

/** 第 `from`..`to` 段（含两头）里出现过这一类词吗（找 `break`/`exit` 这类出路用）。 */
function regionHas(scan: Scan, from: number, to: number, set: ReadonlySet<string>): boolean {
  const pre = scan.counts.get(set)!;
  return pre[Math.min(to + 1, scan.segs.length)]! - pre[from]! > 0;
}

/**
 * 这个循环:**循环体跑不跑得到**、**它自己会不会结束**。
 *
 * · `while true` / `until false` —— 恒真:循环体一定跑得到,而且没有 `break` 就永远不结束
 * · `for x in a b` —— 列表里有确定非空的字面词,循环体一定跑得到（循环本身会结束）
 * · 其余（`while cond`、`for f in *.log`、`for f in $LIST`、`for f`）—— 列表可能是空的、
 *   条件可能一上来就假,**循环体跑不跑得到答不出来** ⇒ 整区不扫
 */
function loopShape(head: string, tokens: Token[], from: number): { bodyRuns: boolean; endless: boolean } {
  const w1 = tokens[from + 1];
  const word = w1 && !w1.quoted ? w1.text : "";
  const endless = (head === "while" && TRUE_WORDS.has(word)) || (head === "until" && word === "false");
  if (endless) return { bodyRuns: true, endless: true };
  if (head === "for" || head === "select") {
    let at = -1;
    for (let k = from; k < tokens.length; k += 1) {
      const t = tokens[k]!;
      if (!t.quoted && t.text === "in") { at = k; break; }
    }
    let literal = false;
    for (let k = at + 1; at >= 0 && k < tokens.length; k += 1) {
      if (!/[*?[\]$~]/.test(tokens[k]!.text)) { literal = true; break; }
    }
    return { bodyRuns: literal, endless: false };
  }
  return { bodyRuns: false, endless: false };
}

/** 以 `<` 开头的词 = 输入重定向（`<f`、`<&3` 这些;here-doc 在更前面就整条放行了）。 */
const redirectsIn = (tokens: Token[]): boolean => tokens.some((t) => !t.quoted && t.text.startsWith("<"));

/**
 * 这个循环的**形状读得懂吗** —— 读得懂才轮到 `loopShape` 下结论（第 5 轮审查 F2）。
 *
 * 两道:
 *
 * ① **条件列表整条就是循环头那一段**。shell 的 `while`/`until` 条件是一个**列表**,真假由
 *    **最后一条**决定 —— `while true; false; do :; done` 的条件是 `false`,循环体一圈都不跑
 *    （审查实测:`/bin/sh` 退出 0 并打出 DONE,而创建闸 409;`until false; true` 同理）。
 *    上一版拿「这一段是用 `;` 收的」当成「条件说完了」,而分号恰恰是列表里两条命令之间的
 *    那个符号。所以判据改成**`do` 紧跟在它后面**:中间还有一段,就说明条件列表还有话。
 *    `&&`/`||`/`|`/`&` 收尾的那种也一并落在这一道里（`do` 不会紧跟在它后面）。
 *
 * ② **循环身上没挂输入重定向**。`while true; do :; done </不存在的文件` 整条循环一次都不跑
 *    （审查实测:shell 报一句文件不存在,随后照旧打出 DONE 并退出 0）。重定向是这个结构**能
 *    不能开始跑**的前置条件,而文件在不在这一层答不出来。
 *
 * 注意 ② 只管**挂在结构本身上的输入重定向**,不扩成「命令也可能启动失败」:那条路上任何命令
 * 都可能 127（二进制不在）,按那个标准什么都证明不出来、整个判据作废。输出重定向同样不在
 * 列 —— `tail -F x 2>/dev/null | grep ERROR` 正是这件事的起因命令,它照旧要拦。
 */
function loopReadable(scan: Scan, from: number, end: number): boolean {
  if (scan.doAt[from] !== from + 1) return false;
  return !redirectsIn(scan.segs[from]!.tokens) && !redirectsIn(scan.segs[end]!.tokens);
}

/**
 * 扫出**证明得出会跑**的那几条简单命令，对它们问 FOLLOWERS;顺带认恒真循环（见文件头 ③④）。
 *
 * 一条简单命令「证明得出会跑」要同时满足三件:
 *  ① 它不在任何**答不出哪几支会跑**的区里（`if`/`case` 的分支、条件未知的循环体、体里有
 *     `break`/`continue` 的循环体）
 *  ② 从上一个 `;`/换行 到它之间没有 `&&`/`||`（那两个要看前一条的退出码），而且前面没出现过
 *     `exit`/`exec`/`return`（那之后什么都证明不出来）
 *  ③ **它所在那一组自己也证明得出会跑**（见 `frames`）
 *
 * 读不懂的结构一律**放行**:配不上对的 `fi`、认不出的循环条件、`eval` 这种另一层执行 ——
 * 少拦几条 = 退回今天的行为；多拦一条 = 一件做得成的事做不成了（见文件头那段不对称）。
 */
function provableBlocker(scan: Scan): string | null {
  const segs = scan.segs;
  /**
   * 执行资格**按组分层**（第 4 轮审查 F2）。每进一组压一帧,帧里记着「这一组整体证明得出会
   * 跑吗」;`;`/换行 只能把资格恢复到**这一帧**的水平。
   *
   * 上一版 `reach` 是一个布尔,于是 `false && { printf x; tail -F /dev/null; }` 里:`&&` 把
   * 资格按掉,随后组内那个 `;` 又把它恢复成 true —— 整组被短路掉这件事当场丢了,组里的
   * `tail -F` 被当成顶层的照拦（实测 409,而 `/bin/sh` 打完 DONE 就退出 0;圆括号组同样）。
   */
  const frames: boolean[] = [true];
  const base = (): boolean => frames[frames.length - 1] ?? true;
  /** 正扫进去的那几层循环体各自的收尾段（`done` 落在哪一段）。跳转要靠它知道压到哪儿为止。 */
  const bodies: number[] = [];
  /** `break`/`continue` 压到哪一段为止。-1 = 没在压（见 `JUMPS`）。 */
  let suppressed = -1;
  // 「这一条证明得出会跑吗」。`&&`/`||` 把它按掉，下一个 `;`/换行 把它恢复到 `base()`。
  let reach = true;
  // 这条管道里扫到的跟随型。**等管道收尾才算数**:收尾符号是 `&` 的话它整条放后台，
  // shell 不等它 —— 那时这个判据作废（`tail -F x & printf done` 立刻就结束了）。
  let pipeline: string | null = null;
  /** 「这一条证明得出会跑吗」的最终答案:短路/组资格说会跑,而且没被跳转压着。 */
  const runs = (): boolean => reach && suppressed < 0;
  for (let i = 0; i < segs.length; i += 1) {
    // 出了循环体就收口:压制到这个区的收尾段为止（那一段上只有 `done` 这个词，没有命令）。
    while (bodies.length && i >= bodies[bodies.length - 1]!) bodies.pop();
    if (suppressed >= 0 && i >= suppressed) suppressed = -1;
    const tokens = segs[i]!.tokens;
    // 这一段读到第几个词了。**剥骨架靠挪它**（见 `commandOf` 的 `from`）;`at = tokens.length`
    // = 这一段没有剩下任何要判的简单命令（整区跳过去、或者已经判完）。
    let at = 0;
    for (;;) {
      const head = headOf(tokens, at);
      if (!head) break;
      const close = BRANCH[head];
      if (close) {
        // 分支区:整区不扫。区里有 `exit`/`exec` ⇒ 区后面的也证明不出来（那一支可能真的跑了）。
        const end = branchEnd(scan, i, head);
        if (end < 0) return pipeline;
        if (regionHas(scan, i, end, TERMINATORS)) return pipeline;
        i = end;
        at = tokens.length;
        break;
      }
      if (LOOP_HEADS.has(head)) {
        const end = loopEnd(scan, i);
        if (end < 0) return pipeline;
        // **读得懂才轮到下结论**（见 `loopReadable`）:条件列表、挂在循环身上的重定向,
        // 两样里有一样读不出来,这个循环跑不跑得到就答不出来 ⇒ 整区不扫。
        const { bodyRuns, endless } = loopReadable(scan, i, end)
          ? loopShape(head, tokens, at)
          : { bodyRuns: false, endless: false };
        if (!bodyRuns || !runs()) {
          if (regionHas(scan, i, end, TERMINATORS)) return pipeline;
          i = end;
          at = tokens.length;
          break;
        }
        // 恒真又没有出路 ⇒ 就是它。**但同样等收尾符号点头**:`( while :; do :; done ) & 干活`
        // 里这一组整个放了后台,shell 不等它 —— 所以这里只记下判定,跳到这个循环的收尾那一段,
        // 由它身上（或它所在那一组身上）的符号决定作不作数。
        if (endless && !regionHas(scan, i, end, ESCAPES)) {
          pipeline = "while true / until false";
          i = end;
          at = tokens.length;
          break;
        }
        // 剩下的是**循环体第一圈一定跑得到**的那种,扫进去（`for f in a b; do tail -F $f;
        // done` 第一圈就挂在那个 tail 上）。记下这个区的收尾段:体里的 `break`/`continue`
        // 要靠它知道「压到哪儿为止」（见 `JUMPS`）。
        bodies.push(end);
        at = tokens.length;
        break;
      }
      if (JUMPS.has(head)) {
        // **这一圈剩下那几条跑不到了**。压到这一层循环体的收尾段为止;带层数的（`break 2`）
        // 按最外那一层算 —— 跳得更远 ⇒ 压得更长 ⇒ 偏放行那一侧。
        if (!bodies.length) return pipeline;   // 循环外的跳转 ⇒ 读不懂就放行
        const deep = tokens.length - at > 1;
        suppressed = Math.max(suppressed, (deep ? bodies[0] : bodies[bodies.length - 1])!);
        at = tokens.length;
        break;
      }
      // 配不上对的 `fi`/`esac`:分支区一律是**整区跳过去**的（上面那一支），所以能走到这儿
      // 的只有读不懂的结构（多半根本不是合法的 shell）—— 读不懂就放行。
      if (head === "fi" || head === "esac") return pipeline;
      if (SKELETON.has(head)) { at += 1; continue; }
      if (head === "exit" || head === "return") return pipeline;
      break;
    }
    const cmd = at < tokens.length ? commandOf(tokens, at) : null;
    if (cmd && !cmd.bounded && runs()) {
      for (const f of FOLLOWERS) if (f.name === cmd.name && f.follows(cmd.argv)) { pipeline = f.what; break; }
    }
    // `exec cmd` 把本进程换成 cmd（`WRAPPERS` 已经让上面按 cmd 判过了）—— 它之后的都跑不到。
    if (cmd && headOf(tokens, at) === "exec") return pipeline;
    // 收尾符号决定下一条（见 `Sep`）。注意读的是 `segs[i]`:上面跳过整区时 `i` 已经挪到那个
    // 区的收尾段上,要的正是**那一段**的符号（`fi && tail -F x` 里的 tail 就证明不出会跑）。
    switch (segs[i]!.sep) {
      case "&": pipeline = null; reach = base(); break;         // 放后台 ⇒ 这一条判定作废
      case "&&": case "||": reach = false; break;
      case "|": break;                                          // 管道各级都会跑
      case "(": case "{": frames.push(reach); break;            // 进组:这一组的资格就是此刻的 reach
      // 组收口本身不决定任何事:作不作数由**收尾这一组**的那个符号说（它落在紧跟其后那个
      // 空段上）—— 于是 `( … ) &` 和 `( … );` 两种分得开。
      case ")": case "}": if (frames.length > 1) frames.pop(); reach = base(); break;
      default: {
        if (pipeline && frames.length === 1) return pipeline;
        reach = base();
      }
    }
  }
  // 组括号没配上对 ⇒ 这条命令在 shell 那边本来就是个语法错误,读不懂就放行。
  return frames.length === 1 ? pipeline : null;
}

/**
 * 这条命令**自己永远不会结束**吗。
 *
 * 返回那个判定它的写法（给拒绝文案用），不是的话返回 `null`。只回答形状，不回答意图 ——
 * 「永不退出」本身不是错，错的是**既永不退出、又没有任何别的结束条件**。
 */
export function neverExitsOnItsOwn(command: string): string | null {
  // **读不出执行资格的结构 ⇒ 整条命令放行**（见文件头 ②）。here-doc 的终止词、函数体到底
  // 调没调过，这一层都只能猜；猜错的那一半代价是「一件做得成的事做不成」。
  const plain = blankComments(blankQuoted(command));
  if (HERE_DOC.test(plain) || FUNC_DEF.test(plain)) return null;
  return provableBlocker(scanOf(segments(command)));
}
