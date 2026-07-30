import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentType } from "@harness/shared";
import { CLI_SPECS } from "./executors/catalog/index.js";
import { resolveExecutorFor } from "./executors/index.js";

const exec = promisify(execFile);

export interface DetectedAgent {
  type: AgentType;
  bin: string;
  available: boolean;
  path: string | null;
  version: string | null;
  /** 支持常驻会话(openResident)——只有这类 CLI 能当 /team 的调度者。 */
  resident: boolean;
}

/**
 * 已知 CLI 目录里一项的**展示面**。
 *
 * 字段全部来自 `executors/catalog/` 里那个 CLI 的 spec —— 目录是单一真相来源,这里
 * 只是把展示需要的那几个字段挑出来(spec 还带执行参数和 parser 函数,不能整份丢给
 * 前端:函数没法序列化,执行细节也不是界面的事)。
 *
 * `type` 与 `key` 恒等,两个都留是为了兼容前端已有用法:key 做 React key、type 做
 * 「派给谁」的取值。目录里的每一项现在都能派任务(执行部分未实测的带 `untested`)。
 */
export interface KnownCli {
  /** 稳定标识,前端拿它做 key(bin 会变,见 cursor 的 cursor-agent → agent)。 */
  key: string;
  name: string;
  /** 中文一句话,卡片副标题。 */
  description: string;
  /** 候选命令名,按顺序探测,第一个探到的算数(见 spec 里各自的注释)。 */
  bins: string[];
  /** 备用命令名的自证要求(见 CliCatalogEntry.fallbackVersionMatch)。 */
  fallbackVersionMatch?: string;
  docsUrl: string;
  /** 官方安装命令原文。只给用户复制,**服务端永不执行**。 */
  installCommand: string;
  /** 可作为 harness 执行器的 AgentType(= key)。 */
  type: AgentType;
  /** true = 执行参数按官方文档写、本机未实测(前端据此打标)。 */
  untested?: boolean;
}

export interface DetectedCli extends KnownCli {
  /** 实际探到的命令名(bins 里命中的那个);没探到则回落 bins[0]。 */
  bin: string;
  available: boolean;
  path: string | null;
  version: string | null;
  /** 该执行器支持常驻会话(能当 /team 调度者)—— 直接问执行器本人有没有 openResident。 */
  resident: boolean;
}

// 目录 → 展示面。挑字段而不是整份 spread:spec 里有 parser / factory 这些函数,
// 一起 spread 出去会被 JSON.stringify 静默丢掉,还把执行细节泄给了界面。
const KNOWN_CLIS: KnownCli[] = CLI_SPECS.map((s) => ({
  key: s.key,
  type: s.key,
  name: s.name,
  description: s.description,
  bins: s.bins,
  fallbackVersionMatch: s.fallbackVersionMatch,
  docsUrl: s.docsUrl,
  installCommand: s.installCommand,
  untested: s.untested,
}));

async function which(bin: string): Promise<string | null> {
  try {
    const { stdout } = await exec("which", [bin]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function version(bin: string): Promise<string | null> {
  try {
    const { stdout } = await exec(bin, ["--version"], { timeout: 4000 });
    return (stdout.split("\n")[0] || "").trim() || null;
  } catch {
    return null;
  }
}

async function detectOne(cli: KnownCli): Promise<DetectedCli> {
  const want = cli.fallbackVersionMatch?.toLowerCase();
  let bin = cli.bins[0];
  let path: string | null = null;
  let ver: string | null = null;
  for (const [i, candidate] of cli.bins.entries()) {
    const found = await which(candidate);
    if (!found) continue;
    const v = await version(candidate);
    // 备用名要自证身份,证不了就当没探到,继续往下试。
    if (i > 0 && want && !(v ?? "").toLowerCase().includes(want)) continue;
    bin = candidate;
    path = found;
    ver = v;
    break;
  }
  return {
    ...cli,
    bin,
    available: !!path,
    path,
    version: ver,
    // 没装的 CLI 不去解析执行器,直接算它不支持常驻 —— 反正启动器只在 available
    // 的里面挑。装了的才问执行器本人有没有 openResident(目前只有 claude 有;
    // GenericCliExecutor 一律不实现,「谁能当团队调度者」的过滤就靠这个)。
    resident: path
      ? !!(await resolveExecutorFor({ type: cli.type }).then((e) => e.openResident, () => null))
      : false,
  };
}

// 探测整份已知 CLI 目录(DESIGN.md §5/§0)。全量返回、不做过滤 —— 装了没装、
// 执行参数实测没实测(untested)都在字段里,界面自己决定怎么展示。
export function detectKnownClis(): Promise<DetectedCli[]> {
  return Promise.all(KNOWN_CLIS.map(detectOne));
}

// 派任务视角的精简形状(形状保持不变):团队/辩论的执行器选择器靠它决定谁能当
// 调度者。`resident` 直接问执行器本人有没有 openResident —— 「谁能当调度者」只有
// 这一个真相来源,前端照着过滤就行,不用在 shared 里再抄一张名单出来漂移。
export async function detectLocalAgents(): Promise<DetectedAgent[]> {
  const all = await Promise.all(KNOWN_CLIS.map(detectOne));
  return all.map(({ type, bin, available, path, version, resident }) => ({
    type,
    bin,
    available,
    path,
    version,
    resident,
  }));
}
