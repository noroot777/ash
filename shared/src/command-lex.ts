// shell 的**词法层**:把一条命令切成「词」和「简单命令 + 收尾它的那个符号」。
//
// 从 command-never-exits.ts 拆出来(单文件 700 行的约定)。拆的是**两种问题**:这边只答
// 「这串字符按 shell 的规矩分成哪些词、哪些段,每个字符是在引号里还是引号外」;那边答
// 「这些段里有没有一条证明得出会跑、而且证明得出永不结束」。
//
// 之所以值得单独一层:几轮审查里栽的跟头有一半在这儿 —— 引号里的 `exit` 被当成执行节点、
// 注释里的函数定义被当成结构、`<'路径'` 里的运算符被整词一个 quoted 布尔抹平。**词法答错,
// 上面那层再怎么推理都是错的**,所以它的不变量写在这个文件里,跟判据分开钉。

/**
 * 一个词。
 *
 * `text` = 它的字面值(引号已经拆掉、转义已经解开、`$( )` 占位成 `?`)。
 * `quoted` = 这个词里**有过**引号 —— 用来回答「它还算不算命令词 / 关键字」。
 * `bare` = 跟 `text` 等长的**骨架**:凡是从引号里、或者被反斜杠转义过来的字符一律记成 `\0`。
 *
 * 为什么要第三个字段(第 2 轮审查 F2):`quoted` 是**整词**一个布尔,于是「运算符在引号外、
 * 只有路径在引号里」这件事当场丢掉 —— `<'/不存在的文件'` 整词被标成 quoted,看上去就跟
 * 一个普通参数没区别。而运算符在不在引号里,决定的恰恰是它**是不是运算符**:`<f` 是重定向,
 * `'<'f` 只是个叫 `<f` 的参数。按字符记下来之后,这两件事就分得开了(见 `redirectsIn`)。
 */
export type Token = {
  text: string;
  quoted: boolean;
  bare: string;
  /**
   * 这个词里出现过**展开**（`$NAME` / `${…}` / `$( )` / `$(( ))` / 反引号）—— 它的值要等执行
   * 时才定下来。
   *
   * 为什么标记非得落在这一层（第 4 轮审查 F3）:展开被**按设计抹成占位符** `?`，而占位符跟用户
   * 自己打的一个 `?` 长得一模一样 —— 于是「这里本来有个读不出来的东西」这件事在词法层就丢了，
   * 上面那层再拿 `text` 去正则怎么写都找不回来。实测被硬拦的三条（真 shell 全都自己结束）:
   *   · `: $((1/0)); while true; do :; done` —— 算术展开除零，127，循环一次都没跑;
   *   · `: ${1:?required}; while true; do :; done` —— `${` 当年被当成**分段符**，整个展开被切碎;
   *   · `read PATH; tail -F /dev/null; printf 'DONE\n'` —— 见 command-perturbation.ts 的 argv 证明。
   * 双引号里的展开照样算（`"$(…)"` 在 shell 里真的会执行），单引号里的不算（那是字面量）。
   */
  expanded?: true;
  /** …而且那是**命令替换**（`$( )` / 反引号）:括号里是另一层这一层读不进去的执行。 */
  substitution?: true;
  /** …而且那是**算术展开**（`$(( ))`）:算术自己就能让 shell 当场出错走人（`$((1/0))` 实测 127）。 */
  arithmetic?: true;
  /** …而且那是**自带退出语义的展开**（`${X?w}` / `${X:?w}`）:X 没定义时 shell 在这一处就走人。 */
  errorForm?: true;
  /**
   * 这个词里有一处 `$` 开头的形式**这一层没有正面识别**（第 1 轮审查 F2 实测）。
   *
   * 上一版的默认值是反的:枚举过的几种打标，其余一律不打标 —— 于是一个没见过的展开形式
   * (`$[1/0]`，bash 的旧式算术）一个标记都没有，判据层拿不到任何「这里有读不懂的东西」的
   * 信号，`: $[1/0]; while true; do :; done` 照旧吃硬拦，而真 shell 里它当场除零退 127。
   * 再加一条黑名单只修得掉这一个输入；把默认值翻过来（见 `dollarForm`）才修得掉这一类。
   */
  unknownForm?: true;
};

