// 哨兵的**结束条件**:它什么时候算完 —— 创建闸、运行时与表单共用的那一份判据与措辞。
//
// 起因是一次真实的空等（2026-10-21，任务 1Ek9U5dNDGSI）：agent 挂了
//   tail -F <那个任务的输出文件> | grep -E --line-buffered "^Ran |^OK|^FAILED|Traceback|Killed"
// 去盯一轮全量回归。被盯的活早就跑完了，而 `tail -F` 永远不会退出，于是「命令结束」这条
// 唤醒条件在它身上根本不可能触发，只剩到期那一条 —— 整整 30 分钟、0 条事件，白等。
//
// ── 为什么是**闸**而不是提醒 ─────────────────────────────────────────────────────
//
// 同一条命令的作者当然也可以记得加上结束条件，但那是自觉。用户 2026-10-21 问的就是这一句：
// 「你能保证 agent 一定会加吗」—— 不能。所以这一份判据的用法是：命令被判定为「自己永远
// 不会退出」而调用方又没给任何结束条件时，**创建当场 409**，命令一个字都不跑。
//
// ── 两条硬边界（第 1 轮审查 F1/F3）─────────────────────────────────────────────────
//
// ① **结束条件不是正则**。上一版收 JS 正则源文，`new RegExp` 编过就拿去 `.test` ——
//    编译成功只证明语法对，不证明它跑得完：`^(a+)+$` 配上 41 个字符的一行就能让 irregexp
//    回溯到停不下来（审查实测:子进程 2504ms 还没返回，同时安排的 100ms 定时器一次都没执行）。
//    而这一笔匹配跑在服务唯一那条线程上，于是**连停止按钮和到期收尾一起卡住**。
//    所以这一版根本不构造调用方给的正则：条件是一串**字面量候选**，匹配只用
//    `includes/startsWith/endsWith`，耗时上界是「行长 × 候选数」，没有回溯这回事。
//    代价是失掉字符类和分组 —— 不心疼：命令自己那段 `grep -E` 才是过滤器，这里要的只是
//    「哪个字样一出现就收工」。
//
// ② **判「会不会自己结束」只看命令结构，不搜整串文本**。上一版拿正则搜整条命令，于是
//    `printf '%s\n' 'tail -F build.log'` 被当成跟随型拦掉（审查实测 409）——匹配到的是
//    printf 的参数，那条命令打一行就退。反过来 `tail -n 0 -F /dev/null` 和
//    `timeout 1 true; tail -F x` 又漏判。所以这一版先把命令切成**简单命令**（尊重引号、
//    按 `; | && || & ( ) { } 换行` 断开），只拿每条的**命令词和它自己的 argv** 去比；引号里
//    的字、`$( )`/反引号里的字一律不当执行节点。读不懂的形状（`eval`、脚本封装）**不拦**。
//
// ③ **拦的凭据必须是「这一条真的会跑」**（第 2 轮审查 F3、第 3 轮审查 F3）。②只做到了
//    「不搜整串文本」,而切出来的简单命令里仍混着一堆**不是执行节点**的东西,于是八种会自己
//    结束的命令被 409 拦掉（两轮审查实测，全部 `/bin/sh` 退出 0）：here-doc 的文档体、
//    `#` 注释、从没被调用过的函数体、`if false; then … fi` 这种走不到的分支、`tail -- -f`
//    （`--` 之后那个 `-f` 是文件名不是开关）、`false && tail -F x; printf done`（短路掉的
//    右边）、`exit 0; tail -F x`（退出之后的那一条）、`if false; then while true; do :;
//    done; fi`（走不到的分支里的循环）。
//
// ④ **所以这一版是「先证明会跑、再问它会不会结束」,不是「先拦下来、再逐个豁免」**
//    （第 3 轮审查 F3）。上一版的形状是后者:一堆 if 往外豁免 —— 每次审查补一个写法,而漏
//    掉的那些照旧误拦。倒过来之后 `provableBlocker` 只走**证明得出会跑**的那几条简单命令:
//    不在 `if`/`case` 分支里、不在条件未知的循环体里、前面没有 `&&`/`||` 短路、前面没出现过
//    `exit`/`exec`,收尾符号也不是 `&`（放后台 ⇒ shell 不等它）。读不懂的结构一律放行,而
//    「读不懂」是**结构**读不懂（配不上对的 `fi`、认不出的循环条件），不是「这个写法没见过」。
//
// ── 误判的代价不对称，所以只认**明确**的那几种 ───────────────────────────────────
//
// 漏判（把一条永不退出的命令放过去）= 退回今天的行为，不比现状坏；误判（把一条会自己结束
// 的命令拦下来）= 一件本来做得成的事做不成了。所以下面每一条都要求「这个写法不退出」是**这个
// 命令形状本身**决定的，而不是靠猜它的意图：`tail -f` 的语义就是不退出，`while true` 没有
// `break` 就是不退出。拿不准的一律不拦。
//
// 对称地，**拦下来一定要给得出出路**，而且三条出路覆盖全部合法意图（见 `endConditionDemand`）。
// 而「拦不拦」只决定**要不要你必须给一个**，不决定**你能不能给**：任何命令都可以配结束条件
// （表单一律给那个输入框），把同一份猜测拿去决定配置资格是第 1 轮审查 F3 点掉的那一半。

