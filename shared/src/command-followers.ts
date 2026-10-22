// **哪些命令的语义就是「盯着不走」** —— 以及这一条的 argv 读不读得懂。
//
// 从 command-never-exits.ts 拆出来(单文件 700 行的约定)。拆的是第三种问题:那边答「这几段
// 里有没有一条证明得出会跑」,词法层答「这串字符分成哪些词」,这边答**「这一个命令会不会
// 自己收工」** —— 一张工具目录加一份 argv 规矩,跟推理无关,改一个工具的开关不该动判据。
//
// ── 「它是跟随型」不等于「它一定跟随」 ────────────────────────────────────────────
//
// 上一版只问一句「argv 里有没有那个跟随开关」,于是 `tail -F -n not-a-number /dev/null` 被
// 硬拦（第 2 轮审查 F2 实测:`tail` 在校验参数那一步就 illegal offset 退出,整条命令打完
// DONE 退出 0）。**同一条 argv 里的别的参数可以让它根本没开始跟随**,而那恰恰是写在输入里
// 的东西,不是「二进制可能没装」那种无穷外部假设。
//
// 所以这边的判据是三道，缺一不可：
//
//  ① **这条 argv 全是我认得的东西**（`operandsIfUnderstood`）。认得的开关逐个列在下面每个
//     工具的 `opts` 里,带值的那些连**值长什么样**一起列（`-n` 要数字）。出现认不出来的开关、
//     或者值不对形状 ⇒ 这条命令会不会收工**答不出来** ⇒ 不拦。少列一个开关 = 退回今天的行为;
//     多认一个 = 一件做得成的事做不成了（见 command-never-exits.ts 文件头那段不对称）。
//  ② 跟随开关确实出现了（`follows`）。
//  ③ **它盯的那个东西写在 argv 里**（同在 `follows`,见下面那一节）。
//
// 故意**不列**进 `opts` 的那几类开关，列进去就等于把一条会自己结束的命令说成不会：
//  · 自己带死线的（`inotifywait -t 60`、`docker logs --until=…`）—— 到点就退
//  · 打一行就退的（`--help`、`--version`）
//  · 值这一层证明不出来的（任何需要「那个东西存在」才成立的参数）
//  · **给这条命令开了一条出口的**（`tail --pid=`:那个进程一死它就退;`watch -e/-g`:出错/有
//    变化就退;`inotifywait -d`:转后台,前台这一个当场退）—— 白名单只确认「我认识这个开关」
//    是不够的,认得它、还得知道它不会给这条命令开一条出口（第 1 轮审查 F1 同类）
//
// ── ③ 「盯的是谁」也得写在 argv 里 ───────────────────────────────────────────────
//
// 第 1 轮审查 F1 实测：`printf 'DONE\n' | tail -f` 几毫秒就打完 DONE 退出 0,却被
// 硬拦。`tail -f` **不带文件操作数**时盯的是标准输入,它会不会一直盯着取决于管道那头是什么:
// 读到 EOF 就退（BSD tail 干脆把 `-f` 忽略掉）,而换成 `/dev/null` 或终端又能一直挂着。
// 「那头是什么」不写在命令文本里 —— **这一层答不出来,所以统一降级**,不是给管道补一个特例。
//
// 于是每个工具都得说清**它盯的那个东西有没有写在 argv 里**（`follows` 的第二个参数就是真正
// 的操作数）：tail 要文件、inotifywait/fswatch 要路径、`… logs -f` 要容器名;`journalctl -f`
// 盯的是日志本身,不要操作数。少要一个 ⇒ 一条会自己结束的命令被 409。
//
// ── ④ 「它盯的那个东西在不在」:这一层只交出前提,不自己断言 ──────────────────────────
//
// 新一轮审查 F1 实测:`tail -f /definitely-missing-ash-review; printf 'DONE\n'` 报一句 No such
// file or directory 就退出、随后打出 DONE（退出 0）—— 而它被硬拦。`tail -f FILE` 的「不退出」
// 藏着一个前提:**那个文件现在就在**。`-F`/`--retry`/`--follow=name` 是「没了也一直重试」,它
// 不要这个前提。
//
// 而文件在不在**不写在命令文本里**。上一版把这个前提交出去、让「读得出来的那一层」(创建闸)
// 拿 `existsSync` 去核 —— **这条路第 2 轮审查证伪了**:它读得到的是「创建这一刻在不在」,而
// 判定要的是「执行到那一句时在不在」,中间隔着这条命令前面的每一段(`rm ./doomed.log;
// tail -f doomed.log` 创建时文件在、跑到那句时已经没了,真 shell 退出 0 却被 409)。拿同一个
// 路径词出现过几次去补这个缝也不行:`./doomed.log` 和 `doomed.log` 是同一个文件、不是同一个
// 词 —— 那是在穷举拼写,而拼写无穷。
//
// 所以这一类前提**没有哪一层核得了**,一律降级成一句提示(`FollowerHit.unprovable`,同远端那
// 一种)。闸剩下的牙在「压根不要这种前提」的那一档:`tail -F`/`--retry` 没了也一直重试、
// `journalctl -f` 盯的是日志本身、`while true` 什么都不要 —— 那几种这边自己就证明得出。
// ── ⑤ 「没人核得了的前提」与「下游会不会一直读到头」:照实交出来，一样不自己断言 ─────────
//
// 新一轮审查 F1 又实测到两条:
//  · `tail -f -n +1 large.log | head -n 1`（预填 350KB）—— tail 当场把前几 KB 写进管子,
//    `head` 打一行就退、把管子关掉,tail 下一次写入吃 SIGPIPE,整条退出 0。所以上一版那句
//    「跟随型不怕下游先退」**不成立**:怕不怕取决于**下游会不会一直读到头**,而那是下游那条
//    命令自己的 argv 说得清的事 —— 于是这边多一张目录（`CONSUMERS` / `readsToEof`）,只认
//    「证明得出读到 EOF 才退」的那几种,认不出来的一律算「下游可能先走」。
//  · `kubectl logs -f <pod>`、`docker|podman logs -f <容器>` —— 那个 pod/容器不在、或者已经
//    停了的时候,它们同样是报一句错就退。而「远端那个东西在不在」**谁都核不了**:本机读不出
//    来,创建闸也读不出来。所以这种前提也照实交出来（`FollowerHit.unprovable`）,而不是当成
//    「没有前提」—— 后者等于拿一个没人核过的假设去硬拦（判据文件头 ⑨ 的那条不变量）。
//
// ── ⑥ 下游那张表按**参数角色**读，不按操作数个数 ──────────────────────────────────
//
// 第 2 轮审查把上一版这张表整个掀了:它只拿「剥掉开关之后剩几个操作数」当判据,于是
//  · `P | grep -e one reader.log` —— `-e` 已经把模式给了,剩下那个 `reader.log` 是**文件**,
//    grep 读完它就退、压根不碰管子(实测 7ms 退出 0,参数合法、无错误输出),却被 409;
//  · `P | tr`、`P | tr ab`、`P | cut`、`P | sort -t xx`、`P | nl -w nope`、`P | grep '['`
//    —— 全都在**读管子之前**就打一句用法/参数错误退出,同样被 409。
//
// 所以这张表的每一项要答三问,缺一不可:
//  ① **必需参数齐不齐**(`tr` 的字符集个数、`cut` 的 `-b/-c/-f`)—— 不齐就是用法错误;
//  ② **值的形状对不对**(`-t` 要单字符、`-w` 要数字)—— 判不了的开关干脆不列进 `opts`,
//     于是认不出来、整条降级(这比写一条宽松的 `WORD` 安全:宽松等于替它说「这个值合法」);
//  ③ **除了管子还有没有别的输入**(文件操作数)、以及**模式本身会不会编译失败**。
//
// 三问全过才算证明得出。判错的方向永远是「降级成提示」—— 代价是多一句提示,反过来是一件
// 做得成的事做不成了。
import type { Token } from "./command-lex.ts";

