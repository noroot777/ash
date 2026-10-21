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
// ⑤ **每一层「我不知道」都要往上冒成「不拦」,不许由下一层替它断定「它跑了」**（第 3 轮
//    审查 F1）。④把作用域补齐了,可三层各自还留着一处「答不出来却照旧往下说」—— 于是四种
//    会自己结束的命令被 409（审查实测,全部 `/bin/sh` 退出 0 并打出结果）:
//      · `command -v tail -F /dev/null; printf 'DONE\n'` —— 包装命令的开关一律跳过,于是
//        一次**查路径**被读成了一次执行（`command -v` 打一行路径就退）
//      · `printf "literal \"; tail -F /dev/null; #\n"` —— 词法层把双引号里的转义引号当成
//        收口,**字符串正文**被读成了结构和执行节点
//      · `while true; do :; done > 不存在的目录/out` —— 重定向只认了 `<`,而输出重定向打不
//        开时这个循环同样一圈都不跑
//      · `tail -F /dev/null < 不存在的文件` —— 重定向这一道只盖了循环和分组,简单命令自己
//        身上那个没人问
//    补的都不是「再排除一种写法」:包装命令改成**只认已知透明的开关**（command-wrappers.ts
//    的 `WRAPPERS`）、引号收口改成**认转义**（command-lex.ts 的 `quoteEnd`）、重定向改成
//    **证明得出打得开**
//    （`startProvable`,循环/分组/简单命令三个作用域共用一份）。方向是同一个:**支持得了的
//    词法和执行模式才配产出一个硬拦的结论**,任一层答不出来就往上冒成「不拦」。
//
// ⑥ **「证明得出会跑」要对**整个形状**成立,不是对它的每一项分别成立**（第 2 轮审查 F2）。
//    ⑤把三层的「我不知道」都往上冒了,可每一层内部还是逐项各看一眼,于是六种会自己结束的
//    命令照旧被 409（审查实测,全部退出 0 并打出 DONE）:
//      · `tail -F /dev/null 1>&- 2>&1` —— 两项单看都安全,连起来是「从一个已经关掉的描述符
//        复制」(循环、分组两个作用域同样);判据改成**带描述符状态按顺序走一遍**
//      · `env -C 不存在的目录 tail -F x`、`nice -n not-a-number tail -F x` —— 包装命令的
//        开关**值**本身就是启动前提;白名单里那几个吃值的开关连**值的形状**一起认,证明不出
//        来的（`sudo` 的认证、`env -C` 的目录）整个不收
//      · `tail -F -n not-a-number /dev/null` —— 跟随型只找了那个跟随开关,没问同一条 argv
//        里**别的参数会不会让它根本没开始跟随**;跟随型目录改成「这条 argv 全认得出来才算」
//    方向还是⑤那一个,只是作用域从「一项」提到「整个形状」:**支持得了的组合才配产出一个硬拦
//    的结论**,任一处连不起来就往上冒成「不拦」。
//
// ⑦ **「整条命令」还包括 shell 自己的开关和那条命令盯的是谁**（第 1 轮审查 F1）。⑥把每一层
//    内部的组合补齐了,可执行语义还少两块,于是三种会自己结束的命令照旧被 409（审查实测）：
//      · `printf 'DONE\n' | tail -f`、`printf 'DONE\n' | tail -F` —— 不带文件操作数的
//        `tail -f` 盯的是**标准输入**,管道读到 EOF 就退（几毫秒,退出 0 并打出 DONE;BSD tail
//        干脆把 `-f` 忽略掉）。而「管道那头是什么」不写在命令文本里。
//      · `set -e; false; tail -F /dev/null` —— 那个 tail **一次都没跑**（实测退出 1）。
//        `set -e` 的意思就是「`;` 当 `&&` 用」:前一条退出码非零,shell 当场走人。
//    补的两处:可达性记进 `set -e`（`errexitAt`，`;`/换行一律按短路算）,跟随型目录改成
//    「**它盯的那个东西得写在 argv 里**」（command-followers.ts 文件头 ③）。
//
//    ①–⑦ 合起来是同一条不变量:**硬拦只用「盖得住整条命令必要执行与退出语义」的那种证明**
//    —— 执行资格（这一条跑不跑得到）、argv（它到底有没有开始跟随）、输入来源（它盯的是谁）、
//    shell 状态（前面那条的退出码管不管得着它），任一项读不出来**就不是硬拦的依据**,降级成
//    一句可提交的提示。不按网页、HTTP、hook 各补一个特例:这三处共用的就是这一个函数。
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

