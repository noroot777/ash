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

/** 引号内的内容换成等长空格:做文本判据时用，`echo 'waiting for exit'` 不该捐出一个 `exit`。 */
export function blankQuoted(command: string): string {
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
      const close = command.indexOf(c, i + 1);
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