/** 一个开关的形状 + 它的值要长什么样（`value` 不填 = 这个开关不吃值）。 */
type Opt = { re: RegExp; value?: RegExp };

/** 行数/字节数这类计数参数:`100`、`+100`、`-100`、`10k`。 */
const COUNT = /^[+-]?\d+[bkKmMgG]?$/;
/** 秒数:`5`、`0.5`。 */
const SECONDS = /^\d+(?:\.\d+)?$/;
/** 一个非空的词（名字、标签、容器名这类「随便什么字都合法」的值）。 */
const WORD = /^[^\0]+$/;

/**
 * 「它要盯的那个东西,执行到那一步时还在不在」—— 这句话就是前提本身（见文件头 ④）。
 *
 * 为什么不交路径给上层去 `stat`:上一版交了,于是创建闸拿创建那一刻的 `existsSync` 当证明,
 * 而 `rm ./doomed.log; tail -f doomed.log` 在创建那一刻文件确实在、执行到那一句时已经被前一段
 * 删掉了（第 2 轮审查实测退出 0 却被 409）。两个时刻之间隔着这条命令的每一段,**没有哪一层
 * 读得出执行时的那个状态** —— 所以这一类一律只配做提示。
 */
const nowhereToCheck = (what: string, operands: readonly string[]): string =>
  `${what}${operands.join("、")}执行到那一步时还在不在，谁都读不出来 —— 前面那几段把它删掉、换掉都算`;

