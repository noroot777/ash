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
// claude / codex 起跑时由 ash 注入自己的 MCP(`executors/ash-mcp-inject.ts`),不写也不看
// 配置,一律算接上;真连没连上以每回合 CLI 自己报的为准。其余几家看宿主机那份配置
// (`hostCliConfigDir` 已经尊重各家的配置目录变量)。怎么判、怎么拼、怎么安全落盘全在
// `mcp-registry/`,这里只挑目录、兜住异常。
import type { AgentType, ExecutorAshMcp, PersonalAshMcp } from "@ash/shared";
import { injectsAshMcp } from "../executors/ash-mcp-inject.js";
import { ashMcpMechanism } from "../mcp-registry/catalog.js";
import { ashMcpHandAdvice, ashMcpUnsupported } from "../mcp-registry/register.js";
import { ashMcpRegistration, ensureAshMcp, hostCliConfigDir, INJECTED_ASH_MCP } from "./user-cli-mcp.js";

const failed = (problem: string): PersonalAshMcp => ({ configured: false, serverName: null, problem });

/**
 * 注册/导入执行器那一下把 ash MCP 接进它起跑时读的那份配置。**从不抛**:执行器已经落库了,
 * 接不上不该把一次成功的注册说成失败(那样用户一重试就多一条),原因如实带回去。
 */
export async function ensureExecutorAshMcp(
  agentType: AgentType,
  _ownerUserId: string | null,
): Promise<PersonalAshMcp> {
  if (injectsAshMcp(agentType)) return INJECTED_ASH_MCP;
  try {
    const dir = hostCliConfigDir(agentType);
    if (!dir) return failed(`${agentType} 没有可写 MCP 登记的配置目录`);
    return await ensureAshMcp(dir, agentType);
  } catch (e) {
    return failed(`补写 ash MCP 登记失败：${(e as Error).message}`);
  }
}

/**
 * 这个执行器**现在**的 ash MCP 状态。只读:不建目录、不补写。三态:确定有才是 connected,
 * 确定没有(或关着)才是 missing,其余一律 unknown 并**带上原因**。
 */
export async function executorAshMcpState(
  agentType: string,
  _ownerUserId: string | null,
  extraArgs: string[] = [],
): Promise<ExecutorAshMcp> {
  if (injectsAshMcp(agentType)) return CONNECTED;
  try {
    const unsupported = ashMcpUnsupported(agentType, ashMcpMechanism(agentType));
    if (unsupported) return { state: unsupported.tier === "refuse" ? "missing" : "unknown", detail: unsupported.why };
    const dir = hostCliConfigDir(agentType);
    if (!dir) return unknown(`算不出 ${agentType} 的配置目录，看不出 ash MCP 接没接上`);
    const found = ashMcpRegistration(dir, agentType);
    // 执行器自己带了 MCP 覆盖参数时,配置文件只是一半事实:参数既能补接,也能把文件里那条
    // 关掉或整组换掉,而这些参数是真传给 CLI 的。两头都说成 unknown。
    if (extraArgs.some((arg) => /mcp/i.test(arg))) {
      return unknown(found.state === "present"
        ? "配置里有 ash MCP 登记，但这个执行器的参数里带了 MCP 相关的覆盖（可能把它关掉或换掉），看不出最终接没接上"
        : "配置文件里没看到可用的 ash MCP 登记，但这个执行器的参数里带了 MCP 相关的覆盖，看不出最终接没接上");
    }
    if (found.state === "present") return CONNECTED;
    if (found.state === "unknown") return unknown(`看不准这个执行器有没有接上 ash MCP：${found.detail}`);
    if (found.state === "disabled") return missing(`${found.detail}，ash 没有替你打开`);
    // 手工那段跟自动补接走同一次合成:这份配置不许往末尾接时,给的是原因而不是一段照抄会坏的配置。
    const hand = ashMcpHandAdvice(agentType, dir, process.env);
    if (hand && "block" in hand) {
      return missing(`${found.detail}，这个执行器交不了卷。要手工接的话，把这段加到 ${hand.file} 末尾：\n${hand.block}`);
    }
    if (hand) return missing(`${found.detail}，这个执行器交不了卷；这份配置不能直接往末尾追加：${hand.why}`);
    return missing(`${found.detail}，这个执行器交不了卷（接法见 docs/install.md）`);
  } catch (e) {
    // 诊断本身出错不该把执行器列表打成 500,但也不能当成「接上了」。
    return unknown(`检查 ash MCP 登记时出错：${(e as Error).message}`);
  }
}

const CONNECTED: ExecutorAshMcp = { state: "connected", detail: null };
const missing = (detail: string): ExecutorAshMcp => ({ state: "missing", detail });
const unknown = (detail: string): ExecutorAshMcp => ({ state: "unknown", detail });

/**
 * 注册/导入那一下的最终状态:补接结果 + 这个执行器自己的只读诊断,**两份都要**。
 *
 * 补接只管「配置文件里有没有那条」,是按 CLI 类型做的;诊断才看得见这个执行器自己的参数。
 * 所以补接成功也不能直接当成接上了 —— 一律以诊断为准;补接没成时三态仍取诊断那一份(跟随后
 * 的 GET 同一判据),原因换成补接自己的说法,它多一句「为什么没替你写」。
 */
export async function registeredExecutorAshMcp(
  ensured: PersonalAshMcp,
  agentType: string,
  ownerUserId: string | null,
  extraArgs: string[],
): Promise<ExecutorAshMcp> {
  const read = await executorAshMcpState(agentType, ownerUserId, extraArgs);
  if (ensured.configured) return read;
  // 补接说没成、读出来却是接上的:两边各执一词就是「判不准」,不能报成接上了。
  return { state: read.state === "connected" ? "unknown" : read.state, detail: ensured.problem };
}

/** 库里那一列 extraArgs(JSON 字符串)→ 参数表。读不出就按没带参数判。 */
export function storedExtraArgs(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === "string") : [];
  } catch {
    return [];
  }
}
