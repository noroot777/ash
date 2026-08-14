import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExecTarget } from "@harness/shared";
import { resolveBin, resolveLaunch } from "./spawn.js";
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

// 版本自证跑的是 resolveLaunch **已经解析出来的绝对路径**,不是裸命令名。
// 裸命令名只走子进程继承的 process.env.PATH,而解析额外扫了补充目录
// (/opt/homebrew/bin、~/.local/bin、~/.bun/bin…)—— 从 GUI/预览启动 server 时
// PATH 常常缺这些目录,于是「找得到文件、却证不了身份」,cursor 的官方备用名 agent
// 会被误判为不可用。用同一条解析口径,检测与 spawnAgent 就不会打架。
// 走 resolveLaunch 而不是 resolveBin,是因为 Windows 上命中的多半是 `.cmd` 垫片:
// 直接 execFile 一个批处理会被 Node 拒(CVE-2024-27980),必须由它决定是拆成
// `node <script>` 还是过 cmd.exe。
async function versionOf(bin: string): Promise<string | null> {
  let plan;
  try {
    plan = resolveLaunch(bin, ["--version"]);
  } catch {
    return null;
  }
  if (!plan) return null;
  try {
    const { stdout } = await exec(plan.file, plan.args, {
      timeout: 4000,
      windowsHide: true,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
    });
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
 * 只会更错。远端只装了备用名时,正解是让用户显式指定命令名 —— `ExecutorBuildOpts.bin`
 * 这个口子留着就是为它,但**执行器 profile 目前还没有这个字段**(`agents` 表无 bin 列,
 * `build()` 恒传 undefined)。这是已知缺口而不是回归(重构前 ssh 同样只用 bins[0]);
 * 补齐要动 DB schema + shared 的 AgentExecutorProfile + web/mobile 的执行器表单,
 * 属于「智能体面板」那条线的产品改动,不该由这里偷偷猜一个远端命令名来糊。
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
