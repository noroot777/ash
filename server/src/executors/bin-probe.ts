import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExecTarget } from "@harness/shared";
import { resolveBin } from "./spawn.js";
import type { CliSpec } from "./catalog/types.js";

const exec = promisify(execFile);

export interface BinProbe {
  /** bins 里命中的那个命令名。 */
  bin: string;
  /** 绝对路径(与 spawn 时用的是同一套查找,见 resolveBin)。 */
  path: string;
  version: string | null;
}

// ── 候选命令名的探测:检测与执行的**同一个**判定 ────────────────────────────
// 一个 CLI 可以有多个候选命令名(官方改过 bin 名又留了兼容别名:cursor 的
// cursor-agent → agent、antigravity 的 antigravity → agy)。检测和执行必须用同一套
// 判定,否则就是「目录显示可用、派任务却 ENOENT」——第 1 轮审查抓到的正是这个:
// 检测遍历 bins 命中备用名,执行器却死认 bins[0]。
//
// 自证规则原样保留:只有 bins[0] 之外的备用名要求 `--version` 输出含
// fallbackVersionMatch。备用名常常很通用 —— 本机实测 `which agent` 命中的其实是
// grok,不设这道卡就会把别家的命令连版本号一起认成 cursor,那比 ENOENT 更坏
// (它会真的跑起来,只是跑的是另一家 CLI)。
export async function probeBins(bins: string[], fallbackVersionMatch?: string): Promise<BinProbe | null> {
  const want = fallbackVersionMatch?.toLowerCase();
  for (const [i, candidate] of bins.entries()) {
    const found = resolveBin(candidate);
    if (!found) continue;
    const ver = await versionOf(candidate);
    if (i > 0 && want && !(ver ?? "").toLowerCase().includes(want)) continue;
    return { bin: candidate, path: found, version: ver };
  }
  return null;
}

async function versionOf(bin: string): Promise<string | null> {
  try {
    const { stdout } = await exec(bin, ["--version"], { timeout: 4000 });
    return (stdout.split("\n")[0] || "").trim() || null;
  } catch {
    return null;
  }
}

/**
 * 起 CLI 时该用哪个命令名。返回 undefined = 用 spec.bins[0](执行器的默认)。
 *
 * 只在「主 bin 不在本机、而 spec 还留了备用名」时才真去探测:主 bin 命中是绝大多数
 * 情况,那条路只走一次同步的 accessSync 扫目录,不 exec 任何东西。
 *
 * ssh 目标一律返回 undefined:候选探测查的是**本机** PATH,拿本机结果去决定远端命令名
 * 只会更错。远端只装了备用名时,得由执行器 profile 显式指定(ExecutorBuildOpts.bin
 * 这个口子留着就是为它),而不是在这里猜。
 */
export async function execBinFor(spec: CliSpec, target?: ExecTarget): Promise<string | undefined> {
  if (spec.bins.length < 2) return undefined;
  if (target?.kind === "ssh") return undefined;
  if (resolveBin(spec.bins[0])) return undefined;
  const probe = await probeBins(spec.bins, spec.fallbackVersionMatch);
  // 一个都没命中就退回 bins[0]:让 spawnAgent 的预检报出「找不到 <主 bin>」,
  // 比在这里另造一条错误路径诚实(也走同一条 failedChild 惰性 emit)。
  return probe?.bin;
}
