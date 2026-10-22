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
//        退出、随后打出 DONE。`tail -f FILE` 的「不退出」压着一个前提:**那个文件在**
//        （`-F`/`--retry` 才是没了也一直重试）。这一版把前提交出去、让创建闸拿 `existsSync`
//        去核 —— **那条路第 2 轮审查证伪了,见 ⑩**。
// ⑨ **核不了的前提不配做硬拦的依据；「下游会不会一直读到头」同样是退出语义**（新一轮审查
//    F1）。⑧ 把前提交出来了,可处置只做了一半 —— 核得出「那个文件不在」的那一种放行,**核不了
//    的那几种照旧硬拦**。于是三类会自己结束的命令继续被 409（审查实测）:
//      · `cd sub; tail -f really-here.log; printf 'DONE\n'` —— 那个文件在**起初**那个工作目录
//        里、`sub/` 里没有,真 shell 报一句 No such file 就退出 0。而创建闸核的是「起初那个
//        cwd 下的路径」:命令自己换过目录之后,它核的根本不是 tail 要打开的那一个。
//      · `tail -f $LOG`、`tail -f *.log` —— 这个路径指向哪儿谁都读不出来,而上一版「读不出来
//        就维持原判」= 照旧硬拦。
//      · `kubectl logs -f <pod>` —— 远端那个东西在不在,本机和创建闸都核不了
//        （command-followers.ts 文件头 ⑤）。
//    以及反过来的一类:
//      · `tail -f -n +1 large.log | head -n 1`（预填 350KB）—— 跟随型**也怕下游先退**:head 打
//        一行就把管子关掉,tail 下一次写入吃 SIGPIPE,整条退出 0。而上一版只让恒真循环因下游
//        作废（`fragile`）,跟随型一律记成「不怕」。
//    所以这一版把前提分成两种:**核得了的**（本地字面路径,创建闸读得出）与**谁都核不了的**
//    （`$LOG`/通配、命令自己换目录、同一条命令里别的段动过它、远端资源）。下游那一侧同理:只有
//    **证明得出读到 EOF 才退**的下游才保得住上游那个判定,`head`、`grep -m1`、自己写的脚本一律
//    算「可能先走」。—— 这两条的方向对了,但**前一种前提根本不存在**,见 ⑩。
// ⑩ **「核得了的前提」是个幻觉;下游得按参数角色读,不按操作数个数**（第 2 轮审查 F1）。⑨ 留下
//    的那个中间档（本地字面路径交给创建闸 `existsSync` 去核）被两条命令同时推翻:
//      · `rm ./doomed.log; tail -f doomed.log; printf 'DONE\n'` —— 9ms 退出 0,却被 409。创建闸
//        读得到的是「**创建这一刻**文件在不在」,而判定要的是「**执行到那一句时**在不在」,中间
//        隔着这条命令前面的每一段。我拿「这个路径词在整条命令里出现过几次」去补这个缝,而
//        `./doomed.log` 与 `doomed.log` 是同一个文件、不是同一个词 —— 那是在穷举拼写。
//      · `while true; do printf x; done | grep -e one reader.log` —— 7ms 打完 `one`、`DONE`
//        退出 0,参数完全合法、无错误输出,照旧 409。`-e` 已经把模式给了,剩下那个操作数是
//        **文件**;上一版只数「剥掉开关后剩几个操作数」,于是把「读一个有限文件就退」读成了
//        「一直读管子」。同一个缺口还覆盖 `tr`／`tr ab`／`cut`／`sort -t xx`／`nl -w nope`／
//        `grep '['` —— 它们都在**读管子之前**就打一句用法或参数错误退出。
//    所以这一版:**路径前提整档移出硬拦**（没有哪一层核得了执行时刻的文件系统状态,一律降级成
//    提示,`existsSync` 那道核查连同它那张拼写表一起删掉）;**下游按参数角色判**（必需参数齐不
//    齐、值形状对不对、除了管子还有没有别的输入、模式会不会编译失败 —— 见
//    command-followers.ts 文件头 ⑥）。闸剩下的牙在「压根不要这种前提」的那一档:`tail -F`、
//    `while true`、`journalctl -f`,加上一个证明得出会读到头的下游 —— 事故的起因命令
//    （`tail -F build.log 2>/dev/null | grep --line-buffered ERROR`）正落在这一档,照旧硬拦。
//
// ⑪ **硬拦的证明压着「默认执行环境」这个前提,而命令自己就能把它掀翻**（第 1 轮审查 F1）。
//    ⑩ 把「执行时刻才知道」的那一类前提都降了级,可降掉的只有**外部**那一类（文件、远端资源、
//    下游进程）——「shell 自己照常执行每一段、那个工具启动得起来、没人把这个进程结束掉」这一条
//    一直当成不言自明的背景。于是四种会自己结束的命令照旧被 409（审查实测,真 shell 全部退出,
//    本轮已逐条复核）:
//      · `while true; do eval 'break'; done; printf 'DONE\n'` —— 打出 DONE 退出 0。那个
//        `break` 在引号里,`ESCAPES` 扫的是词、扫不进 eval 的字符串,于是「这个循环没有出路」
//        被当成了证明。文件头 ① 当年就写着「`eval` 这种读不懂的形状不拦」,而代码里**从来没有
//        实现过它**。
//      · `set -n; while true; do :; done` —— 退出 0。`-n` 的意思是「把命令读完、一条都不执行」,
//        而这一层只登记过 `set -e` 一种语义。
//      · `while true; do kill -TERM $$; done` —— 当场被 SIGTERM 结束。能终止这个 shell 的调用
//        不只有 `break`/`exit`/`return` 那三个词。
//      · `PATH=/definitely-missing-ash-review; tail -F /dev/null` —— 退出 127,一句
//        `tail: command not found`。跟随型的「不退出」压着一个前提:那个工具找得到。
//    所以这一版把那个背景前提**写出来,并且交给命令自己去推翻**:硬拦的证明以「默认执行环境」
//    为前提 —— 那不是待证项,否则磁盘满、外部信号、ulimit 都能让任何命令退出,闸直接归零;而
//    **命令里任何动摇这个前提的写法、或者另开一层这一层读不进去的执行**,都让整条证明失效 ⇒
//    降级成提示（`perturbed`）。判据是**我认得的那一种**,不是我见过的反例:`set` 只认得
//    errexit,别的开关一律算未知 —— 跟⑩在下游那一侧用的是同一条口径（「不认识 ⇒ 降级」）。
//    不按 eval / kill / set 各补一条字符串特判:那条路本轮审查明确点掉了（「不要再分别添加
//    eval、kill、set 的字符串特判」),补一条它就再长出第四种。
//
//
//    ①–⑪ 合起来是同一条不变量:**硬拦只用「盖得住整条命令必要执行与退出语义」的那种证明**
//    —— 执行资格（这一条跑不跑得到）、argv（它到底有没有开始跟随）、输入来源（它盯的是谁）、
//    shell 状态（前面那条的退出码管不管得着它）、下游（谁在收它的 stdout、而且会不会一直读
//    到头）、它盯的那个东西在不在、以及**执行环境本身还是不是常规的那一套**（⑪）,任一项读不
//    出来**就不是硬拦的依据**,降级成一句可提交的提示。**而「读得出来」是指真的有人核得了**(⑨):前提核不了的时候,「我证明不出它不成立」
//    不等于「它成立」—— 那一步偷换过去,就是拿一个没人核过的假设去把一件做得成的事变成做不成。
//    **而「有人核得了」还得问一句「他核的是那个时刻吗」**(⑩):能读文件系统不等于核得了这件事
//    —— 读到的是此刻,要的是执行到那一句时,中间隔着整条命令。证明只建立在**执行开始前就已经
//    定下来、而且语法封闭**的东西上（argv、shell 结构）;凡是要等到执行时才知道的（文件在不
//    在、远端资源、下游进程的行为）一律降级。**而「语法封闭」还得加一句「语义也封闭」**(⑪):
//    `eval` 的参数、`set` 的未知开关、`kill`、被改过的 `PATH` 都写在 argv 里、语法上严丝合缝,
//    可它们的意思是「后面那几段按另一套规矩走」—— 读得见不等于读得懂。不按网页、HTTP、hook
//    各补一个特例:这三处共用的就是这一个函数。
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
import { blankComments, blankQuoted, segments, type Segment, type Token } from "./command-lex.ts";
import { followerOf, readsToEof } from "./command-followers.ts";
import { commandOf } from "./command-wrappers.ts";

