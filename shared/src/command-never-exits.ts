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
// ⑧ **下游会不会先退、循环体在 `set -e` 下会不会退、它盯的那个东西在不在** —— 这三块同样属于
//    「整条命令的退出语义」（新一轮审查 F1）。⑦之后仍有三种会立刻结束的命令被 409（审查用
//    `sh -lc` 配 3 秒超时实测,三条全部在超时前结束;本轮另行复核过一遍）:
//      · `while true; do printf 'DONE\n'; done | head -n 1` —— 打一行 DONE 就退出 0。恒真循环
//        的证明里藏着「它的 stdout 一直有人收」:下游先退就把管子关了,循环体下一次往 stdout
//        写当场吃 SIGPIPE。而「这个循环体到底往不往 stdout 写」这一层答不出来
//        （`while true; do :; done | head -n 1` 一个字都不写、`head` 一直等,那一条实测真的挂
//        住）⇒ **恒真循环一旦有下游就不拦**（`fragile`）。
//        **跟随型不走这一道**:它的输出是间歇的,下游退了也可能永远不触发那一次写入 ——
//        `tail -f x | grep -m1 y` 日志一安静就整条挂住（command-followers.ts 文件头那段）。
//      · `set -e; while true; do false; done` —— 实测退出 1。开了 errexit 之后**循环体自己就是
//        一条出路**:体里任何一条返回非零,shell 当场走人。而「这一圈里每一条都一定成功」这一层
//        答不出来 ⇒ 这道闸盖到循环的收尾那一段（体里才 `set -e` 的那种同样算）。
//      · `tail -f /definitely-missing-ash-review; printf 'DONE\n'` —— 报一句 No such file 就
//        退出、随后打出 DONE。`tail -f FILE` 的「不退出」有个前提:**那个文件现在就在**
//        （`-F`/`--retry` 才是没了也一直重试）。前提不写在命令文本里,所以这一层把它原样交出去
//        （`NeverExitsVerdict.assumesAnyExists`），由读得出这件事的那一层去核 —— 创建闸知道这
//        条哨兵将在哪个工作目录里跑（server/src/monitor-create.ts 的 `assumptionsHold`）。
//
//    ①–⑧ 合起来是同一条不变量:**硬拦只用「盖得住整条命令必要执行与退出语义」的那种证明**
//    —— 执行资格（这一条跑不跑得到）、argv（它到底有没有开始跟随）、输入来源（它盯的是谁）、
//    shell 状态（前面那条的退出码管不管得着它）、下游（谁在收它的 stdout）、以及它盯的那个
//    东西在不在，任一项读不出来**就不是硬拦的依据**,降级成一句可提交的提示。不按网页、
//    HTTP、hook 各补一个特例:这三处共用的就是这一个函数。
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
import { blankComments, blankQuoted, segments, type Segment } from "./command-lex.ts";
import { followerOf } from "./command-followers.ts";
import { commandOf } from "./command-wrappers.ts";

// **另外两张表在隔壁**（单文件 700 行的约定）:哪些命令的语义是「盯着不走」、它们的 argv 读不
// 读得懂,归 command-followers.ts（见 `followerOf`）;哪些词只是包一层、剥掉它们之后真正要跑的
// 是谁,归 command-wrappers.ts（见 `commandOf`）。这边只按它们的判据组合,不认具体的工具。


/**
 * 一个硬拦判定 —— 判它的那个写法、这个判定的前提，以及它**经不经得起下游先退出**。
 *
 * `fragile` 只对恒真循环为真（见文件头 ⑧）:它的证明里藏着「stdout 一直有人收」这一条,而
 * 跟随型的不藏 —— 所以这两种在管道里的命运不一样，一个布尔比两套判据便宜。
 */
type Found = { what: string; assumesAnyExists: readonly string[]; fragile: boolean };

/**
 * 函数定义:`name() {` / `function name {`。**定义这一刻函数体一个字都不跑**,而「后面到底
 * 调没调过它」这一层答不出来 —— 答不出来就不拦（第 2 轮审查 F3 实测:一个从未被调用的
 * `later() { tail -F /dev/null; }` 把整条命令拦掉了）。
 */
