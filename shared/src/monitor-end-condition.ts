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
//    按 `; | && & ( ) 换行` 断开），只拿每条的**命令词和它自己的 argv** 去比；引号里的字、
//    `$( )`/反引号里的字一律不当执行节点。读不懂的形状（`eval`、脚本封装）照旧**不拦**。
//
// ③ **拦的凭据必须是「这一条真的会跑」**（第 2 轮审查 F3）。②只做到了「不搜整串文本」,而
//    切出来的简单命令里仍混着一堆**不是执行节点**的东西,于是五种会自己结束的命令被 409
//    拦掉（审查实测，全部 `/bin/sh` 退出 0）：here-doc 的文档体、`#` 注释、从没被调用过的
//    函数体、`if false; then … fi` 这种走不到的分支，以及 `tail -- -f`（`--` 之后那个 `-f`
//    是文件名不是开关）。这一层读不出执行资格的结构（here-doc、函数定义）**整条命令放行**,
//    读得出但判不出哪几支会跑的（条件分支）**跟随型那一扫整个不做**,`--` 按各命令自己的
//    argv 规则尊重。少拦几条 = 退回今天的行为；多拦一条 = 一件做得成的事做不成了。
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

/** 一行命中没有。**只用 includes/startsWith/endsWith**:耗时上界是行长 × 候选数（见文件头 ①）。 */
function lineHits(line: string, cond: EndCondition): boolean {
  for (const { needle, atStart, atEnd } of cond) {
    if (atStart && atEnd) { if (line === needle) return true; continue; }
    if (atStart) { if (line.startsWith(needle)) return true; continue; }
    if (atEnd) { if (line.endsWith(needle)) return true; continue; }
    if (line.includes(needle)) return true;
  }
  return false;
}

/** 这一批新吐出来的行里，有没有一条命中了约定的结束条件。返回命中的那一行。 */
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

/** 引号内的内容换成等长空格:做循环检测时用，`echo 'waiting for exit'` 不该捐出一个 `exit`。 */
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
 * 把命令切成**简单命令**（每条是它的 token 列表）。
 *
 * 只认结构，不认意图：引号里的内容合成一个 token 并打上 `quoted`（**永远不会被当成命令词**），
 * `$( )` 与反引号整段跳过（里面是另一层执行，这一层读不懂就不猜）。断开符是
 * `; & | 换行 ( ) { }` —— `&&`/`||` 由单字符分支自然覆盖。
 */
function simpleCommands(command: string): Token[][] {
  const cmds: Token[][] = [];
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
  const endCommand = () => {
    endToken();
    if (cur.length) cmds.push(cur);
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
      endCommand();
      i = nl < 0 ? command.length : nl;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") { endToken(); i += 1; continue; }
    if (c === "\n" || c === ";" || c === "&" || c === "|" || c === "(" || c === ")" || c === "{" || c === "}") {
      endCommand();
      i += 1;
      continue;
    }
    text += c;
    started = true;
    i += 1;
  }
  endCommand();
  return cmds;
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
 * 把注释从**已经抹掉引号内容**的文本里也抹掉（按文本看的那几条判据用，长度保持不变）。
 *
 * 跟 `simpleCommands` 里那一支是同一条规矩的两处落点：那边决定「哪几条是简单命令」，这边
 * 决定「`while true` / 函数定义 / 条件分支这些结构算不算出现过」。少一处，`# while true;
 * do :; done` 这样的注释就又会把一条打一行就退的命令拦下来。
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
/**
 * 条件分支。哪几支真的会跑是运行时的事，这一层判不出 —— 所以**跟随型那一扫整个不做**
 * （`if false; then tail -F x; fi` 曾因此被拦）。恒真循环那一条判据不受影响：循环体里有
 * `if` 不改变「这个循环没有出路」这件事，照旧要拦。
 */
const CONDITIONAL = /(?<![-./\w])(?:if|elif|else|then|fi|case|esac)\b/;

/** `while true` / `until false` 这类恒真循环。循环体里有 `break`/`exit` 就不算。 */
const FOREVER_LOOP = /\b(?:while\s+(?:true|:)|until\s+false)\b([\s\S]*?)\bdone\b/;
const ESCAPES = /\b(?:break|exit|return)\b/;

/**
 * 这条命令**自己永远不会结束**吗。
 *
 * 返回那个判定它的写法（给拒绝文案用），不是的话返回 `null`。只回答形状，不回答意图 ——
 * 「永不退出」本身不是错，错的是**既永不退出、又没有任何别的结束条件**。
 */
export function neverExitsOnItsOwn(command: string): string | null {
  // 按文本看的那几条判据共用这一份:引号内容和注释都已经抹掉,长度不变。
  const plain = blankComments(blankQuoted(command));
  // **读不出执行资格的结构 ⇒ 整条命令放行**（见文件头 ③）。here-doc 的终止词、函数体到底
  // 调没调过，这一层都只能猜；猜错的那一半代价是「一件做得成的事做不成」。
  if (HERE_DOC.test(plain) || FUNC_DEF.test(plain)) return null;
  // 条件分支在场时跟随型那一扫整个不做：切出来的简单命令里混着走不到的那几支，分不清。
  if (!CONDITIONAL.test(plain)) {
    for (const tokens of simpleCommands(command)) {
      const cmd = commandOf(tokens);
      if (!cmd || cmd.bounded) continue;
      for (const f of FOLLOWERS) if (f.name === cmd.name && f.follows(cmd.argv)) return f.what;
    }
  }
  // 循环是跨简单命令的结构，只能按文本看。
  const loop = FOREVER_LOOP.exec(plain);
  if (loop && !ESCAPES.test(loop[1] ?? "")) return "while true / until false";
  return null;
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