// ── 一、结束条件:字面量候选 ───────────────────────────────────────────────────────

/** 一条候选:`needle` 这个字样，出现在行首（`atStart`）/行尾（`atEnd`）/任意位置。 */
export type EndConditionTerm = { needle: string; atStart: boolean; atEnd: boolean };
/** 结束条件 = 若干候选的「或」。任一候选命中，那一行就是结束那一行。 */
export type EndCondition = readonly EndConditionTerm[];

export type EndConditionCheck =
  | { ok: true; cond: EndCondition | null }
  | { ok: false; error: string };

/**
 * 正则的那几个元字符。**出现就拒**，不是悄悄按字面量理解 ——
 * 按习惯写了 `^(OK|FAILED)` 的人，拿到「这不是正则，括号会被当成真的括号」才改得对；
 * 静默当字面量的话他只会看到一条永远不命中的结束条件，而那正是这个功能要消掉的那一幕。
 */
const META = /[()[\]{}*+?\\]/;

/**
 * 语法这件事**只在这儿说一遍**（第 2 轮审查 N1）。
 *
 * 它要同时出现在三处:拒绝文案（这个模块）、MCP 工具说明（agent 看的）、表单那行小字
 * （人看的）。各写一份的结果是审查实测到的那种漂移 —— 后两处都写着「其余字符都当它本身」,
 * 而 `[DONE]` 这种一提交就被 400 拒掉:**元字符是拒掉而不是当字面量**,两句话的差别正好是
 * 用户要不要改写自己的输入。所以 agent 侧那份直接引这个常量,人侧那份是同一段话的纯文本版
 * （表单里不渲染 markdown），紧挨着放,改一处时另一处就在眼前。
 */
export const END_CONDITION_SYNTAX =
  "结束条件不是正则，是**字样**：写上那一行里会出现的字，多个用 `|` 分隔（任一命中即收工）；"
  + "开头加 `^` = 只认行首，结尾加 `$` = 只认行尾。例：`BUILD OK|FAILED`、`^SWEEP_EXIT=`。"
  + "正则元字符（`( ) [ ] { } * + ? \\`）**一律拒掉**，不是悄悄当字面量——"
  + "所以 `[DONE]` 请写成 `DONE`（子串照样命中），`[0-9]+` 这种意图写进命令自己那段 grep。"
  + "要用正则就把它写进命令里 —— 命令才是过滤器。";

/** 同一段话的纯文本版，给表单那行小字（它不渲染 markdown）。见上。 */
export const END_CONDITION_HINT =
  "这里不是正则，是字样：多个用 | 分隔（任一命中即收工），开头加 ^ 只认行首、结尾加 $ 只认行尾。"
  + "正则元字符（ ( ) [ ] { } * + ? \\ ）会被拒掉而不是当成字面量——[DONE] 请写成 DONE，"
  + "子串照样命中；要用正则就写进命令里那段 grep。";

const SYNTAX = END_CONDITION_SYNTAX;