/** 一个词里可能带上来的那几种展开标记。 */
export type ExpansionMarks = Pick<Token, "expanded" | "substitution" | "arithmetic" | "errorForm" | "unknownForm">;

/** 扫一段文本的结果:带上来的标记 + **有没有哪个结构在这段里没收口**(见 `Lexed.unclosed`)。 */
type TextScan = { marks: ExpansionMarks; unclosed: string | null };

/** POSIX 参数展开的**参数名**（`${name}` / `${name:-字}` …）。只有它赋得上值,见 parameterForm。 */
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** 位置参数与特殊参数（`${1}` / `${@}` / `${#}` / `${?}` / `${!}` / `${$}` / `${-}`）。 */
const SPECIAL_PARAM = /^(?:[0-9]+|[-@*#?!$])$/;
const isParam = (text: string) => PARAM_NAME.test(text) || SPECIAL_PARAM.test(text);

/**
 * `${…}` 里那个参数展开是**哪一种**。收的是 `inner` —— 去掉 `${` 和 `}` 之后的中间那段。
 *
 * **这张表是封闭的**（第 1 轮审查 F1）:上一版只认 `${参数?字}` / `${参数:?字}` 一种,其余
 * 一律不打标 —— 于是「这一层没正面证明过的参数形式」和「证明得出没有退出语义的参数形式」
 * 在判据面前长得一模一样,凭空获得硬拦资格。实测被硬拦的三条(真 shell 全都自己结束、
 * `signal=null`、`tail` 一次都没跑到):
 *   · `: ${1:=default}; tail -F /dev/null; printf DONE` —— `$1: cannot assign in this way`,退 1;
 *   · `: "${value!}"; …` / `: ${value@Q}; …` —— `bad substitution`,退 1。
 * 再加 `${1:=…}`、`${…!}` 两条黑名单只修得掉这三个输入;把默认值翻成「证明不了就是未知」
 * 才修得掉这一类(同 `dollarForm` 那一道的形状)。
 *
 *  · `"error"` —— 这个展开**自己就能让 shell 当场走人**:`?` 两种(变量没定义,POSIX)、以及
 *    往位置参数/特殊参数上赋值(`${1:=v}`,实测当场报错退出)。两者都是「这条命令会自己结束」
 *    的正面证据,所以同一个标记(`Token.errorForm`)。
 *  · `"proved"` —— POSIX 列过的那几种:`${param}`、`${#param}`、`:-` `-` `:+` `+` `:=` `=`
 *    (赋值那两种只在参数是名字时才算)、`#` `##` `%` `%%`。**字**那一半是文本,里面套的展开
 *    由 `expansionsInText` 自己扫,不在这一层判。
 *  · `"unknown"` —— 其余一切:bash 的 `${X@Q}`、`${X!}`、`${!X}`、`${X/a/b}`、`${X:1:2}`、
 *    `${X^^}`、数组下标,以及空的 `${}`。它们的语义随 shell 而变(`@Q` 要 bash 4.4、本机
 *    /bin/sh 是 bash 3.2 ⇒ bad substitution),这一层读不懂就不许替它背书。
 */
export function parameterForm(inner: string): "error" | "proved" | "unknown" {
  if (isParam(inner)) return "proved";                                   // ${name} ${1} ${@} ${#} …
  if (inner.startsWith("#") && isParam(inner.slice(1))) return "proved"; // ${#name} ${#1} ${#@}
  const split = /^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[-@*#?!$])([\s\S]+)$/.exec(inner);
  if (!split) return "unknown";                                          // 空的 ${}、参数名就不合法的
  const [, param = "", rest = ""] = split;
  if (/^:?\?/.test(rest)) return "error";                                // ${X?字} / ${X:?字}
  // 赋值:**只有名字赋得上**。位置参数和特殊参数一律当场报错走人(POSIX 说它 unspecified,
  // dash/bash 实测都是 `cannot assign in this way` + 立刻退出)—— 那也是一种退出语义。
  if (/^:?=/.test(rest)) return PARAM_NAME.test(param) ? "proved" : "error";
  if (/^(?::[-+]|[-+])/.test(rest)) return "proved";                     // 默认值 / 替代值
  if (/^(?:##?|%%?)/.test(rest)) return "proved";                        // 模式剥除
  return "unknown";
}

/** `$` 后面出现这些字符才算一个**值展开**的开头（`$NAME` / `$1` / `$@` / `$?` …）。 */
const EXPANSION_START = /[A-Za-z_0-9@*#?!$-]/;

/**
 * `$` 后面跟这些字符时它只是个**普通的美元号** —— POSIX:`$` 后面不是能起一个展开的字符，
 * 它就是字面值（`$ ` / 行尾的 `$` / `cost=$:` 都是这一种）。
 *
 * 这是一张**字面值白名单**,不是「可疑形式黑名单」:默认值是「读不懂」（见 `dollarForm`）。
 */
const LITERAL_AFTER_DOLLAR = /[\s)\]};&|<>=,.:/+%^~`\\]/;

/**
 * `$` 后面那一个（或两个）字符决定这是哪一种形式。**这张表是封闭的**:不在上面任何一种
 * 里的形式一律 `unknown`（第 1 轮审查 F2）。
 *
 *   · `substitution` / `arithmetic` —— `$( )` / `$(( ))`:里面是另一层执行 / 算术自己会出错走人;
 *   · `parameter` —— `${…}`:按 `parameterForm` 再分「自带退出语义 / 证明过 / 未知」三种;
 *   · `value` —— `$NAME` / `$1` / `$@` …:值要等执行时才定下来;
 *   · `literal` —— 上面那张白名单:这个 `$` 什么都不做;
 *   · `unknown` —— **其余一切**。`$[1/0]`（bash 旧式算术，实测除零退 127）、`$'…'`（ANSI-C
 *     引用）、`$"…"`（locale 翻译）都落在这儿:它们的语义随 shell 而变，这一层读不懂,
 *     所以它要往上冒成「证明不了」,而不是悄悄算成「没什么可担心的」。
 *
 * 两处扫描共用这一个函数:词法主循环和 `expansionsInText`（双引号里 / `${…}` 里套的那层）。
 * **别抄第二份** —— F2 的形状正是「同一件事两处各自枚举」。
 */
export function dollarForm(next: string | undefined, after?: string | undefined): "substitution" | "arithmetic" | "parameter" | "value" | "literal" | "unknown" {
  if (next === undefined || LITERAL_AFTER_DOLLAR.test(next)) return "literal";
  if (next === "(") return after === "(" ? "arithmetic" : "substitution";
  if (next === "{") return "parameter";
  if (EXPANSION_START.test(next)) return "value";
  return "unknown";
}

/**
 * 这段**文本**里有没有展开、是哪几种。
 *
 * 两处都用它,因为两处都只剩「扫文本」一条路:
 *  · 双引号里的内容原样进 `text`（引号里的展开在 shell 里真的会执行）;
 *  · 不带引号的 `${…}` 被整段抹成占位符 `?` 之前,**里面还套着别的展开**（第 2 轮审查第 2 条:
 *    `: ${X:-$((1/0))}` 真 shell 里除零退 127,而上一版只问了最外层是不是 error form,内层那个
 *    算术在词法层就没了,于是一条自己会结束的命令被硬拦)。
 *
 * **不按参数展开的语法分区**（`:-` 前后)取舍:偏「多认一个未知」那一侧 —— 多认 ⇒ 降成提示,
 * 少认 ⇒ 一件做得成的事做不成（见 command-never-exits.ts 文件头那段不对称）。
 */
function expansionsInText(inner: string): TextScan {
  const marks: ExpansionMarks = {};
  let unclosed: string | null = null;
  // 反引号成对才算收口。双引号里 `\`` 是字面量,所以这条可能多报一次 —— 多报的代价是
  // 一条真的永不退出的命令降成提示,少报的代价是一条压根跑不起来的命令被硬拦(见文件尾
  // `lex` 那段不对称),所以宁可多报。
  const ticks = inner.split("`").length - 1;
  if (ticks) { marks.expanded = true; marks.substitution = true; }
  if (ticks % 2) unclosed = "反引号";
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] !== "$") continue;
    switch (dollarForm(inner[i + 1], inner[i + 2])) {
      case "arithmetic": marks.expanded = true; marks.arithmetic = true; break;
      case "substitution": marks.expanded = true; marks.substitution = true; break;
      case "parameter": {
        marks.expanded = true;
        const close = inner.indexOf("}", i + 2);
        // **没收口的残段不许喂给 `parameterForm`**(本轮审查 F3):`"${X"` 里剩下的那个 `X`
        // 看着就是个合法参数名,于是「这个展开没收口」被读成了「证明过的形式」,而真 shell
        // 里这条命令连语法都过不去(实测 rc=2、stdout 一个字都没有)。
        if (close < 0) { unclosed ??= "${"; break; }
        // 同一个封闭判据,引号内外共用一份(见 parameterForm;两处各自枚举正是 F1 的形状)。
        const form = parameterForm(inner.slice(i + 2, close));
        if (form === "error") marks.errorForm = true;
        else if (form === "unknown") marks.unknownForm = true;
        break;
      }
      case "value": marks.expanded = true; break;
      case "unknown": marks.unknownForm = true; break;
      default: break; // 字面的美元号
    }
  }
  return { marks, unclosed };
}

