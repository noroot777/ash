// **包一层的那几个词**:`env`、`nohup`、`nice`…… 以及「这一条简单命令真正要跑的是谁」。
//
// 从 command-never-exits.ts 拆出来（全局约定:单文件不超过 700 行）。拆的是第四种问题:判据层
// 答「这几段里有没有一条证明得出会跑」,词法层（command-lex.ts）答「这串字符分成哪些词」,跟随型
// 目录（command-followers.ts）答「这一个命令会不会自己收工」,这边答**「剥掉包装之后,要判的是
// 哪个命令、它的 argv 是哪几个词」** —— 一张白名单加一段剥壳,跟推理无关,加一个包装命令不该动
// 判据。
//
// 误判的代价跟那三层同源（见 command-never-exits.ts 文件头那段不对称）:这张表少一个开关 ⇒
// 这一段按「读不懂」放行,退回今天的行为;多认一个 ⇒ 一件做得成的事做不成了。
import type { Token } from "./command-lex.ts";

/**
 * 一个**已知透明**的开关:它不改变「后面那个词就是真正要跑的命令」这件事。
 *
 * `value` = 它还要再吃一个词当参数,**而且那个词得长这个样**（第 2 轮审查 F2）。只记「要吃
 * 一个词」是不够的:`nice -n not-a-number tail -F /dev/null` 里 nice 在校验那一步就
 * invalid nice value 退出,后面那个 tail 一次都没跑（实测退出 0 并打出 DONE）。值的形状是
 * **写在输入里的启动前提**,不是「二进制可能没装」那种无穷外部假设。
 */
type Transparent = { re: RegExp; value?: RegExp };

/** 环境变量名（`env -u` 的值）。 */
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** nice 的调整量。 */
const NICE_VALUE = /^[+-]?\d+$/;
/** stdbuf 的缓冲规格:`L`（行缓冲）、`0`（不缓冲）、字节数。 */
const BUF_SPEC = /^(?:L|0|\d+[kKmMgG]?)$/;

/**
 * 这些词只是**包一层**，真正跑的是后面那个命令 —— 跳过它和它身上**认得出来**的那几个开关。
 *
 * **用 Map 存,不用普通对象**（第 2 轮审查 F1）。`name` 是命令 basename,任何字符串都可能
 * 落进来:普通对象上 `WRAPPERS["constructor"]`、`WRAPPERS["toString"]` 取到的是
 * `Object.prototype` 上那几个成员,随后 `forms.find(...)` 直接 `TypeError`。审查实测
 * `./constructor -v` 让**整个页面变成空白**（判据在每次渲染里同步调用）、创建接口 500 ——
 * 而那条命令在 `/bin/sh` 下打完 DONE 就退出 0。Object.prototype 上那 12 个名字是同一类,
 * 所以修的是**存储和查询这一层**,不是逐个排除那几个名字。
 *
 * **只认白名单,认不出来的开关当场放弃这一段**（第 3 轮审查 F1）。上一版把所有 `-` 开头的词
 * 一律当成「包装命令自己的开关」跳过去,于是 `command -v tail -F /dev/null; printf 'DONE\n'`
 * 被硬拦:`command -v` 是**查一个命令在哪儿**,它打一行路径就退,那个 `tail` 一次都没跑
 * （实测 `/bin/sh` 退出 0 并打出 `/usr/bin/tail` 和 DONE,而创建闸 409）。
 *
 * 同一类的开关不止这一个（`sudo -l`、`ionice -p PID`、各家的 `--help`/`--version`）,所以
 * 补的不是「再排除一个 `-v`」,而是把方向倒过来:**认得出来的才跳,认不出来的就说读不懂**。
 * 漏一个 ⇒ 这一段按未知放行（退回今天的行为）;多认一个 ⇒ 一条会自己结束的命令被 409
 * （见文件头那段不对称）。所以这张表只收**确定仍然会去执行后面那个命令**的开关。
 *
 * 故意**整个不收**的两类（第 2 轮审查 F2）:
 *  · `sudo` —— 它跑不跑后面那个命令取决于 sudoers 策略和密码,`-n` 这种「不许问密码」在没有
 *    免密规则时直接 1 退出（本机实测如此）。那是**认证**这个启动前提,这一层答不出来。
 *  · `env -C DIR` / `--chdir=DIR` —— 切不进那个目录 env 就直接退（实测 `cannot change
 *    directory`,随后打出 DONE 并退出 0）。目录在不在这一层答不出来。
 */