/**
 * 校验并解析结束条件。**在起进程之前做** —— 一个解析不出来的条件等于一个永远不会命中的
 * 结束条件，放进去只会变成另一条「只能等到期」的哨兵，而调用方还以为自己已经设过了。
 */
export function parseEndCondition(pattern: string | null | undefined): EndConditionCheck {
  const raw = typeof pattern === "string" ? pattern.trim() : "";
  if (!raw) return { ok: true, cond: null };
  const meta = META.exec(raw);
  if (meta) {
    return {
      ok: false,
      error: `结束条件里有正则元字符「${meta[0]}」，而它会被当成这个字符本身，不是正则。${SYNTAX}`,
    };
  }
  const terms: EndConditionTerm[] = [];
  for (const piece of raw.split("|")) {
    let body = piece.trim();
    const atStart = body.startsWith("^");
    if (atStart) body = body.slice(1);
    const atEnd = body.endsWith("$");
    if (atEnd) body = body.slice(0, -1);
    if (!body) {
      return { ok: false, error: `结束条件里有一段是空的（「${piece}」）—— 空字样会命中每一行。${SYNTAX}` };
    }
    // 锚点只在两头才是锚点。中间的 `^`/`$` 多半是在写正则（`a$|^b` 之外的写法），
    // 按字面量理解它就成了一个永不命中的条件 —— 照实拒掉。
    if (body.includes("^") || body.includes("$")) {
      return { ok: false, error: `结束条件「${piece}」里的 ^ / $ 不在两头，那它只是普通字符。${SYNTAX}` };
    }
    terms.push({ needle: body, atStart, atEnd });
  }
  return { ok: true, cond: terms };
}

/**
 * 行尾那个 `\r` 不是正文（第 1 轮审查 F2）。
 *
 * CRLF 的日志里每一行末尾都挂着一个回车,而 `$` / `^…$` 这两种锚点恰恰是按**行尾**比的 ——
 * 不摘掉它,用户在输出窗口里**看得见** READY、事件也已经送到,而「整行就是 READY」永远不
 * 命中（审查实测:`printf 'READY\n'` ⇒ matched,`printf 'READY\r\n'` ⇒ 一直 running 到到期）。
 * 产出 CRLF 的不只有 Windows:任何把日志从 Windows 工具链里接出来、或者自己 `printf` 了
 * `\r\n` 的命令都算。
 *
 * **只摘掉换行自己带的那一个回车**,不是 `trim()`:正文两头真实的空格和制表符是正文,
 * 整个 trim 掉会把 `DONE $` 这种条件的语义一起改写掉。
 *
 * 规范化只发生在**匹配这一侧**:日志的字节游标、事件正文、命中回显一律按原文算
 * （游标按原始字节数前进,回显要跟日志里那一行对得上）。
 */
const dropCr = (line: string) => (line.endsWith("\r") ? line.slice(0, -1) : line);

/** 一行命中没有。**只用 includes/startsWith/endsWith**:耗时上界是行长 × 候选数（见文件头 ①）。 */
function lineHits(raw: string, cond: EndCondition): boolean {
  const line = dropCr(raw);
  for (const { needle, atStart, atEnd } of cond) {
    if (atStart && atEnd) { if (line === needle) return true; continue; }
    if (atStart) { if (line.startsWith(needle)) return true; continue; }
    if (atEnd) { if (line.endsWith(needle)) return true; continue; }
    if (line.includes(needle)) return true;
  }
  return false;
}

/**
 * 这一批新吐出来的行里，有没有一条命中了约定的结束条件。返回命中的那一行 ——
 * **原文那一行**（带着它自己的行尾回车），调用方要拿它去跟缓冲里的行对位。
 */
export function endConditionHit(lines: readonly string[], cond: EndCondition): string | null {
  for (const line of lines) if (lineHits(line, cond)) return line;
  return null;
}

/**
 * 把结束条件说成人话（卡片上那一段、拒绝文案里的回显）。
 *
 * 解析不出来的原样回显:存量行和脏数据照旧要显示得出来，而「显示」这件事不该因为内容
 * 不合今天的语法就整段消失 —— 那会让用户分不出「这条没有结束条件」和「这功能没做」。
 */
