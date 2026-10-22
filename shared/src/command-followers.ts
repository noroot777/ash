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
// 而文件在不在**不写在命令文本里**。所以这边既不猜、也不悄悄把这一类整个放过去,而是把前提
// 本身交出去（`FollowerHit.assumesAnyExists`）:读得出这件事的那一层去问 —— 创建闸知道这条
// 哨兵将在哪个工作目录里跑,所以由它读（server/src/monitor-create.ts 的 `assumptionsHold`）;
// 表单那边读不出来,所以它照实说「只要 X 还在,它就不会结束」。少交一个前提 = 一条会立刻退出
// 的命令继续被 409。
import type { Token } from "./command-lex.ts";

/** 一个开关的形状 + 它的值要长什么样（`value` 不填 = 这个开关不吃值）。 */
type Opt = { re: RegExp; value?: RegExp };

/** 行数/字节数这类计数参数:`100`、`+100`、`-100`、`10k`。 */
const COUNT = /^[+-]?\d+[bkKmMgG]?$/;
/** 秒数:`5`、`0.5`。 */
const SECONDS = /^\d+(?:\.\d+)?$/;
/** 一个非空的词（名字、标签、容器名这类「随便什么字都合法」的值）。 */
const WORD = /^[^\0]+$/;

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
   * 它盯的那个东西**得现在就在**吗 —— 是就返回那几个路径（见文件头 ④）。
   *
   * 不填 = 这个工具的跟随不依赖本地路径:`journalctl -f` 盯的是日志本身、`watch` 盯的是一条
   * 命令（那条命令失败它也照旧每隔几秒再来一次）、`… logs -f` 盯的是远端资源名（本机读不出
   * 来那个 pod/容器在不在）。
   */
  needsExisting?: (argv: Token[], operands: string[]) => readonly string[];
};

/** 这条简单命令**证明得出会盯着不走**时的判定内容（`followerOf` 的返回）。 */
export type FollowerHit = {
  /** 判定它的那个写法，给拒绝文案用。 */
  what: string;
  /**
   * 「**只要这几个路径里有一个还在**，它就不会自己退出」—— 空数组 = 这个判定不依赖任何本地
   * 路径（见文件头 ④）。
   *
   * 要**全部**不在才算前提落空:`tail -f 在的 不在的` 照旧跟住那个在的（GNU tail 只对不在的
   * 那个报一句错就接着跟）。
   */
  assumesAnyExists: readonly string[];
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
 * 跟随型：这些命令的语义就是「盯着不走」，放在管道里也一样 —— 它不退出，整条管道就不退出
 * （`tail -f x | grep -m1 y` 也救不了：日志安静下来 `tail` 收不到 SIGPIPE，管道照样挂着）。
 *
 * 判据全部落在**那一条简单命令自己的 argv** 上（见 command-never-exits.ts 文件头 ①）。
 */
const FOLLOWERS = new Map<string, Follower>([
  ["tail", {
    what: "tail -f/-F",
    // **要盯的文件得写在 argv 里**（见文件头 ③）:不带操作数时它盯的是标准输入,那头是什么
    // 这一层答不出来 —— `printf 'DONE\n' | tail -f` 几毫秒就打完 DONE 退出 0（实测）。
    follows: (a, operands) => operands.length > 0 && hasFlag(a, /^-[^-]*[fF]/, "--follow"),
    // **`-f` 的不退出有个前提:那个文件现在就在**（见文件头 ④）—— `-F`/`--retry` 没了也一直
    // 重试,所以那一种不带前提。前提真不真这一层答不出来,交出去由读得出来的人问。
    needsExisting: (a, operands) => (tailRetries(a) ? [] : operands),
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
    // 那几个路径**得现在就在**:watch 不上的路径它当场报错退出（见文件头 ④）。
    needsExisting: (_a, operands) => operands,
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
    // 那几个路径**得现在就在**:不存在的路径 fswatch 报一句错就退（见文件头 ④）。
    needsExisting: (_a, operands) => operands,
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

/**
 * 这条 argv **全是认得出来的东西**吗（见文件头 ①）—— 是就连它真正的**操作数**一起交出来，
 * 不是就 `null`（「这条命令会不会收工答不出来」）。
 *
 * 操作数的内容这一层不问（文件名、容器名是什么都行）,但**哪几个词是操作数**得数对:带值的
 * 开关会把下一个词按它的值形状对一遍（值不对形状的那种恰恰是「它在校验参数那一步就退了」）,
 * 对上了就**连那个词一起吃掉** —— 不然 `kubectl logs -f -n ns` 里的命名空间会被数成「要盯的
 * 那个 pod」,而真 kubectl 少了 pod 名字只会打一句用法就退（见文件头 ③）。`--` 之后一律是
 * 操作数,引号里的词也是（`tail -F "my file"`）。
 */
function operandsIfUnderstood(f: Follower, argv: Token[]): string[] | null {
  const operands: string[] = [];
  let done = false;                                   // 读到 `--` 了 ⇒ 后面全是操作数
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i]!;
    if (!done && !t.quoted && t.text === "--") { done = true; continue; }
    if (done || t.quoted || !t.text.startsWith("-")) { operands.push(t.text); continue; }
    const opt = f.opts.find((o) => o.re.test(t.text));
    if (!opt) return null;
    if (!opt.value) continue;
    const v = argv[i + 1];
    if (!v || !opt.value.test(v.text)) return null;
    i += 1;
  }
  return operands;
}

/**
 * 这条简单命令**证明得出它会盯着不走**吗 —— 是就返回那个判定（含它的前提），否则 `null`。
 *
 * 三道都要过：这条 argv 全认得出来（`operandsIfUnderstood`），跟随开关确实出现，而且**要盯的
 * 那个东西写在 argv 里**（后两道都在 `follows` 里，见文件头 ①②③）。任一道答不出来就是
 * `null` —— 「读不懂」的确定答案是不拦（见 command-never-exits.ts 文件头那段不对称）。
 *
 * 过了三道也**不等于无条件成立**:`assumesAnyExists` 里是这个判定的前提（见文件头 ④），由
 * 读得出那件事的调用方去核。
 */
export function followerOf(name: string, argv: Token[]): FollowerHit | null {
  const f = FOLLOWERS.get(name);
  if (!f) return null;
  const operands = operandsIfUnderstood(f, argv);
  if (!operands) return null;
  if (!f.follows(argv, operands)) return null;
  return { what: f.what, assumesAnyExists: f.needsExisting?.(argv, operands) ?? [] };
}