type Follower = {
  /**
   * 这条 argv **证明得出它会盯着不走**吗 —— 开关要对（见文件头 ①②），而且**要盯的那个东西
   * 写在 argv 里**（`operands`，见文件头 ③）。
   */
  follows: (argv: Token[], operands: string[]) => boolean;
  /** 它**认得的**全部开关（见文件头 ①）。 */
  opts: readonly Opt[];
  /** 判定它的那个写法，给拒绝文案用。 */
  what: string;
  /**
   * 它的跟随靠一个**没人核得了**的前提吗 —— 是就照实说出来那句话（见文件头 ④⑤）。
   *
   * 两类都走这里,因为它们核不了的理由是同一个:**要核的那件事在执行到那一步时才成立**。
   *  · `tail -f FILE` 要那个文件在。看着像本机读一下 `stat` 就知道的事,其实不是:读得到的是
   *    **这一刻**在不在,而判定要的是**执行到那一句时**在不在,中间隔着这条命令前面的每一段
   *    （`rm ./x; tail -f x` —— 第 2 轮审查实测退出 0）。
   *  · `… logs -f <名字>` 要那个远端 pod/容器在、还在跑。
   *
   * 不填 = 这个工具的跟随不要任何这种前提:`tail -F`/`--retry`（没了也一直重试）、
   * `journalctl -f`（盯的是日志本身）、`watch`（那条命令失败它也照旧每隔几秒再来一次）。
   * **闸剩下的牙就在这一档**:不要前提 ⇒ 这边自己证明得出 ⇒ 硬拦。
   */
  assumesOpaque?: (argv: Token[], operands: string[]) => string | null;
};

/** 这条简单命令**证明得出会盯着不走**时的判定内容（`followerOf` 的返回）。 */
export type FollowerHit = {
  /** 判定它的那个写法，给拒绝文案用。 */
  what: string;
  /**
   * 这个判定还压在一个**没人核得了**的前提上吗 —— 是就是那句话，不是就 `null`（见文件头 ④⑤）。
   *
   * 非 `null` ⇒ 判据那层会把这次硬拦作废、只留一句提示（判据文件头 ⑨ 的不变量）。
   */
  unprovable: string | null;
};

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

/**
 * 这条 `tail` 是「文件没了也一直重试」的那种吗（`-F`、`--retry`、`--follow=name`）。
 *
 * 重试型**不要求那个文件现在就在**（它会一直等它出现），所以它的判定不带前提;`-f` 要求 ——
 * 文件不在时它报一句 No such file 就退出（见文件头 ④）。`--` 之后不再有开关，同 `hasFlag`。
 */
function tailRetries(argv: Token[]): boolean {
  for (const { text, quoted } of argv) {
    if (quoted) continue;
    if (text === "--") return false;
    if (text === "--retry" || text === "--follow=name") return true;
    if (!text.startsWith("--") && text.startsWith("-") && /^-[^-]*F/.test(text)) return true;
  }
  return false;
}

/**
 * 跟随型：这些命令的语义就是「盯着不走」。
 *
 * 判据全部落在**那一条简单命令自己的 argv** 上（见 command-never-exits.ts 文件头 ①）。
 *
 * **放在管道里不一样**（见文件头 ⑤，上一版这里写的是「一样」）:下游先退就把管子关掉,它下
 * 一次往 stdout 写当场吃 SIGPIPE —— `tail -f -n +1 large.log | head -n 1` 实测退出 0。而
 * 「它会不会及时写出那一次」证明不出来（`tail -f x | grep -m1 y` 日志一安静就整条挂住）,所以
 * 下游那一侧只认**证明得出读到头才退**的那几种（`readsToEof`），其余一律降级成提示。
 */
