// 「这个脚本名，runner 自己认不认」—— 这一层不解析 npm 的配置，让 npm 回答；而且**问的必须
// 是真要跑的那个 npm**。
//
// 为什么不自己解析配置（第 6 轮审查 F1 实测 `.npmrc` 里 `workspace[]=child`）：npm 去哪儿找
// manifest 由四层配置共同决定（命令行 / 环境 / 仓库 npmrc / 用户 npmrc），键还有数组写法和
// 别名。逐条枚举「哪些键会改掉查找目录」补一个漏一个 —— 拦住了 `workspace=child`，数组写法
// 照样放过去，于是一次真跑起来、真报断言失败的红被说成「一行都没跑到、不要改代码」。
//
// 为什么非得是**同一次执行**里的那个 npm（第 7 轮审查 F1 实测）：上一版自己 execFile 起了个
// npm，于是「问的那个」和「跑的那个」根本不是一回事 ——
//  · 可执行文件由 ash 这边的 PATH 解析。审查那条反例把项目自带的 npm 启动器放在命令的前置
//    `PATH=` 里：真跑的是它（打了 ACCEPTANCE STARTED、ASSERTION FAILED 后退 1），探针问的却
//    是系统 npm，看到根目录那份空 scripts，于是报「入口不存在」并发出免修令；
//  · 继承环境被剥掉了 `NODE_OPTIONS`/`LD_*`/`DYLD_*`（那是给 bootstrap 进程剥的，正式命令由
//    `restoreEnv` 恢复，见 accept-gate-process.ts），探针这条路没有那一步；
//  · 正式命令过**登录 shell**（`sh -lc`），rc 里换掉 node/npm 版本是常事，而 execFile 不过。
// 两问彼此对得上，证明不了它们等于真要跑的那一个。
//
// 所以这一层现在不起进程，只**生成一段 shell**，由门禁把它插在用户命令前面，跟用户命令在
// 同一次受监督执行里跑（accept-gate.ts → spawnAcceptGate 的 prelude）。于是：
//  · 那个 `npm` 由**同一个 shell**在**同一份 PATH**（经同一份 rc、同一组前置赋值）里解析，
//    环境也是同一个进程的环境 —— 等价性不再靠推断；
//  · 它在门禁的进程树里：有 pid 登记、有 confinement 凭据、取消和超时一刀下去连它一起收，
//    输出落在固定文件里可查（第 7 轮审查 F2）。上一版那两个进程谁也管不着，取消时门禁按
//    「还没放行」确认结束，它们却还在跑。
//
// 两问（都只读，实测 `npm run --json` 不执行脚本：脚本体里写 `> ran.txt` 的那条没产生文件）：
//  ① `npm [--prefix X] run --json` —— 它自己列的脚本表。本机 npm 11.17.0 实测：没有 workspace
//     scope 时是平铺的 `{"脚本名": "命令"}`；一旦有 scope 生效（仓库 `.npmrc` 写
//     `workspace[]=child`、环境给 `npm_config_workspace=child` 都算）就变成按包分组的嵌套
//     `{"child": {…}}`。**输出形状本身就是证据**：平铺 = 只有一个包要跑，名字在不在一看即知；
//     嵌套 = 哪份 manifest 说不准，交白卷。没有 `scripts` 字段时给的是 `{}`。
//  ② `npm [--prefix X] prefix` —— 它真会去读 manifest 的那个目录，拿来跟这一层解析出的那个
//     **交叉核对**（比 realpath：macOS 上 npm 回 `/private/var/…`，而树在 `/var/…`）。对上了才
//     说明 `--prefix` 这类选项读对了 —— 归因层查 git 历史用的就是那个目录。有 workspace scope
//     时这条命令直接报错、stdout 为空（实测），所以两问互为后备。
//
// 重放时**只带换目录的那个选项**，`--silent`/`--loglevel` 一概不带：实测 `npm run --silent
// --json` 把 JSON 一起吞掉（stdout 空），带上就等于逢 `--silent` 必交白卷。那几个开关本来就是
// 「确定只影响输出」才进白名单的（见 accept-gate-entry.ts），不带不改这两问的答案。
import { readFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { IS_WINDOWS } from "./platform.js";

/** 这一层重放那两问需要的东西，由 `gateEntryAsk` 解析命令时一并给出。 */
export type NpmAskShape = { dir: string; flags: string[]; env: Record<string, string> };

/** 两问的答案落在哪儿。跟日志同目录，归档清理一并带走。 */
export type GateEntryAnswers = { table: string; prefix: string; stderr: string };

export const gateEntryAnswers = (logPath: string): GateEntryAnswers => ({
  table: `${logPath}.entry-scripts.json`,
  prefix: `${logPath}.entry-prefix`,
  stderr: `${logPath}.entry-ask.err`,
});

/** POSIX shell 的单引号包裹。词里的 `'` 要先退出引号再转义。 */
const quote = (word: string): string => `'${word.replace(/'/g, "'\\''")}'`;

/**
 * 插在用户命令前面的那段 shell。`null` = 这一层不问（于是整个判定交白卷）。
 *
 * Windows 上返回 null：那边的 shell 是 cmd/powershell（见 platform.ts 的 userShellLaunch），
 * 重定向和分组写法另一套，而这台机器上验不了 —— 规矩是没在那边真跑过就不写那条分支。
 *
 * `{ …; } || true` 把两问的成败跟用户命令隔开：整条命令的退出码仍然是用户命令自己的那个
 * （`sh -c` 取最后一条的状态），门禁据以判红绿的东西一个字没动。
 */
export function npmAskPrelude(ask: NpmAskShape, answers: GateEntryAnswers): string | null {
  if (IS_WINDOWS) return null;
  const assignments = Object.entries(ask.env).map(([key, value]) => `${key}=${quote(value)} `).join("");
  const flags = ask.flags.length ? ` ${ask.flags.map(quote).join(" ")}` : "";
  const npm = `${assignments}npm${flags}`;
  return `{ ${npm} run --json >${quote(answers.table)} 2>${quote(answers.stderr)}; `
    + `${npm} prefix >${quote(answers.prefix)} 2>>${quote(answers.stderr)}; } || true`;
}

/**
 * npm 列出来的那张表。**只认平铺**（见文件头）：嵌套说明有 workspace scope 生效，那时
 * 「哪份 manifest 才是 runner 要读的」这一层说不准。
 */
function flatTable(stdout: string): Set<string> | null {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout.trim()); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (!entries.every(([, command]) => typeof command === "string")) return null;
  return new Set(entries.map(([name]) => name));
}