// **另外两张表在隔壁**（单文件 700 行的约定）:哪些命令的语义是「盯着不走」、它们的 argv 读不
// 读得懂,归 command-followers.ts（见 `followerOf`）;哪些词只是包一层、剥掉它们之后真正要跑的
// 是谁,归 command-wrappers.ts（见 `commandOf`）。这边只按它们的判据组合,不认具体的工具。


/**
 * 一个判定 —— 判它的那个写法 + 它压着的那个前提。形状跟对外那个 `NeverExitsVerdict` 一样。
 *
 * `unprovable` 有值 = 这个判定压在一个**没人核得了**的前提上（见文件头 ⑨⑩），于是它只配做
 * 一句提示:它要盯的那个文件/目录执行到那一步时还在不在、远端资源在不在、下游会不会一直读到
 * 头。`null` = 这边自己就证明得出 ⇒ 硬拦。**没有第三种** —— 上一版那个「交出去让别人核」的
 * 中间档被第 2 轮审查证伪了（见文件头 ⑩）。
 */
type Found = { what: string; unprovable: string | null };

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
          // 这个判定里藏着「它的 stdout 一直有人收」—— 由下面那个 `|` 去问下游（见文件头 ⑨）。
          pipeline = { what: "while true / until false", unprovable: null };
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
      // 跟随型带着**它自己的两种前提**（见文件头 ⑧⑨）:核得了的那几个本地路径、以及核不了
      // 的那一句（远端资源）。原样收下 —— 这一层不替谁去核,也不替谁抹掉。
      const hit = followerOf(cmd.name, cmd.argv);
      if (hit) pipeline = hit;
    }
    // `exec cmd` 把本进程换成 cmd（`WRAPPERS` 已经让上面按 cmd 判过了）—— 它之后的都跑不到。
    if (cmd && headOf(tokens, at) === "exec") return pipeline;
    // 收尾符号决定下一条（见 `Sep`）。注意读的是 `segs[i]`:上面跳过整区时 `i` 已经挪到那个
    // 区的收尾段上,要的正是**那一段**的符号（`fi && tail -F x` 里的 tail 就证明不出会跑）。
    switch (segs[i]!.sep) {
      case "&": pipeline = null; reach = base(); break;         // 放后台 ⇒ 这一条判定作废
      case "&&": case "||": reach = false; break;
      // 管道各级都会跑,但**下游先退出会把管子关掉**（见文件头 ⑨）。上游那个判定都藏着同一
      // 条前提 —— 恒真循环靠「stdout 一直有人收」、跟随型靠「它下一次写入还写得出去」——
      // 所以这里问一句下游:只有**证明得出读到 EOF 才退**的那几种保得住它（`readsToEof`;事故
      // 的起因命令里那个 `grep --line-buffered ERROR` 正是一个,所以它照旧硬拦）。其余一律降
      // 级成提示:`… | head -n 1` 实测退出 0,而 `tail -f x | grep -m1 y` 日志一安静又真的挂
      // 住 —— 两边都证明不出来,那就不是硬拦的依据。
      //
      // 下游自己是跟随型/恒真循环的那种由它**再记一次**（`tail -f x | while true; do :; done`
      // 照拦）:那一段会把 `pipeline` 整个换成它自己的判定。
      case "|": {
        if (pipeline) {
          const next = pipeTarget(segs, i + 1);
          if (!next || next.bounded || !readsToEof(next.name, next.argv)) {
            pipeline = { ...pipeline, unprovable: downstreamNote(next?.name ?? null) };
          }
        }
        break;
      }
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

/**
 * `|` 之后那一级的命令（剥掉骨架词和包装层）。读不出来就是 `null` —— 那一侧的「读不懂」等于
 * 「下游可能先走」（见文件头 ⑨）。
 */
function pipeTarget(segs: Segment[], at: number): { name: string; argv: Token[]; bounded: boolean } | null {
  const seg = segs[at];
  if (!seg) return null;
  let from = 0;
  while (from < seg.tokens.length) {
    const head = headOf(seg.tokens, from);
    if (head && SKELETON.has(head)) { from += 1; continue; }
    break;
  }
  return from < seg.tokens.length ? commandOf(seg.tokens, from) : null;
}

const downstreamNote = (name: string | null): string =>
  `下游${name ? `那个 ${name} ` : ""}会不会一直读到头，这一层读不出来 —— 它先收工就把管子关掉了`;

/**
 * **这条命令自己动摇了「默认执行环境」这个前提吗** —— 动摇了就说是哪一处（见文件头 ⑪）。
 *
 * 硬拦的证明压着一个说不出口的前提:shell 按常规语义执行每一段、工具找得到、没人把这个进程
 * 结束掉。那个前提不是待证项,它是哨兵这个功能本身的运行假设 —— 不然任何命令都可能因为磁盘
 * 满、信号、ulimit 而退出,硬拦就归零了。可**命令自己就能把这个假设掀翻**,而那几种写法全都
 * 写在 argv 里、这一层本来就看得见。
 *
 * 所以这里问的不是「它会不会结束」,而是「我这一层还读得懂它的执行语义吗」。读不懂 ⇒ 整条
 * 证明失效 ⇒ 降级成提示。**判的是「我认得的那一种」而不是「我见过的反例」**:`set` 只认得
 * errexit 这一种语义,别的开关(`-n` 就是「读而不执行」)一律算未知 —— 列反例的那条路第 1 轮
 * 审查已经点明是走不通的。
 */
const SHAKERS = new Map<string, string>([
  ["eval", "那个 eval 跑的是一段这一层读不进去的代码"],
  ["source", "那个 source 把另一个文件的内容当代码跑"],
  [".", "那个 . 把另一个文件的内容当代码跑"],
  ["trap", "那个 trap 挂的是一段收到信号才跑的代码"],
  ["kill", "那个 kill 可以把这条命令自己结束掉"],
  ["ulimit", "那个 ulimit 改掉了这条命令自己的资源上限"],
  ["shopt", "那个 shopt 改掉了 shell 的执行选项"],
  ["setopt", "那个 setopt 改掉了 shell 的执行选项"],
]);
/** 给 `PATH` 赋值 ⇒ 后面那些工具还找不找得到,这一层读不出来（`PATH=/missing; tail -F x` 实测 127）。 */
const PATH_ASSIGN = /^PATH=/;
/** 这一段开头那几个**结构骨架词**:要跳过它们才轮到真正的命令词（判据同 `provableBlocker`）。 */
const isSkeleton = (head: string): boolean =>
  SKELETON.has(head) || LOOP_HEADS.has(head) || BRANCH.has(head);

/**
 * `set` 的开关里**第一个这一层没有处置的** —— 全都有处置就是 `null`。
 *
 * **白名单,不是黑名单**:认得的那几个放过,其余一律算未知（同⑩在下游那一侧的口径）。反过来
 * 列「哪几个危险」就是列反例 —— `set -n`（读完一条都不执行，实测退出 0 而恒真循环照旧被 409）
 * 只是第一个被抓到的,`-C` 挡得住重定向、`-f` 改通配展开,一张黑名单永远差下一个。
 *
 * 放过的三件事各有理由:`errexit` 这边有专门的处置（`errexitAt`）;`xtrace`/`verbose` 只是把执行
 * 过程打出来,一个字的执行语义都不改。**`+` 那一侧同样放过** —— 它是关掉,而这三个本来就默认
 * 关着（`set +e; false; tail -F x` 真 shell 里照旧挂住，是选定要拦的真阳性）。
 *
 * **明知的误降级:`set -eu` 这一类**。`-u`（未定义变量当错误）只在命令里真的引用了未定义变量
 * 时才改变结局,而「有没有引用、引用的定义了没有」这一层答不出来 —— 于是 `set -eu; tail -F x`
 * 从硬拦降成提示。代价方向是对的那一侧:提示照样说得清,人照样能提交（见文件头那段不对称）。
 * 想把它收回硬拦,得先拿出「这条命令里每个变量都定义过」的证明,而不是把 `-u` 塞进白名单。
 */
const SET_HANDLED = new Set(["errexit", "xtrace", "verbose"]);
const SET_SHORT = /^[-+][exv]+$/;
function setShaken(argv: readonly Token[]): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i]!;
    if (t.quoted) return t.text;                 // 引号里的开关这一层读不出来
    if (!/^[-+]/.test(t.text)) break;            // 开关列表到此为止（后面是位置参数）
    if (/^[-+]o$/.test(t.text)) {
      const name = argv[i + 1];
      if (name && !name.quoted && SET_HANDLED.has(name.text)) { i += 1; continue; }
      return name ? `${t.text} ${name.text}` : t.text;
    }
    if (!SET_SHORT.test(t.text)) return t.text;
  }
  return null;
}

