// 执行器那一行的 ash MCP:注册时接上,之后每次读都如实说「现在接没接上」。
//
// 原来只有 `npm run setup` 会往宿主机配置里写这条，而 setup 只认得跑它那一刻装好的几家 CLI:
// 之后才装的 CLI、换过 `CODEX_HOME` 的机器、压根没跑过 setup 的安装，注册出来的执行器
// 第一次交卷才发现没有 `complete_task`。注册执行器是用户亲手说「我要用这家 CLI 跑活」的那一下，
// 也就是写这条登记最该发生的时刻 —— 启动自检(`warnHostAshMcp`)仍然只出声不写，
// 它不是用户发起的动作。
//
// 两个入口,分工固定:
//  · `ensureExecutorAshMcp` —— 注册/导入那一下,缺了才写、已有不覆盖;
//  · `executorAshMcpState` —— 列表、改设置这些读写响应里的**只读**诊断,一个字节都不写。
// 「没接上」不能只活在创建那一次的返回体里:刷新一下、改一下供应商它就没了,而配置其实
// 还是没接上(第 1 轮审查第 1 条)。所以每个返回执行器的响应都现读一次。
//
// 看哪一份跟起跑时 `cliConfigEnvFor` 选的是同一份:隔离档下有个人目录的 CLI 看个人目录，
// 其余(含共用档)看宿主机那份(`hostCliConfigDir` 已经尊重 `CLAUDE_CONFIG_DIR` 那一族变量)。
// 怎么判、怎么拼、怎么安全落盘全在 `mcp-registry/`,这里只挑目录、兜住异常。
import type { AgentType, ExecutorAshMcp, PersonalAshMcp } from "@ash/shared";
import { fileAshMcpVerdict } from "../ash-mcp-file.js";
import { ashMcpMechanism } from "../mcp-registry/catalog.js";
import { ashMcpHandAdvice, ashMcpUnsupported } from "../mcp-registry/register.js";
import { configDirEnvVar, seedUserCliDir, userCliDir } from "./user-cli.js";
import { ensureAshMcp, hostCliConfigDir } from "./user-cli-mcp.js";

const failed = (problem: string): PersonalAshMcp => ({ configured: false, serverName: null, problem });

/** 隔离档下这个执行器有没有个人目录(有就看它,没有就看宿主机那份)。 */
async function personalOwner(agentType: string, ownerUserId: string | null): Promise<string | null> {
  if (!ownerUserId || !configDirEnvVar(agentType)) return null;
  // 动态 import:mode.ts / db 都在 auth 这一圈里绕回来,顶层导入会绕出一个环。
  const { isHostCliIsolated } = await import("./mode.js");
  return (await isHostCliIsolated()) ? ownerUserId : null;
}

/**
 * 注册/导入执行器那一下把 ash MCP 接进它起跑时读的那份配置。**从不抛**:执行器已经落库了,
 * 接不上不该把一次成功的注册说成失败(那样用户一重试就多一条),原因如实带回去。
 * 建个人目录那一步(`seedUserCliDir`)也在兜的范围里 —— 它是同步的 mkdir/写文件,
 * 目录被占成普通文件、没权限、盘满都会直接抛(第 1 轮审查第 2 条)。
 */
export async function ensureExecutorAshMcp(
  agentType: AgentType,
  ownerUserId: string | null,
): Promise<PersonalAshMcp> {
  try {
    const owner = await personalOwner(agentType, ownerUserId);
    const dir = owner ? seedUserCliDir(owner, agentType) : hostCliConfigDir(agentType);
    if (!dir) return failed(`${agentType} 没有可写 MCP 登记的配置目录`);
    return await ensureAshMcp(dir, agentType);
  } catch (e) {
    return failed(`补写 ash MCP 登记失败：${(e as Error).message}`);
  }
}

/**
 * 这个执行器**现在**的 ash MCP 状态。只读:不建目录、不补写。
 *
 * 判据是起跑预检问不了 CLI 时退的那一档(`fileAshMcpVerdict`),三态照它原样分:只有确定
 * 有才是 connected,确定没有(或关着)才是 missing,其余一律 unknown 并**带上原因** ——
 * 配置写坏了、格式读不了、执行器自己带了配置文件里看不见的 MCP 覆盖参数,都不是「没问题」。
 * 上一版把 unknown 和诊断异常都收成「没有缺口」,注册时明明说了「配置读不通、没替你写」,
 * 一刷新提示就没了而配置一个字没改(第 2 轮审查第 2 条)。
 */
export async function executorAshMcpState(
  agentType: string,
  ownerUserId: string | null,
  extraArgs: string[] = [],
): Promise<ExecutorAshMcp> {
  try {
    const unsupported = ashMcpUnsupported(agentType, ashMcpMechanism(agentType));
    if (unsupported) return { state: unsupported.tier === "refuse" ? "missing" : "unknown", detail: unsupported.why };
    const owner = await personalOwner(agentType, ownerUserId);
    const envVar = owner ? configDirEnvVar(agentType) : null;
    const dir = owner ? userCliDir(owner, agentType) : hostCliConfigDir(agentType);
    if (!dir) return unknown(`算不出 ${agentType} 的配置目录，看不出 ash MCP 接没接上`);
    const env = envVar ? { ...process.env, [envVar]: dir } : process.env;
    const verdict = fileAshMcpVerdict(agentType, env, []);
    if (verdict.state === "present") return CONNECTED;
    // 配置里看不出来,而执行器自己带了 MCP 覆盖参数(codex 的 `-c mcp_servers.…` 一类):
    // 那几个参数可能正是接法,配置文件这一档说不了「没有」。
    if (extraArgs.some((arg) => /mcp/i.test(arg))) {
      return unknown("配置文件里没看到可用的 ash MCP 登记，但这个执行器的参数里带了 MCP 相关的覆盖，看不出最终接没接上");
    }
    if (verdict.state === "unknown") return unknown(`看不准这个执行器有没有接上 ash MCP：${verdict.why}`);
    if (verdict.state === "disabled") return missing(`${verdict.detail}，ash 没有替你打开`);
    // 手工那段跟自动补接走同一次合成:这份配置不许往末尾接时,给的是原因而不是一段照抄会坏的配置。
    const hand = ashMcpHandAdvice(agentType, dir, env);
    if (hand && "block" in hand) {
      return missing(`${verdict.detail}，这个执行器交不了卷。要手工接的话，把这段加到 ${hand.file} 末尾：\n${hand.block}`);
    }
    if (hand) return missing(`${verdict.detail}，这个执行器交不了卷；这份配置不能直接往末尾追加：${hand.why}`);
    return missing(`${verdict.detail}，这个执行器交不了卷（接法见 docs/install.md）`);
  } catch (e) {
    // 诊断本身出错不该把执行器列表打成 500,但也不能当成「接上了」。
    return unknown(`检查 ash MCP 登记时出错：${(e as Error).message}`);
  }
}

const CONNECTED: ExecutorAshMcp = { state: "connected", detail: null };
const missing = (detail: string): ExecutorAshMcp => ({ state: "missing", detail });
const unknown = (detail: string): ExecutorAshMcp => ({ state: "unknown", detail });