const FOLLOWERS = new Map<string, Follower>([
  ["tail", {
    what: "tail -f/-F",
    // **要盯的文件得写在 argv 里**（见文件头 ③）:不带操作数时它盯的是标准输入,那头是什么
    // 这一层答不出来 —— `printf 'DONE\n' | tail -f` 几毫秒就打完 DONE 退出 0（实测）。
    follows: (a, operands) => operands.length > 0 && hasFlag(a, /^-[^-]*[fF]/, "--follow"),
    // **`-f` 的不退出压着一个前提:执行到那一句时那个文件还在**（见文件头 ④）—— `-F`/`--retry`
    // 没了也一直重试,所以只有那一种不带前提、这边才证明得出。
    assumesOpaque: (a, operands) => (tailRetries(a) ? null : nowhereToCheck("它要盯的 ", operands)),
    // `--pid=` **不在列**:那个进程一死它就退（见文件头 ② 最后一类）。
    opts: [
      // 可并写的无值开关。`-r`（倒序）**不在列**:BSD 的 usage 写着 `[-F | -f | -r]` 三者
      // 择一,`tail -rf x` 当场打用法就退（实测退出 0 并打出 DONE）,GNU 根本没有这个开关。
      { re: /^-[fFqv]+$/ },
      { re: /^-[nc][+-]?\d+[bkKmMgG]?$/ },                    // `-n100`
      { re: /^-[nc]$/, value: COUNT },                        // `-n 100`
      { re: /^-s$/, value: SECONDS },
      { re: /^--follow(?:=(?:name|descriptor))?$/ },
      { re: /^--(?:lines|bytes)=[+-]?\d+[bkKmMgG]?$/ },
      { re: /^--(?:retry|quiet|silent|verbose|zero-terminated)$/ },
      { re: /^--sleep-interval=\d+(?:\.\d+)?$/ },
      { re: /^--max-unchanged-stats=\d+$/ },
    ],
  }],
  ["watch", {
    what: "watch",
    // 没有活干的 `watch` 自己打一句用法就退 —— 那不是跟随（见文件头 ③）。
    follows: (_a, operands) => operands.length > 0,
    // `-e/--errexit`（出错就退）和 `-g/--chgexit`（有变化就退）**不在列**:它们正是给这条
    // 命令开出口的那种开关（见文件头 ② 最后一类）。
    opts: [
      { re: /^-[dtbpxw]+$/ },
      { re: /^-n$/, value: SECONDS },
      { re: /^-n\d+(?:\.\d+)?$/ },
      { re: /^--interval=\d+(?:\.\d+)?$/ },
      { re: /^--(?:differences|no-title|beep|exec|precise|no-wrap|color)$/ },
      { re: /^-c$/ },
    ],
  }],
  ["inotifywait", {
    what: "inotifywait -m",
    // 要盯的路径得写在 argv 里:`inotifywait -m` 没有路径时只打一句 No files specified
    // 就退（见文件头 ③）。
    follows: (a, operands) => operands.length > 0 && hasFlag(a, /^-[^-]*m/, "--monitor"),
    // 那几个路径**得在那一刻还在**:watch 不上的路径它当场报错退出（见文件头 ④）。
    assumesOpaque: (_a, operands) => nowhereToCheck("它要盯的 ", operands),
    // `-t`/`--timeout` **故意不在列**:它到点就退（见文件头 ②）。`-d`/`--daemon` 同理 ——
    // 它把活转进后台,前台这一个当场就退。
    opts: [
      { re: /^-[mrq]+$/ },
      { re: /^-e$/, value: WORD },
      { re: /^--event=/, },
      { re: /^--(?:monitor|recursive|quiet|no-dereference)$/ },
      { re: /^--format=/ },
      { re: /^--timefmt=/ },
      { re: /^--(?:exclude|excludei|include|includei)=/ },
      { re: /^--fromfile$/, value: WORD },
    ],
  }],
  ["journalctl", {
    what: "journalctl -f",
    follows: (a) => hasFlag(a, /^-[^-]*f/, "--follow"),
    // `--until=` 不在列:它读到那个时刻就收工。`-e`（跳到末尾）和 `-r`（倒序）也不在列 ——
    // 它们跟「一直跟随」是对着干的,证明不出来就不算（见文件头 ②）。
    opts: [
      { re: /^-[fkqa]+$/ },
      { re: /^-u$/, value: WORD },
      { re: /^--unit=/ },
      { re: /^-n$/, value: /^\d+$/ },
      { re: /^-n\d+$/ },
      { re: /^--lines=\d+$/ },
      { re: /^-o$/, value: WORD },
      { re: /^--output=/ },
      { re: /^--since=/ },
      { re: /^-p$/, value: WORD },
      { re: /^--priority=/ },
      { re: /^--(?:follow|no-pager|quiet|system|user|dmesg|all)$/ },
    ],
  }],
  ["kubectl", {
    what: "kubectl logs -f",
    // 要盯的那个东西得写在 argv 里:`kubectl logs -f` 少了名字只会打一句用法就退（见文件头 ③）。
    follows: (a, operands) => operands[0] === "logs" && operands.length > 1
      && hasFlag(a, /^-[^-]*f/, "--follow"),
    // **远端那个东西在不在,谁都核不了**（见文件头 ⑤）:它不在、或者已经停了的时候,这条命令
    // 同样是报一句错就退。照实交出去,别拿一个没人核过的假设去硬拦。
    assumesOpaque: (_a, operands) => nowhereToCheck("远端那个 pod ", [`「${operands[1]}」`]),
    // `-p`/`--previous` 不在列:那是**已经结束的那个容器**的日志,跟都跟不住 —— 流一到头就退。
    opts: [
      { re: /^-f$/ },
      { re: /^-n$/, value: WORD },
      { re: /^--namespace=/ },
      { re: /^-c$/, value: WORD },
      { re: /^--container=/ },
      { re: /^-l$/, value: WORD },
      { re: /^--selector=/ },
      { re: /^--tail=-?\d+$/ },
      { re: /^--since=/ },
      { re: /^--(?:follow|timestamps|all-containers|prefix|ignore-errors)$/ },
    ],
  }],
  ["docker", {
    what: "docker logs -f",
    // 要盯的那个东西得写在 argv 里:`docker logs -f` 少了名字只会打一句用法就退（见文件头 ③）。
    follows: (a, operands) => operands[0] === "logs" && operands.length > 1
      && hasFlag(a, /^-[^-]*f/, "--follow"),
    // **远端那个东西在不在,谁都核不了**（见文件头 ⑤）:它不在、或者已经停了的时候,这条命令
    // 同样是报一句错就退。照实交出去,别拿一个没人核过的假设去硬拦。
    assumesOpaque: (_a, operands) => nowhereToCheck("远端那个容器 ", [`「${operands[1]}」`]),
    // `--until=` 不在列:到那个时刻就退。
    opts: [
      { re: /^-[ft]+$/ },
      { re: /^-n$/, value: /^(?:all|\d+)$/ },
      { re: /^--tail=(?:all|\d+)$/ },
      { re: /^--since=/ },
      { re: /^--(?:follow|timestamps|details)$/ },
    ],
  }],
  ["podman", {
    what: "podman logs -f",
    // 要盯的那个东西得写在 argv 里:`podman logs -f` 少了名字只会打一句用法就退（见文件头 ③）。
    follows: (a, operands) => operands[0] === "logs" && operands.length > 1
      && hasFlag(a, /^-[^-]*f/, "--follow"),
    // **远端那个东西在不在,谁都核不了**（见文件头 ⑤）:它不在、或者已经停了的时候,这条命令
    // 同样是报一句错就退。照实交出去,别拿一个没人核过的假设去硬拦。
    assumesOpaque: (_a, operands) => nowhereToCheck("远端那个容器 ", [`「${operands[1]}」`]),
    opts: [
      { re: /^-[ft]+$/ },
      { re: /^-n$/, value: /^(?:all|\d+)$/ },
      { re: /^--tail=(?:all|\d+)$/ },
      { re: /^--since=/ },
      { re: /^--(?:follow|timestamps|names)$/ },
    ],
  }],
  // `fswatch` 默认就是盯着不走，`-1` 才是「等第一次事件就退」。
  ["fswatch", {
    what: "fswatch",
    // 要盯的路径得写在 argv 里:没有路径的 `fswatch` 打一句用法就退（见文件头 ③）。
    follows: (a, operands) => operands.length > 0 && !hasFlag(a, /^-[^-]*1/, "--one-event"),
    // 那几个路径**得在那一刻还在**:不存在的路径 fswatch 报一句错就退（见文件头 ④）。
    assumesOpaque: (_a, operands) => nowhereToCheck("它要盯的 ", operands),
    opts: [
      { re: /^-[roxnut0v]+$/ },
      { re: /^-e$/, value: WORD },
      { re: /^-i$/, value: WORD },
      { re: /^--(?:exclude|include)=/ },
      { re: /^-l$/, value: SECONDS },
      { re: /^--latency=\d+(?:\.\d+)?$/ },
      { re: /^-m$/, value: WORD },
      { re: /^--monitor=/ },
      { re: /^--event=/ },
      { re: /^-f$/, value: WORD },
      { re: /^--format-time=/ },
      { re: /^--(?:recursive|one-per-batch|event-flags|numeric|timestamp|utc-time|print0|verbose)$/ },
    ],
  }],
]);

