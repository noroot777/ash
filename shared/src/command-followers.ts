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
// 所以这边的判据是两道，缺一不可：
//
//  ① **这条 argv 全是我认得的东西**（`understood`）。认得的开关逐个列在下面每个工具的
//     `opts` 里,带值的那些连**值长什么样**一起列（`-n` 要数字）。出现认不出来的开关、或者
//     值不对形状 ⇒ 这条命令会不会收工**答不出来** ⇒ 不拦。少列一个开关 = 退回今天的行为;
//     多认一个 = 一件做得成的事做不成了（见 command-never-exits.ts 文件头那段不对称）。
//  ② 跟随开关确实出现了（`follows`）。
//
// 故意**不列**进 `opts` 的那几类开关，列进去就等于把一条会自己结束的命令说成不会：
//  · 自己带死线的（`inotifywait -t 60`、`docker logs --until=…`）—— 到点就退
//  · 打一行就退的（`--help`、`--version`）
//  · 值这一层证明不出来的（任何需要「那个东西存在」才成立的参数）
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
  /** 这些开关一出现就是「盯着不走」。 */
  follows: (argv: Token[]) => boolean;
  /** 它**认得的**全部开关（见文件头 ①）。 */
  opts: readonly Opt[];
  /** 判定它的那个写法，给拒绝文案用。 */
  what: string;
  /** 操作数（非开关的词）这一层还有话要说吗。默认没有。 */
  operandsOk?: (operands: string[]) => boolean;
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

/** argv 里第一个不是开关的词（`watch` 要有活干、`docker logs` 的子命令）。 */
const operandsOf = (argv: Token[]): string[] => argv.filter((t) => !t.text.startsWith("-")).map((t) => t.text);

/**
 * 跟随型：这些命令的语义就是「盯着不走」，放在管道里也一样 —— 它不退出，整条管道就不退出
 * （`tail -f x | grep -m1 y` 也救不了：日志安静下来 `tail` 收不到 SIGPIPE，管道照样挂着）。
 *
 * 判据全部落在**那一条简单命令自己的 argv** 上（见 command-never-exits.ts 文件头 ①）。
 */
const FOLLOWERS = new Map<string, Follower>([
  ["tail", {
    what: "tail -f/-F",
    follows: (a) => hasFlag(a, /^-[^-]*[fF]/, "--follow"),
    opts: [
      { re: /^-[fFqvr]+$/ },                                  // 可并写的无值开关
      { re: /^-[nc][+-]?\d+[bkKmMgG]?$/ },                    // `-n100`
      { re: /^-[nc]$/, value: COUNT },                        // `-n 100`
      { re: /^-s$/, value: SECONDS },
      { re: /^--follow(?:=(?:name|descriptor))?$/ },
      { re: /^--(?:lines|bytes)=[+-]?\d+[bkKmMgG]?$/ },
      { re: /^--(?:retry|quiet|silent|verbose|zero-terminated)$/ },
      { re: /^--pid=\d+$/ },
      { re: /^--sleep-interval=\d+(?:\.\d+)?$/ },
      { re: /^--max-unchanged-stats=\d+$/ },
    ],
  }],
  ["watch", {
    what: "watch",
    // 没有活干的 `watch` 自己打一句用法就退 —— 那不是跟随。
    follows: (a) => operandsOf(a).length > 0,
    opts: [
      { re: /^-[dtbepxw]+$/ },
      { re: /^-n$/, value: SECONDS },
      { re: /^-n\d+(?:\.\d+)?$/ },
      { re: /^--interval=\d+(?:\.\d+)?$/ },
      { re: /^--(?:differences|no-title|beep|errexit|exec|precise|no-wrap|color)$/ },
      { re: /^-c$/ },
      { re: /^-g$/ },
      { re: /^--chgexit$/ },
    ],
  }],
  ["inotifywait", {
    what: "inotifywait -m",
    follows: (a) => hasFlag(a, /^-[^-]*m/, "--monitor"),
    // `-t`/`--timeout` **故意不在列**:它到点就退（见文件头）。
    opts: [
      { re: /^-[mrqd]+$/ },
      { re: /^-e$/, value: WORD },
      { re: /^--event=/, },
      { re: /^--(?:monitor|recursive|quiet|daemon|no-dereference)$/ },
      { re: /^--format=/ },
      { re: /^--timefmt=/ },
      { re: /^--(?:exclude|excludei|include|includei)=/ },
      { re: /^--fromfile$/, value: WORD },
    ],
  }],
  ["journalctl", {
    what: "journalctl -f",
    follows: (a) => hasFlag(a, /^-[^-]*f/, "--follow"),
    // `--until=` 不在列:它读到那个时刻就收工。
    opts: [
      { re: /^-[fkeqra]+$/ },
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
    follows: (a) => operandsOf(a)[0] === "logs" && hasFlag(a, /^-[^-]*f/, "--follow"),
    opts: [
      { re: /^-[fp]+$/ },
      { re: /^-n$/, value: WORD },
      { re: /^--namespace=/ },
      { re: /^-c$/, value: WORD },
      { re: /^--container=/ },
      { re: /^-l$/, value: WORD },
      { re: /^--selector=/ },
      { re: /^--tail=-?\d+$/ },
      { re: /^--since=/ },
      { re: /^--(?:follow|timestamps|all-containers|prefix|previous|ignore-errors)$/ },
    ],
  }],
  ["docker", {
    what: "docker logs -f",
    follows: (a) => operandsOf(a)[0] === "logs" && hasFlag(a, /^-[^-]*f/, "--follow"),
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
    follows: (a) => operandsOf(a)[0] === "logs" && hasFlag(a, /^-[^-]*f/, "--follow"),
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
    follows: (a) => !hasFlag(a, /^-[^-]*1/, "--one-event"),
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
 * 这条 argv **全是认得出来的东西**吗（见文件头 ①）。
 *
 * 操作数不管（文件名、容器名是什么这一层不问）;`--` 之后一律是操作数。带值的开关会把**下一
 * 个词**按它的值形状对一遍 —— 值不对形状的那种恰恰是「它在校验参数那一步就退了」。
 */
function understood(f: Follower, argv: Token[]): boolean {
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i]!;
    if (t.quoted || !t.text.startsWith("-")) continue;
    if (t.text === "--") break;
    const opt = f.opts.find((o) => o.re.test(t.text));
    if (!opt) return false;
    if (!opt.value) continue;
    const v = argv[i + 1];
    if (!v || !opt.value.test(v.text)) return false;
    i += 1;
  }
  return f.operandsOk ? f.operandsOk(operandsOf(argv)) : true;
}

/**
 * 这条简单命令**证明得出它会盯着不走**吗 —— 是就返回判定它的那个写法，否则 `null`。
 *
 * 两道都要过：argv 读得懂（`understood`），而且跟随开关确实出现（`follows`）。
 */
export function followerOf(name: string, argv: Token[]): string | null {
  const f = FOLLOWERS.get(name);
  if (!f) return null;
  return understood(f, argv) && f.follows(argv) ? f.what : null;
}
