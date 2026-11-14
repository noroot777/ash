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
// 没配准备命令的那一档不动：它的依赖计划（ambient）就是按 RUNS_DIR 那条祖先链登记的。
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { RUNS_DIR } from "./paths.js";
import { optionalRead } from "./accept-gate-fs.js";

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