/** 一条 argv 读懂之后的样子:哪几个词是操作数、出现过哪些开关（带值的连值一起）。 */
type Parsed = {
  /** 真正的操作数（文件名、字符集、容器名…… 内容这一层不问）。 */
  operands: string[];
  /** 出现过的开关,带值的连它吃掉的那个词一起（下游那一侧要按**角色**读它，见文件头 ⑥）。 */
  switches: { text: string; value: string | null }[];
};

/**
 * 这条 argv **全是认得出来的东西**吗（见文件头 ①）—— 是就连它的操作数和开关一起交出来，
 * 不是就 `null`（「这条命令会不会收工答不出来」）。
 *
 * 操作数的内容这一层不问（文件名、容器名是什么都行）,但**哪几个词是操作数**得数对:带值的
 * 开关会把下一个词按它的值形状对一遍（值不对形状的那种恰恰是「它在校验参数那一步就退了」）,
 * 对上了就**连那个词一起吃掉** —— 不然 `kubectl logs -f -n ns` 里的命名空间会被数成「要盯的
 * 那个 pod」,而真 kubectl 少了 pod 名字只会打一句用法就退（见文件头 ③）。`--` 之后一律是
 * 操作数,引号里的词也是（`tail -F "my file"`）。单独一个 `-` 没有哪张表认它 ⇒ 整条降级。
 */
