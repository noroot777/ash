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
// ── 一条硬边界（第 1 轮审查 F1）─────────────────────────────────────────────────────
//
// **结束条件不是正则**。上一版收 JS 正则源文，`new RegExp` 编过就拿去 `.test` ——
// 编译成功只证明语法对，不证明它跑得完：`^(a+)+$` 配上 41 个字符的一行就能让 irregexp
// 回溯到停不下来（审查实测:子进程 2504ms 还没返回，同时安排的 100ms 定时器一次都没执行）。
// 而这一笔匹配跑在服务唯一那条线程上，于是**连停止按钮和到期收尾一起卡住**。
// 所以这一版根本不构造调用方给的正则：条件是一串**字面量候选**，匹配只用
// `includes/startsWith/endsWith`，耗时上界是「行长 × 候选数」，没有回溯这回事。
// 代价是失掉字符类和分组 —— 不心疼：命令自己那段 `grep -E` 才是过滤器，这里要的只是
// 「哪个字样一出现就收工」。
//
// ── 另一半在隔壁 ─────────────────────────────────────────────────────────────────
//
// 「这条命令**自己**会不会结束」（按结构判、怎么个「读不懂就放行」）全部在
// `command-never-exits.ts`:那边是拦不拦，这边是拦下来之后拿什么收工。两边只在
// `endConditionDemand` 见面 —— **拦下来一定要给得出出路**，而且三条出路覆盖全部合法意图。
// 而「拦不拦」只决定**要不要你必须给一个**，不决定**你能不能给**：任何命令都可以配结束条件
// （表单一律给那个输入框），把同一份猜测拿去决定配置资格是第 1 轮审查 F3 点掉的那一半。

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