/**
 * 这个引号在哪儿收口。-1 = 没收口（命令本身就不完整，由调用方按「读到末尾」处理）。
 *
 * **双引号里的 `\"` 不是收口**（第 3 轮审查 F1）。上一版两处收口都是 `indexOf`,于是
 * `printf "literal \"; tail -F /dev/null; #\n"` 里那个转义引号被当成了字符串的结尾:后面
 * 本该是**字符串正文**的 `; tail -F /dev/null; #` 一下子变成了结构和执行节点,一条打一行就
 * 退的命令被硬拦（实测 `/bin/sh` 退出 0 并打出整行正文,而创建闸 409）。单引号里不转义
 * （shell 的规矩:单引号里连反斜杠都是普通字符），所以这一支只对双引号成立。
 */
function quoteEnd(command: string, open: number): number {
  const q = command[open]!;
  let i = open + 1;
  while (i < command.length) {
    const c = command[i]!;
    if (q === '"' && c === "\\") { i += 2; continue; }
    if (c === q) return i;
    i += 1;
  }
  return -1;
}

/** 引号内的内容换成等长空格:做文本判据时用，`echo 'waiting for exit'` 不该捐出一个 `exit`。 */
export function blankQuoted(command: string): string {
  let out = "";
  let i = 0;
  while (i < command.length) {
    const c = command[i]!;
    if (c === "'" || c === '"') {
      const close = quoteEnd(command, i);
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
export type Sep = ";" | "&" | "&&" | "|" | "||" | "(" | ")" | "{" | "}" | "eof";
/** 一条简单命令 + 收尾它的那个符号。token 可以是空的（`(`、`;;`、注释行留下的空段）。 */
export type Segment = { tokens: Token[]; sep: Sep };

/** 词法扫描的结果:切好的那些段,**外加「有没有哪个结构没收口」**。 */
export type Lexed = {
  segments: Segment[];
  /**
   * 有一个结构**没收口**就是它的名字（`单引号`/`双引号`/`` 反引号 ``/`$(`/`$((`/`${`），
   * 全都收口了就是 `null`。
   *
   * 为什么这件事必须跟段一起交出去（本轮审查 F3）:没收口 ⇒ 这串字符在 shell 那边**连语法
   * 都过不去**,一条都不会执行。实测（`/bin/sh -lc`,七种写法全是 rc=2、stdout 一个字都没有）:
   *   · `echo A; : "${X"` / `: '${X` / `` : `printf x `` / `: $(printf x` / `: $((1+1` / `: ${X`;
   *   · `echo A; tail -F /dev/null; : "${Y"` —— **没收口在后面那一段,前面那个 tail 也一次都没跑**。
   * 所以它不能只落成「那个词里有个读不懂的东西」(`unknownForm`):那是**一个词**的性质,而这里
   * 要的是整条命令的 —— 上一版正是把 `"${X"` 的残段喂给 `parameterForm`,`X` 像个合法参数名,
   * 于是「没收口」凭空变成「证明过的形式」,一条跑都跑不起来的命令被硬拦（实测接口 409）。
   *
   * 调用方的处置只有一种:**整条放行**。跟 `provableBlocker` 里「组括号没配上对就放行」是同一
   * 条口径（那一档实测同样 rc=2），也跟文件尾那段代价不对称一致。
   */
  unclosed: string | null;
};

/**
 * 把命令切成**简单命令 + 它的收尾符号**，并报出**有没有哪个结构没收口**。
 *
 * 只认结构，不认意图：引号里的内容合成一个 token 并打上 `quoted`（**永远不会被当成命令词、
 * 也永远不会被当成关键字**），`$( )` 与反引号整段跳过（里面是另一层执行，这一层读不懂就不猜）。
 *
 * **空段也留着**（`tokens` 为空）:它身上那个符号还有用 —— `(cmd) && tail -F x` 里的 `&&`
 * 正好落在 `(` 留下的那个空段上,丢掉它就等于把「要看前一条退出码」这件事丢掉。
 *
 * 返回的是一个**对象**而不是光一串段:「没收口」这件事只有扫到底的人知道,而漏掉它的代价是
 * 把一条压根跑不起来的命令硬拦掉（见 `Lexed.unclosed`）—— 所以让类型逼着每个调用方接住它,
 * 别做成一个「想起来才去问一句」的旁路函数。
 */
export function lex(command: string): Lexed {
  const out: Segment[] = [];
  let cur: Token[] = [];
  let text = "";
  // 跟 `text` 等长的骨架:引号里、转义来的字符一律 `\0`（见 `Token.bare`）。
  let bare = "";
  let quoted = false;
  let started = false;
  // 这个词里出现过的展开（见 `Token.expanded` 那段）。占位符抹掉之前就得记下来。
  let marks: ExpansionMarks = {};
  const endToken = () => {
    if (started) cur.push({ text, quoted, bare, ...marks });
    text = "";
    bare = "";
    quoted = false;
    started = false;
    marks = {};
  };
  const endSegment = (sep: Sep) => {
    endToken();
    out.push({ tokens: cur, sep });
    cur = [];
  };
  let i = 0;
  // 没收口的那个结构（第一个就够:整条命令已经是语法错误了,再往后数第二个没有意义）。
  let unclosed: string | null = null;
  while (i < command.length) {
    const c = command[i]!;
    if (c === "'" || c === '"') {
      // 收口在哪儿由 `quoteEnd` 说（双引号里的 `\"` 不收口，见那边）。引号里的内容原样进
      // `text`（转义符留着也无妨:这个词打了 `quoted`,永远不会被当成命令词或关键字），所以
      // `bare` 照它的长度补 `\0` —— 两者等长这个不变量不能破（见 `Token.bare`）。
      const q = c;
      const close = quoteEnd(command, i);
      if (close < 0) unclosed ??= q === "'" ? "单引号" : "双引号";
      const inner = close < 0 ? command.slice(i + 1) : command.slice(i + 1, close);
      text += inner;
      bare += "\0".repeat(inner.length);
      quoted = true;
      started = true;
      // **双引号里的展开是真的会执行的**(`"$(printf x)"`)，单引号里的是字面量。引号里的内容
      // 原样进 `text`,所以这一支只能扫文本把标记补上 —— 不补的话上面那层就只剩「正则扫 text」
      // 一条路,而那条路对不带引号的那一半天生无效（见 `Token.expanded`）。
      if (q === '"') {
        const scan = expansionsInText(inner);
        marks = { ...marks, ...scan.marks };
        unclosed ??= scan.unclosed;
      }
      i = close < 0 ? command.length : close + 1;
      continue;
    }
    // 反斜杠转义的那个字符**也不是运算符**（`\<f` 是个叫 `<f` 的参数),所以骨架上同样记 `\0`。
    if (c === "\\") {
      text += command[i + 1] ?? "";
      bare += "\0";
      started = true;
      i += 2;
      continue;
    }
    if (c === "$" && command[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      while (j < command.length && depth > 0) {
        if (command[j] === "(") depth += 1;
        else if (command[j] === ")") depth -= 1;
        j += 1;
      }
      if (depth > 0) unclosed ??= command[i + 2] === "(" ? "$((" : "$(";
      // 占位成一个「不认识的词」:它是个参数，但也绝不该让后面那个词变成命令词。**抹掉之前**把
      // 「这里有个什么」记在词上（见 `Token.expanded`）。`$((` 是算术,不是命令替换:它里面没有
      // 另一层执行,但算术自己就能让 shell 当场出错走人。
      text += "?";
      bare += "?";
      marks.expanded = true;
      if (command[i + 2] === "(") marks.arithmetic = true;
      else marks.substitution = true;
      started = true;
      i = j;
      continue;
    }
    // **`${…}` 是一个词里的展开，不是分组**（第 4 轮审查 F3）。下面那条把 `{` / `}` 当分段符的
    // 规矩对 `{ cmd; }` 是对的，对 `${X}` 是错的:`: ${1:?required}` 当年被切成「`:` `$`」+
    // 「`1:?required`」两段,于是整个展开在判据面前根本不存在。
    if (c === "$" && command[i + 1] === "{") {
      let depth = 1;
      let j = i + 2;
      while (j < command.length && depth > 0) {
        if (command[j] === "{") depth += 1;
        else if (command[j] === "}") depth -= 1;
        j += 1;
      }
      const inner = command.slice(i + 2, depth === 0 ? j - 1 : command.length);
      text += "?";
      bare += "?";
      marks.expanded = true;
      // **没收口就不许再问它是哪一种**(本轮审查 F3):残段喂进 `parameterForm` 会被认成
      // 「证明过的形式」,而真 shell 里这条命令连语法都过不去(见 `Lexed.unclosed`)。
      if (depth !== 0) unclosed ??= "${";
      else {
        const form = parameterForm(inner);
        if (form === "error") marks.errorForm = true;
        // **证明不了就是未知**:不带引号这一侧整段马上被抹成占位符,这里不记就永远没人知道
        // 「这个参数形式没人证明过」(见 parameterForm 的三条实测)。
        else if (form === "unknown") marks.unknownForm = true;
      }
      // **内层那些展开也要带上来**（第 2 轮审查第 2 条）:整段马上要被抹成一个 `?`,里面套着的
      // 算术/命令替换/error form 再不记就永远找不回来了 —— `: ${X:-$((1/0))}` 真 shell 里是
      // 除零退 127,而判据只看见「一个说不清的展开」,于是把一条自己会结束的命令硬拦掉。
      // 带引号那一侧一直是对的（引号里的内容原样留在 text 里,被同一个扫描看了个遍）,这正是
      // 为什么同一件事只有不带引号的那半边出问题。
      const nested = expansionsInText(inner);
      marks = { ...marks, ...nested.marks };
      unclosed ??= nested.unclosed;
      started = true;
      i = j;
      continue;
    }
    if (c === "`") {
      const close = command.indexOf("`", i + 1);
      if (close < 0) unclosed ??= "反引号";
      text += "?";
      bare += "?";
      marks.expanded = true;
      marks.substitution = true;
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
      // **紧跟在重定向运算符后面的那个不是分隔符**（第 3 轮审查 F1 的同类）:`2>&1`、`>|f`
      // 里它是运算符本体的第二个字符。上一版照旧断段,于是 `tail -F x 2>&1 | grep E` 被切成
      // 「`tail -F x 2>` 放后台」—— 后台那一支直接作废判定,一条真的永不退出的命令被放过
      // （偏安全那一侧,但「它写了什么」答错了,下一层就没得判）。判据落在骨架上:紧挨着的
      // 那一位得是**引号外**的 `<`/`>`（`'>'|x` 里那个 `|` 照旧是管道）。
      const prev = bare[bare.length - 1];
      if (c === "&" ? prev === "<" || prev === ">" : prev === ">") {
        text += c;
        bare += c;
        i += 1;
        continue;
      }
      const twice = command[i + 1] === c;
      endSegment(twice ? (c === "&" ? "&&" : "||") : c === "&" ? "&" : "|");
      i += twice ? 2 : 1;
      continue;
    }
    if (c === "(" || c === ")" || c === "{" || c === "}") { endSegment(c); i += 1; continue; }
    // 走到这儿的 `$` 后面不是 `(` 也不是 `{`（那两种上面各自处置过了）。剩下的按 `dollarForm`
    // **封闭**地分:`$NAME` / `$1` / `$@` 这类**值展开**占位符不换（`text` 里那个 `$` 还在），
    // 但标记照样打 —— 判据只认标记,不再靠「`text` 里有没有 `$`」,那条路对被抹成 `?` 的那一半
    // 天生无效;认不出来的形式打 `unknownForm`,它往上冒成「证明不了」（第 1 轮审查 F2）。
    if (c === "$") {
      const form = dollarForm(command[i + 1], command[i + 2]);
      if (form === "value") marks.expanded = true;
      else if (form === "unknown") marks.unknownForm = true;
    }
    text += c;
    bare += c;
    started = true;
    i += 1;
  }
  endSegment("eof");
  return { segments: out, unclosed };
}

/**
 * 一个**重定向**:运算符本体、它作用的那个描述符、它的目标。目标是字面文本（引号已拆、
 * `$( )` 已占位成 `?`）。
 *
 * `fd` 是**被改写的那一个描述符**（第 2 轮审查 F2）:写了 fd 前缀就是它（`2>&1` 的 2），
 * 没写就按方向取默认（`<` 一侧是 0，`>` 一侧是 1）。少了它,「关掉 1 之后再从 1 复制」这种
 * **按顺序才成立**的事实根本表达不出来 —— 审查实测 `tail -F /dev/null 1>&- 2>&1` 里两项
 * 单看都「安全」,连起来却让整条命令一个字都没跑（shell 报 Bad file descriptor,随后退出 0）。
 *
 * 这一层只答「这一段上写着哪几个重定向、各自作用在谁身上、指向什么」。**「它打不打得开」
 * 不在这儿答** —— 那是判据层的事（见 command-never-exits.ts 的 `startProvable`）。
 */
export type Redirect = { op: string; fd: number; target: string };

/** 运算符本体的第二个字符（`>>`、`<<`、`<>`、`<&`、`>&`、`>|`）。 */
const OP_TAIL = new Set(["<", ">", "&", "|"]);

/**
 * 这一段上挂着的全部重定向。
 *
 * 判据落在**骨架**上（`Token.bare`）:引号里、被转义过来的 `<`/`>` 一律不算运算符 ——
 * `'<'f` 在 shell 里就只是个叫 `<f` 的参数（第 2 轮审查 F2）。不要求运算符出现在词首:
 * `done 0<f`、`2>&1`、`>f` 分词之后长相不同,而「这里写着一个重定向」是同一件事。
 *
 * 目标的取法跟 shell 一致:运算符后面还有字就是那几个字（`>f`），没有了就是**下一个词**
 * （`> f`）—— 后者会把那个词吃掉,免得它被重新当成一段新文本扫一遍。
 *
 * 一个词里写了两个（`>a<b`）照样各算一个:目标切到**下一个引号外的运算符**为止。
 *
 * fd 前缀**只在它独占运算符前面那一整段时才算**（POSIX 的 IO_NUMBER）:`2>f` 的 2 是描述符,
 * 而 `x2>f` 里那个 2 是词 `x2` 的一部分,重定向走默认的 1。
 */
export function redirectsOf(tokens: Token[]): Redirect[] {
  const out: Redirect[] = [];
  for (let k = 0; k < tokens.length; k += 1) {
    const tok = tokens[k]!;
    let i = 0;
    // 这一段「子词」从哪儿开始:fd 前缀只认独占这一段的那种（见上面那段关于 IO_NUMBER 的话）。
    let wordStart = 0;
    while (i < tok.bare.length) {
      const c = tok.bare[i]!;
      if (c !== "<" && c !== ">") { i += 1; continue; }
      const prefix = tok.bare.slice(wordStart, i);
      let j = i + 1;
      const next = tok.bare[j];
      if (next !== undefined && OP_TAIL.has(next)) j += 1;
      // `<<<` 是 here-string（整条命令更早就按 here-doc 放行了，这里只为把目标切对）。
      if (c === "<" && next === "<" && tok.bare[j] === "<") j += 1;
      const op = tok.bare.slice(i, j);
      const fd = /^\d+$/.test(prefix) ? Number(prefix) : c === "<" ? 0 : 1;
      let e = j;
      while (e < tok.bare.length && tok.bare[e] !== "<" && tok.bare[e] !== ">") e += 1;
      const inWord = tok.text.slice(j, e);
      if (inWord) {
        out.push({ op, fd, target: inWord });
        i = e;
        wordStart = e;
        continue;
      }
      out.push({ op, fd, target: tokens[k + 1]?.text ?? "" });
      k += 1;
      break;
    }
  }
  return out;
}

/**
 * 把注释从**已经抹掉引号内容**的文本里也抹掉（按文本看的那两条判据用，长度保持不变）。
 *
 * 跟 `segments` 里那一支是同一条规矩的两处落点：那边决定「哪几条是简单命令」，这边决定
 * 「here-doc / 函数定义这些结构算不算出现过」。少一处，`# later() { … }` 这样的注释就又会
 * 把一条打一行就退的命令说成读不懂。
 */
export function blankComments(text: string): string {
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
