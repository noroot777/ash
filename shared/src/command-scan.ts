// **这几段读成了什么形状** —— 分支区、循环区、跳转、以及「这一条/这一组开不开得起来」。
//
// 从 command-never-exits.ts 拆出来（单文件 700 行的约定）。这一层只回答**形状**:哪几段是一个
// `if` 区、它的 `done` 落在哪一段、这个循环头的条件读不读得懂、挂在它身上的重定向打不打得开。
// 「所以拦不拦」不在这儿 —— 那是隔壁那一个文件按这些形状组合出来的结论（`provableBlocker`）。
//
// 分层:词法（command-lex.ts）→ 包装（command-wrappers.ts）→ 工具目录（command-followers.ts）
// → **结构扫描（这里）** → 判断（command-never-exits.ts）。往这边加东西的判据是「它只认 shell
// 自己的结构,不认任何具体工具」。
//
// 不对称的代价跟那边同一份:**读不出来的形状一律往「不拦」那一侧冒**（见 command-never-exits.ts
// 文件头）—— 所以这边的函数在答不出来时返回 -1 / false,而不是猜一个。
import { redirectsOf, type Segment, type Token } from "./command-lex.ts";

/**
 * 分支结构:开它的词 → 关它的词。**整区不扫** —— 哪几支会跑是运行时的事。
 *
 * 跟 `CLOSERS`、command-wrappers.ts 的 `WRAPPERS` 一样用 Map:这几张表的键全都来自命令里的
 * 字,**普通对象会把 `Object.prototype` 上的同名成员一起算进来**（第 2 轮审查 F1 —— 那一条是
 * 在 `WRAPPERS` 上炸的,但这几张表是同一类入口,所以一起钉住）。
 */
export const BRANCH = new Map<string, string>([["if", "fi"], ["case", "esac"]]);
/** 循环头。`do … done` 之间是循环体,它跑不跑得到另算（见 `loopShape`）。 */
export const LOOP_HEADS = new Set(["while", "until", "for", "select"]);
/** 结构骨架:这些词不是命令词,剥掉之后那一段才是真正的简单命令（`then tail -F x`）。 */
export const SKELETON = new Set(["then", "else", "elif", "do", "done", "fi", "esac", "in", "!"]);
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
export const TERMINATORS = new Set(["exit", "exec", "return"]);
/**
 * 恒真循环的**出路**。循环体里有它们，那个循环就不是「没有出路」。
 *
 * `exec` 在列（第 4 轮审查 F2）:`while true; do exec printf 'DONE\n'; done` 把本进程整个换
 * 成了那个 printf —— 这个循环连第二圈都没有（实测 409,而 `/bin/sh` 打完 DONE 就退出 0）。
 * `continue` **不在**列:它是回到循环开头,不是出路。
 */
export const ESCAPES = new Set(["break", "exit", "return", "exec"]);
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
export const JUMPS = new Set(["break", "continue"]);
/** `while` 的恒真条件。`until` 的那一边是 `false`。 */
const TRUE_WORDS = new Set(["true", ":"]);

/** 这一段**从 `from` 起**那个词（引号里的永远不算）。没有就是空串。 */
export function headOf(tokens: Token[], from = 0): string {
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
export type Scan = {
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

export function scanOf(segs: Segment[]): Scan {
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
export const branchEnd = (scan: Scan, from: number, open: string): number => scan.ends.get(`${open}@${from}`) ?? -1;

/** 第 `from` 段那个循环头的 `done` 落在哪一段（先找它的 `do`）。-1 = 配不上对。 */
export function loopEnd(scan: Scan, from: number): number {
  const at = scan.doAt[from] ?? -1;
  return at < 0 ? -1 : scan.ends.get(`do@${at}`) ?? -1;
}

/** 第 `from`..`to` 段（含两头）里出现过这一类词吗（找 `break`/`exit` 这类出路用）。 */
export function regionHas(scan: Scan, from: number, to: number, set: ReadonlySet<string>): boolean {
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
export function loopShape(head: string, tokens: Token[], from: number): { bodyRuns: boolean; endless: boolean } {
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
export function startProvable(tokens: Token[]): boolean {
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
export function loopReadable(scan: Scan, from: number, end: number): boolean {
  if (scan.doAt[from] !== from + 1) return false;
  return startProvable(scan.segs[from]!.tokens) && startProvable(scan.segs[end]!.tokens);
}