/** 两个路径指的是不是同一个目录。比 realpath：软链一侧对不上不代表真不一样。 */
async function samePlace(one: string, other: string): Promise<boolean> {
  const [a, b] = await Promise.all([realpath(one).catch(() => null), realpath(other).catch(() => null)]);
  return !!a && a === b;
}

/**
 * 读那两问的答案。读不到、形状不对、目录对不上，一律 null（交白卷）。
 *
 * 答案是**命令开跑时第一件事**写下的，所以它仍然是「起跑那一刻」的事实 —— 这跟「跑完之后
 * 再去看一眼」是两回事（第 2 轮审查 F1 那条自删自己的脚本：探针跑在它前面，看到的是删除前
 * 那棵树）。读的时机在结算里，但读的内容不是结算时的状态。
 */
export async function readNpmScriptTable(treeDir: string, ask: NpmAskShape,
  answers: GateEntryAnswers): Promise<Set<string> | null> {
  const said = (await readFile(answers.prefix, "utf8").catch(() => null))?.trim();
  const where = said ? said.split("\n").at(-1)!.trim() : "";
  if (!where || !await samePlace(where, join(treeDir, ask.dir))) return null;
  const listed = await readFile(answers.table, "utf8").catch(() => null);
  return listed === null ? null : flatTable(listed);
}