function parseIfUnderstood(f: { opts: readonly Opt[] }, argv: Token[]): Parsed | null {
  const operands: string[] = [];
  const switches: { text: string; value: string | null }[] = [];
  let done = false;                                   // 读到 `--` 了 ⇒ 后面全是操作数
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i]!;
    if (!done && !t.quoted && t.text === "--") { done = true; continue; }
    if (done || t.quoted || !t.text.startsWith("-")) { operands.push(t.text); continue; }
    const opt = f.opts.find((o) => o.re.test(t.text));
    if (!opt) return null;
    if (!opt.value) { switches.push({ text: t.text, value: null }); continue; }
    const v = argv[i + 1];
    if (!v || !opt.value.test(v.text)) return null;
    switches.push({ text: t.text, value: v.text });
    i += 1;
  }
  return { operands, switches };
}

/**
 * 这条简单命令**证明得出它会盯着不走**吗 —— 是就返回那个判定（含它压着的前提），否则 `null`。
 *
 * 三道都要过：这条 argv 全认得出来（`parseIfUnderstood`），跟随开关确实出现，而且**要盯的
 * 那个东西写在 argv 里**（后两道都在 `follows` 里，见文件头 ①②③）。任一道答不出来就是
 * `null` —— 「读不懂」的确定答案是不拦（见 command-never-exits.ts 文件头那段不对称）。
 *
 * 过了三道也**不等于证明得出**:`unprovable` 非空时这个判定压在一个没人核得了的前提上
 * （见文件头 ④⑤），判据那层会据此把硬拦作废。
 */
export function followerOf(name: string, argv: Token[]): FollowerHit | null {
  const f = FOLLOWERS.get(name);
  if (!f) return null;
  const parsed = parseIfUnderstood(f, argv);
  if (!parsed) return null;
  if (!f.follows(argv, parsed.operands)) return null;
  return { what: f.what, unprovable: f.assumesOpaque?.(argv, parsed.operands) ?? null };
}

/**
 * **下游读到头型**:证明得出「它会一直读到 EOF 才退」的那几种 —— 上游那个「永不退出」的判定
 * 靠的就是这一条（见文件头 ⑤⑥）。
 *
 * 这张表只往「不硬拦」那一侧偏:认不出来的下游（自己的脚本、带 `q`/`exit` 的 `sed`/`awk`、
 * `head`/`grep -q`/`grep -m`/`grep -l` 这种够了就走的）一律算**可能先走**,于是上游那个判定
 * 降级成一句提示。少认一个 = 多一条提示;多认一个 = 一条会自己结束的命令被 409。
 */
