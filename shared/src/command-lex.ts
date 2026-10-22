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
export type Token = { text: string; quoted: boolean; bare: string };

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

/**
 * 把命令切成**简单命令 + 它的收尾符号**。
 *
 * 只认结构，不认意图：引号里的内容合成一个 token 并打上 `quoted`（**永远不会被当成命令词、
 * 也永远不会被当成关键字**），`$( )` 与反引号整段跳过（里面是另一层执行，这一层读不懂就不猜）。
 *
 * **空段也留着**（`tokens` 为空）:它身上那个符号还有用 —— `(cmd) && tail -F x` 里的 `&&`
 * 正好落在 `(` 留下的那个空段上,丢掉它就等于把「要看前一条退出码」这件事丢掉。
 */
export function segments(command: string): Segment[] {
  const out: Segment[] = [];
  let cur: Token[] = [];
  let text = "";
  // 跟 `text` 等长的骨架:引号里、转义来的字符一律 `\0`（见 `Token.bare`）。
  let bare = "";
  let quoted = false;
  let started = false;
  const endToken = () => {
    if (started) cur.push({ text, quoted, bare });
    text = "";
    bare = "";
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
      // 收口在哪儿由 `quoteEnd` 说（双引号里的 `\"` 不收口，见那边）。引号里的内容原样进
      // `text`（转义符留着也无妨:这个词打了 `quoted`,永远不会被当成命令词或关键字），所以
      // `bare` 照它的长度补 `\0` —— 两者等长这个不变量不能破（见 `Token.bare`）。
      const close = quoteEnd(command, i);
      const inner = close < 0 ? command.slice(i + 1) : command.slice(i + 1, close);
      text += inner;
      bare += "\0".repeat(inner.length);
      quoted = true;
      started = true;
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
      // 占位成一个「不认识的词」:它是个参数，但也绝不该让后面那个词变成命令词。
      text += "?";
      bare += "?";
      started = true;
      i = j;
      continue;
    }
    if (c === "`") {
      const close = command.indexOf("`", i + 1);
      text += "?";
      bare += "?";
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
    text += c;
    bare += c;
    started = true;
    i += 1;
  }
  endSegment("eof");
  return out;
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