export function describeEndCondition(pattern: string): string {
  const parsed = parseEndCondition(pattern);
  if (!parsed.ok || !parsed.cond) return `「${pattern}」`;
  return parsed.cond
    .map(({ needle, atStart, atEnd }) => {
      const where = atStart && atEnd ? "整行就是" : atStart ? "行首是" : atEnd ? "行尾是" : "出现";
      return `${where}「${needle}」`;
    })
    .join(" 或 ");
}

/**
 * 卡片上那一段：这条哨兵**会不会提前收工**。
 *
 * 为什么不是 `describeEndCondition(x) + "就收工"`（第 2 轮审查 F2）:库里那个值可能是**这一版
 * 读不出来**的 —— 语义换过一轮（旧版收 JS 正则源文，见文件头 ①）、跨版本接力过来的任务、
 * 手改过的库，都能留下这样一行。运行时对它的处置是「当没有结束条件」，而卡片照旧念
 * 「…就收工」,于是界面在替一件不会发生的事背书:用户看着「行首是 OK 就收工」等下去,
 * 哨兵只会盯到到期。两边必须共用同一份判据 —— 读不出来就照实说读不出来。
 */
export function endConditionNote(pattern: string): string {
  const parsed = parseEndCondition(pattern);
  if (parsed.ok && parsed.cond) return `${describeEndCondition(pattern)}就收工`;
  return `结束条件「${pattern.trim()}」这一版读不出来，不会提前收工`;
}

// ── 二、这条命令自己会不会结束:按结构判 ──────────────────────────────────────────

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
 * 两条简单命令之间那个符号。**它决定后面那一条证明不证明得出会跑**（见文件头 ④）:
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