/**
 * 整条命令里第一处「执行语义这一层读不懂」的地方 —— 没有就是 `null`（见 `SHAKERS`）。
 *
 * **不管执行资格,每一段都看**:`if false; then eval x; fi` 里那个 `eval` 确实跑不到,可
 * 「跑不到」这个结论本身也是这一层算出来的 —— 真要分清就得先读懂 eval。偏放行那一侧 ⇒ 一律算。
 *
 * **只认命令词位置**（文件头 ①）:`find . -name x`、`grep kill log` 里那两个词是参数,不是
 * 执行节点。`PATH=` 是唯一一个按整段词扫的 —— 它作为赋值前缀时压根不在命令词位置上。
 */
function perturbed(segs: Segment[]): string | null {
  for (const seg of segs) {
    for (const t of seg.tokens) {
      if (!t.quoted && PATH_ASSIGN.test(t.text)) return "前面有一段改过 PATH，后面那些工具还找不找得到";
    }
    let at = 0;
    while (at < seg.tokens.length && isSkeleton(headOf(seg.tokens, at))) at += 1;
    const cmd = at < seg.tokens.length ? commandOf(seg.tokens, at) : null;
    if (!cmd) continue;
    const note = SHAKERS.get(cmd.name);
    if (note) return note;
    if (cmd.name === "set") {
      const flag = setShaken(cmd.argv);
      if (flag !== null) return `那个 set 开的是 ${flag}，它改掉了后面每一条的执行语义（这一层只认得 errexit）`;
    }
  }
  return null;
}

