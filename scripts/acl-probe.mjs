// 回归里那条「**扩展 ACL 必须随写入原样留下**」靠什么测 —— 两份写入器各有一组在钉它
// (TS 的个人档 `test-user-cli-write-identity.ts`、裸 Node 的 setup `test-codex-mcp-setup.mjs`),
// 所以探测本身只留这一份,两边都从这里取。
//
// **为什么不是「打印出来 grep 一个字串」**:`ls -le` / `getfacl` 打的是给人看的东西,主体
// 那一格要过一次解名(macOS 交给 opendirectoryd,Linux 查 passwd)。解名失败**不报错**,直接
// 换一种写法打出来 —— macOS 打的是 Apple 兼容 UUID(`FFFFEEEE-DDDD-CCCC-BBBB-AAAA` + uid 的
// 八位十六进制)。于是拿那行字做子串匹配有两种坏法,2026-10-31 几条回归并发跑时撞上了:
//
//   · **设完 ACL 那一下**解名失败 ⇒ 探测以为「这台机器设不上扩展 ACL」,整组**静悄悄跳过**。
//     测试不再测了却还报绿,比判红坏得多。
//   · **写完文件那一下**解名失败 ⇒ ACL 整条还在,却因为那行字换了写法判红(实际撞上的是这种)。
//
// 所以这里不比那行字,而是把它解析成**跟解名无关的 ACE 结构**:条目序号、allow/deny、权限
// 列表照留,主体那一格一律换成 `*`。判据没有放松 —— rename / 复制会把 ACL **整条**丢掉,
// 那时 ACE 列表直接空掉,照样判红;主体也不可能被写入器改成别人,它压根不碰 ACL 内容。
import { spawnSync } from "node:child_process";

const DARWIN = process.platform === "darwin";

/**
 * 把一次 ACL 打印解析成跟解名无关的 ACE 列表(顺序照留,主体换成 `*`)。
 *
 * macOS:`ls -le` 在 mode 那行之后每条 ACE 一行,形如 ` 0: user:nobody deny read`,
 * 解不出名字时中间那一格变成裸 UUID。Linux:`getfacl -c -n` 每行 `类型:限定符:权限`。
 */
export function parseAces(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (DARWIN) {
      const m = /^\s*(\d+):\s+(.+?)\s+(allow|deny)\b(.*)$/.exec(line);
      if (m) out.push(`${m[1]}: * ${m[3]}${m[4]}`);
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const field = trimmed.split(":");
    if (field.length !== 3) continue;
    field[1] = "*";
    out.push(field.join(":"));
  }
  return out;
}

/**
 * 给 `f` 设一条「某个具名账号禁止读取」的扩展 ACL。
 *
 * 返回 null = **这台机器真的设不上**(文件系统不支持、没这个命令、没这个账号),由调用方跳过
 * 并说明 —— 这种本机能力不该让回归整条红。判「设上了」看的是 ACE 条数变多,不是打印里有没有
 * 那个名字,所以解名抽风不会被误读成「设不上」。
 *
 * - `aces`:刚设完那一刻的 ACE 列表,拿它当基线。
 * - `list()`:现在的 ACE 列表,跟基线 deepEqual 比。
 * - `show()`:原始打印,只用来写进断言的报错信息给人看。
 *
 * **这个探测本身灵不灵敏**由 `test-user-cli-write-identity.ts` 第 ⑥ 组钉着(rename 换掉文件
 * 必须比出 ACL 丢了):`list()` 解析不出任何 ACE 时两边都是空列表,deepEqual 会无声通过。
 */
export function denyReadAcl(f) {
  const plan = DARWIN
    ? { set: ["chmod", ["+a", "user:nobody deny read", f]], show: ["ls", ["-le", f]] }
    : { set: ["setfacl", ["-m", "u:nobody:---", f]], show: ["getfacl", ["-c", "-n", f]] };
  const show = () => spawnSync(plan.show[0], plan.show[1], { encoding: "utf8" }).stdout ?? "";
  const list = () => parseAces(show());
  const before = list().length;
  const put = spawnSync(plan.set[0], plan.set[1], { encoding: "utf8" });
  // 设不上 = 这台机器真的没这个能力(没这个命令、文件系统不支持、没 nobody 这个账号)。
  // 只有这一种允许跳过,而且是确定性的 —— 跟上一版那种「解名抽了一下」的随机跳过不是一回事。
  if (put.status !== 0) return null;
  const aces = list();
  if (aces.length === before) {
    // 设上了却一条都读不出来:要么这个文件系统只是假装接受,要么那条打印的格式变了。两种都
    // 必须有人来看 —— **不许**退化成「静悄悄不测了」,那正是本轮要根治的坏法。
    throw new Error(
      `${plan.set[0]} 报成功,却读不出新增的 ACE —— 这个文件系统只是假装接受,`
      + `或者 ${plan.show[0]} 的打印格式变了,解析得跟着改:\n${show()}`,
    );
  }
  return { show, list, aces, how: plan.set[0] };
}