/** 一条简单命令的**命令词 + 它自己的 argv**。`bounded` = 它自带死线，无须再看。 */
function commandOf(tokens: Token[]): { name: string; argv: Token[]; bounded: boolean } | null {
  let i = 0;
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
 * 判据全部落在**那一条简单命令自己的 argv** 上（见文件头 ②）。
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
/** 恒真循环的出路。循环体里有它们，那个循环就不是「没有出路」。 */
const ESCAPES = new Set(["break", "exit", "return"]);
/** `while` 的恒真条件。`until` 的那一边是 `false`。 */
const TRUE_WORDS = new Set(["true", ":"]);

/** 这一段开头那个词（引号里的永远不算）。没有就是空串。 */
function headOf(tokens: Token[]): string {
  const t = tokens[0];
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
 * 从第 `from` 段起，找到跟它配对的那个收尾词所在的段（`if`→`fi`、`case`→`esac`、`do`→`done`）。
 *
 * **只认命令词位置上的关键字**:`if true; then grep -n fi src; tail -F x; fi` 里那个 `fi` 是
 * grep 的参数,按文本数它会让这个区提前收口,于是区里的 `tail -F x` 被当成顶层的、照拦。
 */
function matchEnd(segs: Segment[], from: number, open: string, close: string): number {
  let depth = 0;
  for (let i = from; i < segs.length; i += 1) {
    for (const w of headKeywords(segs[i]!.tokens)) {
      if (w === open) depth += 1;
      else if (w === close && (depth -= 1) === 0) return i;
    }
  }
  return -1;
}

/** 第 `from`..`to` 段里所有**没被引号包起来**的词（找 `break`/`exit` 这类出路用）。 */
function wordsIn(segs: Segment[], from: number, to: number): string[] {
  const out: string[] = [];
  for (let i = from; i <= to && i < segs.length; i += 1) {
    for (const t of segs[i]!.tokens) if (!t.quoted) out.push(t.text);
  }
  return out;
}

/**
 * 这个循环:**循环体跑不跑得到**、**它自己会不会结束**。
 *
 * · `while true` / `until false` —— 恒真:循环体一定跑得到,而且没有 `break` 就永远不结束
 * · `for x in a b` —— 列表里有确定非空的字面词,循环体一定跑得到（循环本身会结束）
 * · 其余（`while cond`、`for f in *.log`、`for f in $LIST`、`for f`）—— 列表可能是空的、
 *   条件可能一上来就假,**循环体跑不跑得到答不出来** ⇒ 整区不扫
 */
function loopShape(head: string, tokens: Token[]): { bodyRuns: boolean; endless: boolean } {
  const w1 = tokens[1];
  const word = w1 && !w1.quoted ? w1.text : "";
  const endless = (head === "while" && TRUE_WORDS.has(word)) || (head === "until" && word === "false");
  if (endless) return { bodyRuns: true, endless: true };
  if (head === "for" || head === "select") {
    const at = tokens.findIndex((t) => !t.quoted && t.text === "in");
    const literal = at >= 0 && tokens.slice(at + 1).some((t) => !/[*?[\]$~]/.test(t.text));
    return { bodyRuns: literal, endless: false };
  }
  return { bodyRuns: false, endless: false };
}

/**
 * 扫出**证明得出会跑**的那几条简单命令，对它们问 FOLLOWERS;顺带认恒真循环（见文件头 ③）。
 *
 * 一条简单命令「证明得出会跑」要同时满足两件:
 *  ① 它不在任何**答不出哪几支会跑**的区里（`if`/`case` 的分支、条件未知的循环体）
 *  ② 从上一个 `;`/换行 到它之间没有 `&&`/`||`（那两个要看前一条的退出码），而且前面没出现过
 *     `exit`/`exec`/`return`（那之后什么都证明不出来）
 *
 * 读不懂的结构一律**放行**:配不上对的 `fi`、认不出的循环条件、`eval` 这种另一层执行 ——
 * 少拦几条 = 退回今天的行为；多拦一条 = 一件做得成的事做不成了（见文件头那段不对称）。
 */
function provableBlocker(segs: Segment[]): string | null {
  // 「这一条证明得出会跑吗」。`&&`/`||` 把它按掉，下一个 `;`/换行 把它恢复。
  let reach = true;
  // `( … )` / `{ … }` 的嵌套深度。**组里那些 `;` 不作数**:一组放不放后台要看收尾它的那个
  // 符号,而组里最后那条命令后面按语法必须有个 `;`（`{ tail -F x; } &`）。
  let depth = 0;
  // 这条管道里扫到的跟随型。**等管道收尾才算数**:收尾符号是 `&` 的话它整条放后台，
  // shell 不等它 —— 那时这个判据作废（`tail -F x & printf done` 立刻就结束了）。
  let pipeline: string | null = null;
  for (let i = 0; i < segs.length; i += 1) {
    let tokens = segs[i]!.tokens;
    for (;;) {
      const head = headOf(tokens);
      if (!head) break;
      const close = BRANCH[head];
      if (close) {
        // 分支区:整区不扫。区里有 `exit`/`exec` ⇒ 区后面的也证明不出来（那一支可能真的跑了）。
        const end = matchEnd(segs, i, head, close);
        if (end < 0) return pipeline;
        if (wordsIn(segs, i, end).some((w) => TERMINATORS.has(w))) return pipeline;
        i = end;
        tokens = [];
        break;
      }
      if (LOOP_HEADS.has(head)) {
        const end = matchEnd(segs, i, "do", "done");
        if (end < 0) return pipeline;
        const { bodyRuns, endless } = loopShape(head, tokens);
        if (!bodyRuns || !reach) {
          if (wordsIn(segs, i, end).some((w) => TERMINATORS.has(w))) return pipeline;
          i = end;
          tokens = [];
          break;
        }
        // 恒真又没有出路 ⇒ 就是它。**但同样等收尾符号点头**:`( while :; do :; done ) & 干活`
        // 里这一组整个放了后台,shell 不等它 —— 所以这里只记下判定,跳到这个循环的收尾那一段,
        // 由它身上（或它所在那一组身上）的符号决定作不作数。
        if (endless && !wordsIn(segs, i, end).some((w) => ESCAPES.has(w))) {
          pipeline = "while true / until false";
          i = end;
          tokens = [];
          break;
        }
        // 有出路的话循环体第一圈照样跑得到,所以不跳过:
        // `while true; do tail -F x; break; done` 第一圈就挂在 tail 上。
        tokens = [];
        break;
      }
      // 配不上对的 `fi`/`esac`:分支区一律是**整区跳过去**的（上面那一支），所以能走到这儿
      // 的只有读不懂的结构（多半根本不是合法的 shell）—— 读不懂就放行。
      if (head === "fi" || head === "esac") return pipeline;
      if (SKELETON.has(head)) { tokens = tokens.slice(1); continue; }
      if (head === "exit" || head === "return") return pipeline;
      break;
    }
    const cmd = tokens.length ? commandOf(tokens) : null;
    if (cmd && !cmd.bounded && reach) {
      for (const f of FOLLOWERS) if (f.name === cmd.name && f.follows(cmd.argv)) { pipeline = f.what; break; }
    }
    // `exec cmd` 把本进程换成 cmd（`WRAPPERS` 已经让上面按 cmd 判过了）—— 它之后的都跑不到。
    if (cmd && headOf(tokens) === "exec") return pipeline;
    // 收尾符号决定下一条（见 `Sep`）。注意读的是 `segs[i]`:上面跳过整区时 `i` 已经挪到那个
    // 区的收尾段上,要的正是**那一段**的符号（`fi && tail -F x` 里的 tail 就证明不出会跑）。
    switch (segs[i]!.sep) {
      case "&": pipeline = null; reach = true; break;          // 放后台 ⇒ 这一条判定作废
      case "&&": case "||": reach = false; break;
      case "|": break;                                          // 管道各级都会跑
      case "(": case "{": depth += 1; break;
      // 组收口本身不决定任何事:作不作数由**收尾这一组**的那个符号说（它落在紧跟其后那个
      // 空段上）—— 于是 `( … ) &` 和 `( … );` 两种分得开。
      case ")": case "}": depth = Math.max(0, depth - 1); break;
      default: {
        if (pipeline && depth === 0) return pipeline;
        reach = true;
      }
    }
  }
  // 组括号没配上对 ⇒ 这条命令在 shell 那边本来就是个语法错误,读不懂就放行。
  return depth === 0 ? pipeline : null;
}

/**
 * 这条命令**自己永远不会结束**吗。
 *
 * 返回那个判定它的写法（给拒绝文案用），不是的话返回 `null`。只回答形状，不回答意图 ——
 * 「永不退出」本身不是错，错的是**既永不退出、又没有任何别的结束条件**。
 */
export function neverExitsOnItsOwn(command: string): string | null {
  // **读不出执行资格的结构 ⇒ 整条命令放行**（见文件头 ③）。here-doc 的终止词、函数体到底
  // 调没调过，这一层都只能猜；猜错的那一半代价是「一件做得成的事做不成」。
  const plain = blankComments(blankQuoted(command));
  if (HERE_DOC.test(plain) || FUNC_DEF.test(plain)) return null;
  return provableBlocker(segments(command));
}

/**
 * 拒绝这次创建时说的那段话。**三条出路要同时给全**：它们分别对应三种合法意图，少给一条就会
 * 把那一种逼成「照抄另一种」—— 比如只给 `stopWhen`，那些「每出现一次就叫我一次」的哨兵就只能
 * 编一个永远不命中的条件来绕过闸。
 */
export function endConditionDemand(what: string): string {
  return (
    `这条命令自己永远不会结束（${what}），而你没有给它任何别的结束条件 —— `
    + "那样它只剩「盯满时长」这一条出路：被盯的活早就跑完了，任务还得干等到期才被叫醒"
    + "（2026-10-21 真实发生过，白等了 30 分钟、0 条事件）。命令一个字都没跑，按你要的那一种改："
    + "\n① **要等一件事干完** —— 把那件事本身放进命令里，它跑完哨兵就结束："
    + "`<跑那件事>; code=$?; <摘要几行>; echo \"EXIT=$code\"`。这是最省事也最准的写法。"
    + "\n② **活已经在别处跑着，只能跟着看** —— 原样保留这条命令，另外传 `stopWhen`：某一行出现"
    + "约定的字样，那一行照常推给你，哨兵随即收工。例：`stopWhen: \"BUILD OK|FAILED\"`。"
    + `（${SYNTAX}）`
    + "\n③ **本来就是要盯到到期** —— 「每出现一次就叫我一次」那种（盯错误日志、盯外部状态变化），"
    + "传 `untilExpiry: true` 明说一声，这次创建就照原样放行。"
  );
}