function judge(command: string): Found | null {
  // **读不出执行资格的结构 ⇒ 整条命令放行**（见文件头 ②）。here-doc 的终止词、函数体到底
  // 调没调过，这一层都只能猜；猜错的那一半代价是「一件做得成的事做不成」。
  const plain = blankComments(blankQuoted(command));
  if (HERE_DOC.test(plain) || FUNC_DEF.test(plain)) return null;
  // 前提核不核得了这一问**不在这一层**:它压根不该由「哪个路径 + 谁动过它」这种拼写分析来
  // 答（第 2 轮审查证伪,见文件头 ⑩）。工具目录那一层直接交出「这件事没人核得了」那句话,
  // 这里只负责把它一路带出去。
  const segs = segments(command);
  const found = provableBlocker(scanOf(segs));
  // **扰动这一问排在最后,而且只改硬拦那一档**（见文件头 ⑪）。压根没判定 ⇒ 没什么可提示的;
  // 已经降过级 ⇒ 它自己那句话更具体（说的是哪个文件、哪个下游）,不拿这句通用的盖掉它。
  if (!found || found.unprovable) return found;
  const shaken = perturbed(segs);
  return shaken ? { ...found, unprovable: `${shaken}，它会不会让这条命令提前结束，这一层读不出来` } : found;
}