type Consumer = {
  /** 这条 argv 证明得出它**只能从管子读、而且读到 EOF 才退**吗（见文件头 ⑥ 的三问）。 */
  proves: (p: Parsed) => boolean;
  /** 它**认得的**全部开关（规矩同跟随型的 ①，共用 `parseIfUnderstood`）。 */
  opts: readonly Opt[];
};

/**
 * 绝大多数工具的那一问:**操作数一个都不许有**。
 *
 * 有操作数就是另一个输入源（`foo | cat x`、`grep X file` 读的是那个文件,管子那头它根本不碰
 * —— 第 2 轮审查实测 `P | grep -e one reader.log` 退出 0）,或者是一个这一层读不出死活的路径
 * （`tee out.log` 写不进去就报错）。两种都不配当「它会一直读到头」的证明。
 */
const NO_OPERANDS = (p: Parsed): boolean => p.operands.length === 0;

/** 这几个开关出现过吗（按**开关原文**问,所以并写的 `-ds` 也认得出来）。 */
const has = (p: Parsed, re: RegExp): boolean => p.switches.some((s) => re.test(s.text));

/**
 * 可能让这条命令**在读管子之前就报错退出**的模式写法。
 *
 * 第 2 轮审查实测 `P | grep '['`:BRE 下这个方括号没闭合,grep 打一句 brackets not balanced
 * 就退、整条命令退出 0。哪些写法合法要看 BRE/ERE/PCRE 三套语法加 `-E/-F/-P` 怎么给,这一层
 * 不打算判 —— **带结构的模式一律不算证明,纯字面的才算**（事故的起因命令
 * `grep --line-buffered ERROR` 正是纯字面,闸因此照旧咬得住它）。
 */
const STRUCTURED_PATTERN = /[[\](){}\\*+?|]/;

/**
 * `grep`（含 `egrep`/`fgrep`）。**「够了就走」的那几个开关一律不在列**:`-q`/`--quiet`（匹配到
 * 就退）、`-m N`/`--max-count`、`-l`/`-L`（报一个名字就退）、`-r`/`-R`（根本不读 stdin）——
 * 它们正是把管子提前关掉的那一类。
 *
 * 操作数怎么数要看**模式从哪来**（第 2 轮审查 F1 的那一条）:`-e`/`--regexp=` 给过模式之后，
 * 剩下的操作数全是文件,`grep -e one reader.log` 读完那个有限文件就退、压根不碰管子。
 */
const GREP: Consumer = {
  proves: (p) => {
    // `-f` 的模式写在一个文件里:那个文件在不在、里面写的是什么,这一层全读不出来。
    if (has(p, /^(?:-f|--file=)/)) return false;
    const given = p.switches.filter((s) => /^(?:-e|--regexp=)/.test(s.text));
    // 模式给过了 ⇒ 操作数**全是文件**,一个都不许有;没给过 ⇒ 第一个操作数就是模式,正好一个。
    if (p.operands.length !== (given.length > 0 ? 0 : 1)) return false;
    const patterns = given.length > 0
      ? given.map((sw) => sw.value ?? sw.text.replace(/^--regexp=/, ""))
      : p.operands;
    return patterns.every((pat) => pat.length > 0 && !STRUCTURED_PATTERN.test(pat));
  },
  opts: [
    { re: /^-[EFGPHivwxsoncbahz]+$/ },
    { re: /^-e$/, value: WORD },
    { re: /^-[ABC]$/, value: COUNT },
    { re: /^-[ABC]\d+$/ },
    { re: /^--(?:regexp|context|after-context|before-context|color|colour|binary-files|devices|label)=/ },
    { re: /^--(?:line-buffered|null-data|text|invert-match|ignore-case|word-regexp|line-regexp|only-matching|count|no-filename|with-filename|byte-offset|line-number|extended-regexp|fixed-strings|basic-regexp|perl-regexp|no-messages|color|colour)$/ },
  ],
};

/** `cut -f` 的字段表:`2`、`1-3`、`2-`、`1,4-6`。 */
const FIELD_LIST = /^\d+(?:-\d*)?(?:,\d+(?:-\d*)?)*$/;
/** 单个字符（分隔符）。 */
const ONE_CHAR = /^.$/;

