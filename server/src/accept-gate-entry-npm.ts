// 「这个脚本名，runner 自己认不认」—— 这一层**不解析 npm 的配置**，直接问 npm。
//
// 为什么从「自己解析」换成「问它」（第 6 轮审查 F1 实测 `.npmrc` 里 `workspace[]=child`）：
// npm 去哪儿找 manifest 由四层配置共同决定（命令行 / 环境 / 仓库 npmrc / 用户 npmrc），键
// 还有数组写法和别名。前几轮是逐条枚举「哪些键会改掉查找目录」，补掉一个写法又漏下一个 ——
// `workspace=child` 拦住了，`workspace[]=child` 照样放过去,于是一次真跑起来、真报断言失败
// 的红被说成「一行都没跑到、不要改代码」。枚举走不通：那是 npm 的语义，不是这一层的。
//
// 所以改成让 npm 把它按**全部有效配置**算出来的答案交出来，两问都得对上：
//  ① `npm [--prefix X] run --json` —— 它自己列的脚本表。本机 npm 11.17.0 实测：没有
//     workspace scope 时是平铺的 `{"脚本名": "命令"}`；一旦有 scope 生效（仓库 `.npmrc` 写
//     `workspace[]=child`、环境给 `npm_config_workspace=child` 都算）就变成按包分组的嵌套
//     `{"child": {…}}`。**输出形状本身就是证据**：平铺 = 只有一个包要跑，名字在不在一看
//     即知；嵌套 = 哪份 manifest 说不准，交白卷。它只列不跑（实测：脚本体里写 `> ran.txt`
//     的那条没有产生文件）。没有 `scripts` 字段时给的是 `{}`。
//  ② `npm [--prefix X] prefix` —— 它真会去读 manifest 的那个目录，拿来跟命令行解析出的那个
//     **交叉核对**。核对比的是 realpath（macOS 上 npm 回 `/private/var/…`，而树在 `/var/…`）。
//     对上了才说明 `--prefix` 这类选项这一层读对了 —— 归因层查 git 历史用的就是那个目录。
//     有 workspace scope 时这条命令直接报错、stdout 为空（实测），所以两问互为后备。
//
// 重放时**只带换目录的那个选项**，`--silent`/`--loglevel` 一概不带：实测 `npm run --silent
// --json` 把 JSON 一起吞掉（stdout 空），带上就等于逢 `--silent` 必交白卷。那几个开关本来就是
// 「确定只影响输出」才进白名单的（见 accept-gate-entry.ts），不带不改这两问的答案。
//
// 环境用门禁子进程那一套（真跑继承的就是它）加上命令里的前置赋值 —— 问的条件必须跟真跑
// 一致，否则又变成换个地方猜。
//
// 找 npm 走项目自己那套 `resolveLaunch`（Windows 上 `.cmd` 垫片的拆封在它里面），不在这儿
// 另开一条没在那边验过的平台分支。
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gateBootstrapEnvironment } from "./accept-gate-process-env.js";
import { augmentedEnv, resolveLaunch } from "./executors/bin-resolve.js";

const execFileAsync = promisify(execFile);

/** 两问都只是列表操作，正常一秒内回来；冷启动/慢盘给足，超时按白卷。 */
const ASK_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** 这一层重放那两问需要的东西，由 `gateEntryAsk` 解析命令时一并给出。 */
export type NpmAskShape = { dir: string; flags: string[]; env: Record<string, string> };

/** 问 npm 一句。问不出来（没装、非零退出、超时、输出超限）一律 null。 */
async function askNpm(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const plan = resolveLaunch("npm", args);
  if (!plan) return null;
  try {
    const { stdout } = await execFileAsync(plan.file, plan.args, { cwd, env,
      timeout: ASK_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES,
      ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) });
    return stdout;
  } catch { return null; }
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
 * 起跑前问 npm 要那张脚本表。问不出来、或者它说的目录跟这一层解析出来的对不上，返回 null。
 *
 * 调用点只有探针（spawn 之前那一次）。这两问是只读的 —— 但它们确实会起 npm 进程，所以别
 * 挪到结算侧或者循环里。
 */
export async function npmScriptTable(treeDir: string, ask: NpmAskShape): Promise<Set<string> | null> {
  const env = { ...gateBootstrapEnvironment(augmentedEnv()).bootstrap, ...ask.env };
  const where = (await askNpm([...ask.flags, "prefix"], treeDir, env))?.trim();
  if (!where || !await samePlace(where, join(treeDir, ask.dir))) return null;
  const listed = await askNpm([...ask.flags, "run", "--json"], treeDir, env);
  return listed === null ? null : flatTable(listed);
}