const FUNC_DEF = /(?:^|[;&|\n])\s*(?:function\s+)?[A-Za-z_][A-Za-z0-9_-]*\s*(?:\(\s*\)\s*[{(]|\{)/;
/** here-doc / here-string:`<<EOF` 到终止词之间是**数据**,不是执行节点。 */
const HERE_DOC = /<</;

// **形状那一层在隔壁**（command-scan.ts，单文件 700 行的约定）:分支区/循环区怎么配对、循环
// 条件读不读得懂、「这一条或这一组开不开得起来」。这边只按它给的形状组合出结论。
import {
  BRANCH, ESCAPES, JUMPS, LOOP_HEADS, SKELETON, TERMINATORS,
  branchEnd, headOf, loopEnd, loopReadable, loopShape, regionHas, scanOf, startProvable,
  type Scan,
} from "./command-scan.ts";

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
function provableBlocker(scan: Scan): Found | null {
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
  let pipeline: Found | null = null;
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
        //
        // **`set -e` 下循环体自己就是一条出路**（见文件头 ⑧）:体里任何一条返回非零,shell 当场
        // 走人 —— `set -e; while true; do false; done` 实测退出 1。而「这一圈里每一条都一定成
        // 功」这一层答不出来,所以闸盖到**收尾那一段**（`<= end`):体里才开的那个 `set -e` 同样
        // 算,而循环之后才开的那个管不着它（`while true; do :; done; set -e` 照拦）。
        if (endless && !regionHas(scan, i, end, ESCAPES) && !(errexit >= 0 && errexit <= end)) {
          // `fragile`:这个判定经不起「下游先退出」—— 由下面那个 `|` 兑现（见文件头 ⑧）。
          pipeline = { what: "while true / until false", assumesAnyExists: [], fragile: true };
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
      // 跟随型带着**它自己的前提**（`assumesAnyExists`，见文件头 ⑧）,而且不怕下游先退出
      // （输出是间歇的,那一次写入可能永远不发生）—— 所以 `fragile: false`。
      const hit = followerOf(cmd.name, cmd.argv);
      if (hit) pipeline = { ...hit, fragile: false };
    }
    // `exec cmd` 把本进程换成 cmd（`WRAPPERS` 已经让上面按 cmd 判过了）—— 它之后的都跑不到。
    if (cmd && headOf(tokens, at) === "exec") return pipeline;
    // 收尾符号决定下一条（见 `Sep`）。注意读的是 `segs[i]`:上面跳过整区时 `i` 已经挪到那个
    // 区的收尾段上,要的正是**那一段**的符号（`fi && tail -F x` 里的 tail 就证明不出会跑）。
    switch (segs[i]!.sep) {
      case "&": pipeline = null; reach = base(); break;         // 放后台 ⇒ 这一条判定作废
      case "&&": case "||": reach = false; break;
      // 管道各级都会跑,但**下游先退出会把管子关掉**（见文件头 ⑧）:恒真循环靠「stdout 一直
      // 有人收」才永不退出,这里一出现下游就证明不出来了 —— `while true; do printf 'DONE\n';
      // done | head -n 1` 实测打一行就退出 0。下游自己是跟随型的那种由它再记一次（`tail -f x |
      // while true; do :; done` 照拦）。
      case "|": if (pipeline?.fragile) pipeline = null; break;
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

function judge(command: string): Found | null {
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
  return neverExitsVerdict(command)?.what ?? null;
}

/** 一个硬拦判定对外的样子:判它的那个写法 + **这个判定的前提**（见文件头 ⑧）。 */
export type NeverExitsVerdict = {
  /** 判定它的那个写法（`tail -f/-F`、`while true / until false`），给拒绝文案用。 */
  what: string;
  /**
   * 「**只要这几个路径里有一个还在**，这条命令就不会自己退出」—— 空数组 = 这个判定不依赖任何
   * 本地路径（见文件头 ⑧ 第 3 条）。
   *
   * 这一层**读不出**它们在不在（表单跑在浏览器里，判据也不该去碰文件系统），所以它只交出
   * 前提:读得出来的那一层核得了就核（创建闸知道 cwd），核不了的照实说出这个前提。
   */
  assumesAnyExists: readonly string[];
};

/**
 * 同一个判据，连**前提**一起要（见 `neverExitsOnItsOwn`，两者共用一份实现）。
 *
 * 创建闸用这一个:它知道这条哨兵将在哪个工作目录里跑，于是「那个文件在不在」这件事在它那儿
 * 是读得出来的事实，不是猜（新一轮审查 F1 第 3 条）。
 */
export function neverExitsVerdict(command: string): NeverExitsVerdict | null {
  try {
    const found = judge(command);
    return found ? { what: found.what, assumesAnyExists: found.assumesAnyExists } : null;
  } catch (err) {
    console.error(`[ash] 命令结构判据出错,这条命令按「读不懂」放行：${String(err)}`);
    return null;
  }
}