const CONSUMERS = new Map<string, Consumer>([
  ["grep", GREP], ["egrep", GREP], ["fgrep", GREP],
  ["cat", {
    proves: NO_OPERANDS,
    opts: [{ re: /^-[nbeEstTvAu]+$/ }, { re: /^--(?:number|number-nonblank|show-ends|show-tabs|show-all|squeeze-blank|show-nonprinting)$/ }],
  }],
  // `tee` 一律读到头,但**它的操作数是要写进去的文件**:写不进去它会报错,所以只认不带文件的那种。
  ["tee", { proves: NO_OPERANDS, opts: [{ re: /^-[ai]+$/ }, { re: /^--(?:append|ignore-interrupts)$/ }] }],
  ["wc", {
    proves: NO_OPERANDS,
    opts: [{ re: /^-[lwcmL]+$/ }, { re: /^--(?:lines|words|bytes|chars|max-line-length)$/ }],
  }],
  // `sort` 更强一点:它要读完全部输入才开得了口。**`-k`/`-t`/`-o` 都不在列** —— `-t` 要单字符
  // 分隔符（第 2 轮审查实测 `sort -t xx` 打一句错就退）、`-k` 的字段语法这一层判不了、`-o`
  // 写不进去也报错。认不出的开关 ⇒ 整条降级,这正是要的那一侧。
  ["sort", {
    proves: NO_OPERANDS,
    opts: [
      { re: /^-[nrufbdihsVz]+$/ },
      { re: /^--(?:numeric-sort|reverse|unique|ignore-case|stable|human-numeric-sort|version-sort|zero-terminated)$/ },
    ],
  }],
  ["uniq", { proves: NO_OPERANDS, opts: [{ re: /^-[cdui]+$/ }, { re: /^--(?:count|repeated|unique|ignore-case)$/ }] }],
  // `tr` 的操作数是字符集、不是文件,但**个数不对它就打用法退出**（第 2 轮审查实测 `tr`、
  // `tr ab` 都是几毫秒打完用法、整条退出 0）。`-d` 要一个集合、默认要两个;`-s` 一个两个都
  // 合法 ⇒ 数不出来 ⇒ 不算证明。
  ["tr", {
    proves: (p) => {
      if (has(p, /^(?:-[a-zA-Z]*s$|--squeeze-repeats$)/)) return false;
      if (p.operands.length !== (has(p, /^(?:-[a-zA-Z]*d$|--delete$)/) ? 1 : 2)) return false;
      // `[:bogus:]`、没闭合的 `[` 这种集合同样是「读之前就报错」。
      return p.operands.every((o) => o.length > 0 && !o.includes("["));
    },
    opts: [{ re: /^-[dscCt]+$/ }, { re: /^--(?:delete|squeeze-repeats|complement|truncate-set1)$/ }],
  }],
  // `cut` **非得给 `-b`/`-c`/`-f` 之一**,不给就打用法退出（第 2 轮审查实测 `cut` 退出 0）。
  ["cut", {
    proves: (p) => NO_OPERANDS(p) && has(p, /^(?:-[bcf]|--(?:bytes|characters|fields)=)/),
    opts: [
      { re: /^-[sn]+$/ },
      { re: /^-[bcf]$/, value: FIELD_LIST }, { re: /^-[bcf]\d[-,\d]*$/ },
      { re: /^-d$/, value: ONE_CHAR }, { re: /^-d.$/ },
      { re: /^--(?:bytes|characters|fields)=\d[-,\d]*$/ },
      { re: /^--delimiter=.$/ },
      { re: /^--(?:only-delimited|complement)$/ },
    ],
  }],
  // `nl` 的带值开关**一个都不在列**:`-w` 要数字（第 2 轮审查实测 `nl -w nope` 打一句错就退）、
  // `-b`/`-n` 各有自己的取值表,这一层判不了。
  ["nl", { proves: NO_OPERANDS, opts: [] }],
  ["rev", { proves: NO_OPERANDS, opts: [] }],
]);

/**
 * 下游这条命令**证明得出它会一直读到 EOF 才退**吗（见文件头 ⑤⑥）。
 *
 * 三道同跟随型:这条 argv 全认得出来、它只能从管子读、而且没有「够了就走」或者「读之前就报
 * 错」的东西。任一道答不出来就是 `false` —— 「读不懂」在这边的确定答案是**上游那个判定降级
 * 成提示**。
 */
export function readsToEof(name: string, argv: Token[]): boolean {
  const c = CONSUMERS.get(name);
  if (!c) return false;
  const parsed = parseIfUnderstood(c, argv);
  return parsed !== null && c.proves(parsed);
}