const WRAPPERS = new Map<string, readonly Transparent[]>([
  ["env", [{ re: /^-$/ }, { re: /^-i$/ }, { re: /^-u$/, value: VAR_NAME },
    { re: /^--unset=[A-Za-z_][A-Za-z0-9_]*$/ }]],
  ["nohup", []],
  ["nice", [{ re: /^-n$/, value: NICE_VALUE }, { re: /^-\d+$/ }, { re: /^--adjustment=[+-]?\d+$/ }]],
  ["ionice", [{ re: /^-c[0-3]$/ }, { re: /^-c$/, value: /^[0-3]$/ },
    { re: /^-n[0-7]$/ }, { re: /^-n$/, value: /^[0-7]$/ },
    { re: /^-t$/ }, { re: /^--ignore$/ }, { re: /^--class(?:data)?=\d$/ }]],
  ["stdbuf", [{ re: /^-[ioe](?:L|0|\d+[kKmMgG]?)$/ }, { re: /^-[ioe]$/, value: BUF_SPEC },
    { re: /^--(?:input|output|error)=(?:L|0|\d+[kKmMgG]?)$/ }]],
  ["unbuffer", [{ re: /^-p$/ }]],
  ["command", [{ re: /^-p$/ }]],
  ["exec", [{ re: /^-c$/ }, { re: /^-l$/ }, { re: /^-a$/, value: /^[^\0]+$/ }]],
  ["time", [{ re: /^-p$/ }]],
]);

/** 这些词带着死线:整条简单命令一定会结束，里面是什么都不看。 */
const TIMED = new Set(["timeout", "gtimeout"]);

/**
 * 一条简单命令的**命令词 + 它自己的 argv**。`bounded` = 它自带死线，无须再看。
 *
 * `from` = 从这一段的第几个词开始读。**结构骨架是靠挪这个下标剥掉的,不是靠切数组**
 * （第 5 轮审查 N1,同 `headOf`）—— `! ! ! … cmd` 这种一段里堆几万个骨架词的命令,切一次
 * 复制一遍剩下的全部,整条就成了平方级（实测 80000 个 `!` 要 1.6 秒;改下标后 12 毫秒）。
 */
export function commandOf(tokens: Token[], from = 0): { name: string; argv: Token[]; bounded: boolean } | null {
  let i = from;
  while (i < tokens.length) {
    const t = tokens[i]!;
    // `VAR=value cmd …` 的赋值前缀；引号里的东西永远不是命令词。
    if (!t.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t.text)) { i += 1; continue; }
    if (t.quoted) return null;
    const name = t.text.split("/").pop() ?? t.text;
    if (TIMED.has(name)) return { name, argv: tokens.slice(i + 1), bounded: true };
    const forms = WRAPPERS.get(name);
    if (forms) {
      i += 1;
      // 开关一个个对着白名单认。不是 `-` 开头的那个词就是被包的命令词（交给下一圈判）。
      while (i < tokens.length) {
        const o = tokens[i]!;
        if (o.quoted || !o.text.startsWith("-")) break;
        if (o.text === "--") { i += 1; break; }   // 之后再没有开关
        const form = forms.find((f) => f.re.test(o.text));
        if (!form) return null;                   // 认不出来 ⇒ 这一段读不懂 ⇒ 放行
        if (!form.value) { i += 1; continue; }
        // 吃值的开关:**值也得长对**（见 `Transparent.value`）—— 值不对形状的那种,包装命令
        // 自己就在校验那一步退了,后面那个命令一次都不会跑。
        const v = tokens[i + 1];
        if (!v || !form.value.test(v.text)) return null;
        i += 2;
      }
      continue;
    }
    return { name, argv: tokens.slice(i + 1), bounded: false };
  }
  return null;
}
