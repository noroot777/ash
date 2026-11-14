// 准备命令那一档的快照**放在哪**。
//
// 配了准备命令，快照里的依赖由它现装（accept-gate-source 的 GateSource.prepared），这一层不借也
// 不证明。但「不借」不等于「不引用」：node 对快照里没装的包名会一级级往上找 `node_modules`，npm
// 跑脚本时也把每一级祖先的 `node_modules/.bin` 放进 PATH。默认的运行目录 `data/runs` 就住在 ash
// 自己的检出里，于是准备命令漏装的包会从 ash（或项目主检出）那棵依赖树里被找到 —— 门禁绿了，
// 换一台干净机器却跑不起来（第 1 轮审查实测：`require.resolve('typescript')` 落到了 ash 检出上）。
//
// 所以这一档的快照挪到 ash 与项目目录树**之外**的独立根下（系统临时目录，按本实例的运行目录分开，
// 免得两个实例互相回收），并在起跑前把不变量钉死：快照的任何一级祖先都不许有 `node_modules`。
// 有就拒跑并说清在哪，不靠「这台机器上大概没有」。日志、sidecar 之外的运行产物仍在 RUNS_DIR。
//
// 目录只是一条路。第 2 轮审查实测另一条：ash 是 npm 起的，npm 把 ash 那条依赖链上的
// `node_modules/.bin` 塞在 PATH 最前面，门禁原样继承 —— 准备命令一个包都没装，`npm run check`
// 里的 `tsc` 照样跑的是 ash 的那份。所以执行环境是同一条不变量的另一半（isolatedGateEnv）：
// 自动继承来的环境里，**任何指向快照之外某个 node_modules 的东西都不留**。登录 shell 读的
// profile 是用户自己对这台机器的设置，不在「自动继承」之列，不擦。
//
// 没配准备命令的那一档不动：它的依赖计划（ambient）就是按 RUNS_DIR 那条祖先链登记的。
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { RUNS_DIR } from "./paths.js";
import { optionalRead } from "./accept-gate-fs.js";
import { isInsidePath, PATH_DELIMITER, splitPathList } from "./platform.js";

/**
 * 环境隔离口径的代号，记进准备命令那一档的 ambient（accept-gate-source.ts 的 gateAmbient）。
 * 口径一改就往前挪：按旧口径跑出来的绿，不能拿来证明新口径下也绿。
 */
export const GATE_ENV_ISOLATION = "env-isolated-1";

const DEPENDENCY_SEGMENT = /(?:^|[\\/])node_modules(?:[\\/]|$)/i;
/** ash 自己被 npm 起来时带的「当前包是 ash」那一套上下文；在快照里跑的 npm 会按快照重新给。 */
const ASH_PACKAGE_CONTEXT = /^(?:INIT_CWD|npm_command|npm_config_local_prefix|npm_package_.+|npm_lifecycle_.+)$/i;

/**
 * 准备命令那一档交给启动器的环境：先按快照位置去掉一切外来依赖，再交给 gateBootstrapEnvironment 分拆。
 *  · PATH 里带 `node_modules` 一段、又不在快照里的目录一律去掉（`.bin` 之外还有 npm 自带的那几条，
 *    在快照里跑 npm 时它会自己再加回来）；
 *  · NODE_PATH 整个去掉：它就是「快照之外的模块搜索路径」本身；
 *  · ash 那一份 npm 包上下文去掉；
 *  · 其余变量（NODE_OPTIONS 里的 `--require`/`--import` 之类）只要值里点到快照之外的 `node_modules`，
 *    整个变量去掉 —— 不逐个枚举工具，按「它指不指向外来依赖」一刀切。
 */
export function isolatedGateEnv(env: NodeJS.ProcessEnv, cwd: string): NodeJS.ProcessEnv {
  const own = (path: string) => isInsidePath(resolve(cwd), resolve(path), sep);
  const foreign = (value: string) => value.split(PATH_DELIMITER).flatMap(part => part.split(/[\s"'=,]+/))
    .some(token => DEPENDENCY_SEGMENT.test(token) && !own(token));
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || ASH_PACKAGE_CONTEXT.test(key) || /^NODE_PATH$/i.test(key)) continue;
    if (/^PATH$/i.test(key)) {
      out[key] = splitPathList(value).filter(entry => !DEPENDENCY_SEGMENT.test(entry) || own(entry)).join(PATH_DELIMITER);
    } else if (!foreign(value)) out[key] = value;
  }
  return out;
}

export const GATE_ISOLATED_DIR = process.env.ASH_GATE_ISOLATED_DIR
  ? resolve(process.env.ASH_GATE_ISOLATED_DIR)
  : join(tmpdir(), `ash-accept-gate-${createHash("sha256").update(resolve(RUNS_DIR)).digest("hex").slice(0, 12)}`);

/**
 * 快照向上能找到的第一个 `node_modules`（不含快照自己那一层）；找不到 = null。读不动就抛（optionalRead
 * 的口径），不当成「没有」放行。给定路径与物理路径两条链都查：node 按 realpath 往上找，npm 拼 PATH
 * 用的是给定的那条（macOS 的 /var -> /private/var 就让两条不一样）。target 须已存在。
 */
export async function ancestorDependencyDir(target: string): Promise<string | null> {
  for (const start of new Set([resolve(target), await realpath(target)])) {
    for (let dir = dirname(start); ; dir = dirname(dir)) {
      const candidate = join(dir, "node_modules");
      if (await optionalRead(candidate, () => lstat(candidate)) !== null) return candidate;
      if (dirname(dir) === dir) break;
    }
  }
  return null;
}