// **词法层在隔壁**(command-lex.ts,单文件 700 行的约定):分词、分段、引号骨架、抹注释。
// 这个文件只收它的结果 —— 「每个字符在不在引号外」这件事由那边负责记下来(见 `Token.bare`)。
import {
  blankComments, blankQuoted, redirectsOf, segments,
  type Segment, type Token,
} from "./command-lex.ts";
import { followerOf } from "./command-followers.ts";
import { commandOf } from "./command-wrappers.ts";

// **另外两张表在隔壁**（单文件 700 行的约定）:哪些命令的语义是「盯着不走」、它们的 argv 读不
// 读得懂,归 command-followers.ts（见 `followerOf`）;哪些词只是包一层、剥掉它们之后真正要跑的
// 是谁,归 command-wrappers.ts（见 `commandOf`）。这边只按它们的判据组合,不认具体的工具。


/**
 * 函数定义:`name() {` / `function name {`。**定义这一刻函数体一个字都不跑**,而「后面到底
 * 调没调过它」这一层答不出来 —— 答不出来就不拦（第 2 轮审查 F3 实测:一个从未被调用的
 * `later() { tail -F /dev/null; }` 把整条命令拦掉了）。
 */
const FUNC_DEF = /(?:^|[;&|\n])\s*(?:function\s+)?[A-Za-z_][A-Za-z0-9_-]*\s*(?:\(\s*\)\s*[{(]|\{)/;
/** here-doc / here-string:`<<EOF` 到终止词之间是**数据**,不是执行节点。 */
const HERE_DOC = /<</;

/**
 * 分支结构:开它的词 → 关它的词。**整区不扫** —— 哪几支会跑是运行时的事。
 *
 * 跟 `CLOSERS`、command-wrappers.ts 的 `WRAPPERS` 一样用 Map:这几张表的键全都来自命令里的
 * 字,**普通对象会把 `Object.prototype` 上的同名成员一起算进来**（第 2 轮审查 F1 —— 那一条是
 * 在 `WRAPPERS` 上炸的,但这几张表是同一类入口,所以一起钉住）。
 */
const BRANCH = new Map<string, string>([["if", "fi"], ["case", "esac"]]);
/** 循环头。`do … done` 之间是循环体,它跑不跑得到另算（见 `loopShape`）。 */
const LOOP_HEADS = new Set(["while", "until", "for", "select"]);
/** 结构骨架:这些词不是命令词,剥掉之后那一段才是真正的简单命令（`then tail -F x`）。 */
const SKELETON = new Set(["then", "else", "elif", "do", "done", "fi", "esac", "in", "!"]);
/** 关键字只在**命令词位置**才算关键字（`grep -n fi src` 里那个 `fi` 是参数）。 */
const KEYWORDS = new Set([...BRANCH.keys(), ...LOOP_HEADS, ...SKELETON]);
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
  /**
   * 第 `i` 段**被一个「开不开得起来答不出来」的组包着**吗（`{ … } <f`、`( … ) >f`）。
   *
   * 重定向可以挂在**包着循环的那一组**身上,而不是循环自己身上 —— 那时整组一次都不开始跑
   * （实测:`{ while true; do :; done; } </不存在; printf DONE` 退出 0 并打出 DONE,圆括号
   * 组同样）。组收口把段切断了,所以那个重定向落在**收口后紧跟的那一段**上,循环自己的
   * 两段上一个字都看不到它。判据跟另外两个作用域同一份,见 `startProvable`。
   */
  groupRedirect: Uint8Array;
};

/** 关它的词 → 开它的词。这三对都**只认命令词位置**（`grep -n fi src` 里那个 `fi` 是参数）。 */
const CLOSERS = new Map<string, string>([["fi", "if"], ["esac", "case"], ["done", "do"]]);
const COUNTED: readonly ReadonlySet<string>[] = [TERMINATORS, ESCAPES, JUMPS];

function scanOf(segs: Segment[]): Scan {
  const n = segs.length;
  const ends = new Map<string, number>();
  const open: Record<string, number[]> = { if: [], case: [], do: [] };
  const doAt = new Int32Array(n + 1).fill(-1);
  const counts = new Map<ReadonlySet<string>, Int32Array>(COUNTED.map((set) => [set, new Int32Array(n + 1)]));
  // 组身上那个重定向:按**差分**记区间,最后一次前缀和推平(嵌套多深都只过一遍,见文件头
  // 那段关于工作量的话)。栈里压的是开组那一段的段号。
  const groupDiff = new Int32Array(n + 2);
  const groups: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const sep = segs[i]!.sep;
    if (sep === "(" || sep === "{") groups.push(i);
    else if (sep === ")" || sep === "}") {
      const from = groups.pop();
      // 配不上对的收口不管:读不懂 ⇒ 放行那一侧由别处负责。
      // 收口段的**下一段**才是重定向的落点(`} <f` 里 `}` 把段切断了)。
      if (from !== undefined && !startProvable(segs[i + 1]?.tokens ?? [])) {
        groupDiff[from]! += 1;
        groupDiff[i + 1]! -= 1;
      }
    }
  }
  const groupRedirect = new Uint8Array(n + 1);
  let depth = 0;
  for (let i = 0; i < n; i += 1) {
    depth += groupDiff[i]!;
    groupRedirect[i] = depth > 0 ? 1 : 0;
  }
  for (let i = 0; i < n; i += 1) {
    for (const w of headKeywords(segs[i]!.tokens)) {
      open[w]?.push(i);
      const opener = CLOSERS.get(w);
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
  return { segs, ends, doAt, counts, groupRedirect };
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

/**
 * 这个东西（一条简单命令 / 一个循环 / 一个分组）**证明得出开始跑了**吗 —— 单问重定向这一关。
 *
 * 重定向是**能不能开始跑**的前置条件:打不开那一个,shell 报一句错,被它挂着的那条命令、
 * 那个循环、那一整组**一个字都不会跑**,而整条命令照旧往下走、正常退出。所以判据是
 * 「挂在它身上的每一个重定向都证明得出打得开」,而不是「有没有写重定向」。
 *
 * **要按顺序、带着描述符状态走一遍,不是逐项各看一眼**（第 2 轮审查 F2）。上一版是
 * `every(单项证明)`,于是 `tail -F /dev/null 1>&- 2>&1` 被硬拦:「关掉 1」一定成功、「从 1
 * 复制」看上去也安全,可**连起来**第二项就是从一个已经关掉的描述符复制 —— shell 报
 * Bad file descriptor,那条 tail 一次都没跑（实测退出 0 并打出 DONE;循环和分组两个作用域
 * 同样）。所以这里维护一份「这会儿哪些描述符是开着的」,从 shell 给的 0/1/2 起步,逐个应用。
 *
 * 一项证明得出打得开,只有三种:
 *  · 目标就是 `/dev/null` —— 它在任何 POSIX 系统上都在、都打得开
 *  · `<&N` / `>&N` 复制一个**此刻确实开着**的描述符（它可能是 0/1/2,也可能是前面某一项刚打
 *    开的 3、4……）
 *  · `<&-` / `>&-` 关掉一个描述符 —— 这件事不会失败（关掉之后那一位就不再开着）
 *
 * 其余一律算**证明不出来**:任何路径（存不存在、父目录有没有、写不写得进去这一层答不出来）、
 * 任何 `$VAR` / `$( )`（这一层根本不知道它会展开成什么）。here-doc 更早就整条放行了。
 *
 * **三个作用域共用这一道**（第 3 轮审查 F1）。上一版只问「有没有引号外的 `<`」,于是三处各
 * 漏一半（全部实测 `/bin/sh` 退出 0 并打出 DONE,而创建闸 409）:
 *  · 输出重定向整个不在列 —— `while true; do :; done > 不存在的目录/out` 一圈都不跑
 *  · 简单命令整个不在列 —— `tail -F /dev/null < 不存在的文件` 一次都不跑
 *  · 反过来,`</dev/null`、`2>&1` 这种**明摆着打得开**的被算成了「读不懂」而白白放行
 * 倒过来之后这三件事是同一个判据的三个落点,不是三个特例。
 *
 * 代价明写在这儿:`tail -F x >> out.log` 这种「重定向其实会成功」的真阳跟着放掉了 —— 路径
 * 在不在这一层答不出来,而误判的代价不对称（见文件头）。哨兵的事件本来就是从 stdout 收的,
 * 把 stdout 重定向进文件的写法本身就跟挂哨兵相冲,所以这笔代价很小。
 *
 * **不扩成「命令自己也可能启动不了」**:那条路上任何命令都可能 127（二进制不在）,按那个
 * 标准什么都证明不出来、整个判据作废。这里认的始终是**写在结构上的运算符**。
 */
function startProvable(tokens: Token[]): boolean {
  // shell 交给一条命令的时候 0/1/2 一定是开着的（哨兵这边三个都是管道）。
  const open = new Set([0, 1, 2]);
  for (const { op, fd, target } of redirectsOf(tokens)) {
    if (op === "<&" || op === ">&") {
      if (target === "-") { open.delete(fd); continue; }
      if (!/^\d+$/.test(target) || !open.has(Number(target))) return false;
      open.add(fd);
      continue;
    }
    if (op.startsWith("<<") || target !== "/dev/null") return false;
    open.add(fd);
  }
  return true;
}

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
 * ② **循环身上挂的重定向证明得出打得开**。`while true; do :; done </不存在的文件` 整条循环
 *    一次都不跑（审查实测:shell 报一句文件不存在,随后照旧打出 DONE 并退出 0）;`> 不存在的
 *    目录/out` 同样（第 3 轮审查 F1）。重定向是这个结构**能不能开始跑**的前置条件 —— 判据、
 *    代价和另外两个作用域一字同源,见 `startProvable`。
 *
 * 挂在**包着它的那一组**身上的那种不在这儿答:那时整组(连里面的跟随型命令一起)都可能一次
 * 都不开始跑,所以它归「这一条证明得出会跑吗」那一层 —— 见 `Scan.groupRedirect` 和 `runs`。
 */
function loopReadable(scan: Scan, from: number, end: number): boolean {
  if (scan.doAt[from] !== from + 1) return false;
  return startProvable(scan.segs[from]!.tokens) && startProvable(scan.segs[end]!.tokens);
}

/**
 * `set -e`（含 `set -eu`、`set -o errexit`）**出现在第几段** —— 没出现就是 -1（见文件头 ⑦）。
 *
 * 开了它之后 `;`/换行 的意思跟 `&&` 一样,所以这个下标往后的每一条都要先证明得出「前一条
 * 成功了」才算跑得到 —— 而那是退出码,这一层答不出来。
 *
 * 这一道**只往「不拦」那一侧偏**,所以认得宽:不解析 `set` 的语义,只问「这一段里有没有一个
 * 没被引号括起来的 `set`、它后面跟着一个带 e 的短开关或者 `-o errexit`」。认宽了（`rg set -e
 * foo` 这种把 `set` 当参数的也算上）只会让后面几条从「证明得出会跑」变成「答不出来」;而漏了
 * 一种写法 = 退回今天的行为。分支/循环体里的那个也照算（那几区本来整区不扫,`i` 已经挪过
 * 它们,于是闸从区尾那一段起生效）。
 */
function errexitAt(segs: Segment[]): number {
  for (let i = 0; i < segs.length; i += 1) {
    const words = segs[i]!.tokens.filter((t) => !t.quoted).map((t) => t.text);
    const from = words.indexOf("set");
    if (from < 0) continue;
    const rest = words.slice(from + 1);
    const on = rest.some((w, k) => /^-[a-z]*e[a-z]*$/.test(w) || (w === "-o" && rest[k + 1] === "errexit"));
    if (on) return i;
  }
  return -1;
}

/**
 * 扫出**证明得出会跑**的那几条简单命令，对它们问跟随型;顺带认恒真循环（见文件头 ③④）。
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
  /** `set -e` 从第几段起生效（见 `errexitAt`）。-1 = 这条命令里没开。 */
  const errexit = errexitAt(segs);
  // 「这一条证明得出会跑吗」。`&&`/`||` 把它按掉，下一个 `;`/换行 把它恢复到 `base()`。
  let reach = true;
  // 这条管道里扫到的跟随型。**等管道收尾才算数**:收尾符号是 `&` 的话它整条放后台，
  // shell 不等它 —— 那时这个判据作废（`tail -F x & printf done` 立刻就结束了）。
  let pipeline: string | null = null;
  /**
   * 「这一条证明得出会跑吗」的最终答案:短路/组资格说会跑、没被跳转压着,而且**它所在的组
   * 证明得出开得起来**（`scan.groupRedirect`,第 2 轮审查 F2 的同类作用域)。
   *
   * 最后这一条跟 `loopReadable` 的 ② 是同一件事的两个作用域,但归在这里而不是那边:重定向
   * 挂在组上时,一次都不开始跑的**不只是循环** —— `{ tail -F x; } </不存在的文件` 里那个
   * 跟随型命令同样一个字都没跑（实测退出 0 并打出 DONE)。
   *
   * **这一段只管「组」这个作用域**:挂在那一条简单命令自己身上的重定向由下面那个
   * `startProvable(tokens)` 答（第 3 轮审查 F1）—— `tail -F x </不存在的文件` 里组资格是满的,
   * 不跑的是它自己。
   */
  const runs = (at: number): boolean => reach && suppressed < 0 && !scan.groupRedirect[at];
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
      const close = BRANCH.get(head);
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
        if (!bodyRuns || !runs(i)) {
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
    // **挂在这条简单命令自己身上的重定向也是「它开不开得起来」**（第 3 轮审查 F1 实测:
    // `tail -F /dev/null < 不存在的文件; printf DONE` 退出 0 并打出 DONE,而创建闸 409）。
    // 判据跟循环、分组那两个作用域同一份（`startProvable`）:`2>/dev/null`、`2>&1` 这种
    // 明摆着打得开的照旧算它跑了 —— 事故的起因命令正是那种,它必须照拦。
    if (cmd && !cmd.bounded && runs(i) && startProvable(tokens)) {
      pipeline = followerOf(cmd.name, cmd.argv) ?? pipeline;
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
        // **`set -e` 之后,`;` 的意思跟 `&&` 一样**（见文件头 ⑦）:前一条退出码非零时 shell
        // 当场就走了,后面那几条一个都跑不到 —— `set -e; false; tail -F /dev/null` 实测退出 1,
        // 那个 tail 从没启动过。`set` 自己那一段不受这道闸管:它是个一定成功的内建,拿它当
        // 「前一条可能失败」会把 `set -e; tail -F x` 也放过去（那个 tail 确实会跑）。
        reach = errexit >= 0 && i >= errexit && cmd?.name !== "set" ? false : base();
      }
    }
  }
  // 组括号没配上对 ⇒ 这条命令在 shell 那边本来就是个语法错误,读不懂就放行。
  return frames.length === 1 ? pipeline : null;
}

function judge(command: string): string | null {
  // **读不出执行资格的结构 ⇒ 整条命令放行**（见文件头 ②）。here-doc 的终止词、函数体到底
  // 调没调过，这一层都只能猜；猜错的那一半代价是「一件做得成的事做不成」。
  const plain = blankComments(blankQuoted(command));
  if (HERE_DOC.test(plain) || FUNC_DEF.test(plain)) return null;
  return provableBlocker(scanOf(segments(command)));
}

/**
 * 这条命令**自己永远不会结束**吗。
 *
 * 返回那个判定它的写法（给拒绝文案用），不是的话返回 `null`。只回答形状，不回答意图 ——
 * 「永不退出」本身不是错，错的是**既永不退出、又没有任何别的结束条件**。
 *
 * **对任意字符串都是全函数:它只会回答,不会抛**（第 2 轮审查 F1）。调用它的两处都受不起一个
 * 异常:表单在**每次渲染**里同步调用它（判据一抛,整棵组件树卸载 —— 审查实测页面变成空白),
 * 创建入口在起进程之前调用它（判据一抛,真实路由 500）。而「这条命令读不懂」本来就有一个
 * 确定的答案:**不拦**。所以这一层把异常也归到那个答案里,同时把它吼到日志里 —— 判据自己
 * 有 bug 要能被发现,只是不该由用户那一侧用「做不成事」来承担（见文件头那段不对称）。
 */
export function neverExitsOnItsOwn(command: string): string | null {
  try {
    return judge(command);
  } catch (err) {
    console.error(`[ash] 命令结构判据出错,这条命令按「读不懂」放行：${String(err)}`);
    return null;
  }
}