/**
 * 这条命令**自己永远不会结束**吗。
 *
 * 返回那个判定它的写法（给拒绝文案用），不是的话返回 `null`。只回答形状，不回答意图 ——
 * 「永不退出」本身不是错，错的是**既永不退出、又没有任何别的结束条件**。
 *
 * **前提谁都核不了的那一种在这儿算「不是」**（见文件头 ⑨）:它只配做一句提示,而这个入口答的
 * 是「这一层自己就够资格硬拦吗」。要那句提示（以及那几个交给创建闸去核的路径）就用
 * `neverExitsVerdict`。
 *
 * **对任意字符串都是全函数:它只会回答,不会抛**（第 2 轮审查 F1）。调用它的两处都受不起一个
 * 异常:表单在**每次渲染**里同步调用它（判据一抛,整棵组件树卸载 —— 审查实测页面变成空白),
 * 创建入口在起进程之前调用它（判据一抛,真实路由 500）。而「这条命令读不懂」本来就有一个
 * 确定的答案:**不拦**。所以这一层把异常也归到那个答案里,同时把它吼到日志里 —— 判据自己
 * 有 bug 要能被发现,只是不该由用户那一侧用「做不成事」来承担（见文件头那段不对称）。
 */
export function neverExitsOnItsOwn(command: string): string | null {
  const verdict = neverExitsVerdict(command);
  return verdict && !verdict.unprovable ? verdict.what : null;
}

/** 一个硬拦判定对外的样子:判它的那个写法 + **这个判定的前提**（见文件头 ⑧）。 */
export type NeverExitsVerdict = {
  /** 判它的那个写法（`tail -f/-F`、`while true / until false`…），给文案用。 */
  what: string;
  /**
   * 这个判定压在一个**没人核得了**的前提上吗 —— 是就是那句话，不是就 `null`（见文件头 ⑨⑩）。
   *
   * 非 `null` ⇒ **不许硬拦**:照原样放行，把这句话随这次创建一起说出来（创建闸的 `advice`）。
   * `null` ⇒ 这边自己就证明得出，该逼一个结束条件出来。
   */
  unprovable: string | null;
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
    return found
      ? { what: found.what, unprovable: found.unprovable }
      : null;
  } catch (err) {
    console.error(`[ash] 命令结构判据出错,这条命令按「读不懂」放行：${String(err)}`);
    return null;
  }
}
