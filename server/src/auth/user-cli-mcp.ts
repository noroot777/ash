// 个人 CLI 配置目录里的 ash MCP 登记 —— 隔离档下必须补的一位。
//
// 为什么非补不可:agent 交卷靠 ash MCP 的 `complete_task`,而那条登记是安装时用
// `claude mcp add ash --scope user` 写进**宿主机** `~/.claude.json` 的。隔离档起跑时
// 注入 `CLAUDE_CONFIG_DIR`,claude **整个取代** `~/.claude` 且不回落(user-cli.ts 顶部),
// 于是 agent 手上压根没有 `complete_task`。
// 2026-09-01 现场(任务 QeKaxh9q):活干完了、代码也提交了,最后一步
// `mcp__ash__complete_task` 撞回一句 "No such tool available",按完成协议记 failed ——
// 而界面上只看得到「失败」,看不出是工具不存在。README 早写着「未接入 MCP 的 agent
// 无法交卷,所有任务将显示为失败」,隔离档等于在用户不知情的情况下把一台**已经接入**的
// 实例退回了那个状态。
//
// codex 侧同源、且更隐蔽:宿主 `~/.codex/config.toml` 有 `[mcp_servers.ash]`,而个人
// `CODEX_HOME` 里连 `config.toml` 都没有,`codexAshMcpServerName()` 于是返回 null ——
// 丢的不只是工具,连回合身份 `env_vars` 都跟着不注了。
//
// **这个文件现在只是个门面**:怎么判、怎么拼、怎么落盘都在 `mcp-registry/`(按 agentType
// 的单源表 + 三个格式族 + 一份发布事务),2026-10-31 从这里搬出去的 —— 原来 claude 和 codex
// 各一条写死的路,另外十三家执行器一行注册逻辑都没有,换它们跑任务全是 failed。
// 门面留下来是因为调用方(设置页、起跑前补档、启动自检)认的是 `PersonalAshMcp` 这个形状。
//
// 边界,两条(搬家后仍由 `mcp-registry/register.ts` 保着):
//  · **只搬 ash 这一条**,不搬宿主的其它 mcpServers。隔离档的意义是抹去宿主的订阅和
//    凭证,把别人的 server 一起搬过去就把那层意义破坏了;ash 自己这条是**完成协议的
//    一部分**,不是用户装的第三方能力。
//  · **已有登记一律不覆盖**(含历史名 `harness`)——用户可能自己改过 URL 或路径。
//
// 幂等,所以挂在 `ensureUserCliDir()` 上每次起跑都过一遍:已经有了就是两次文件读,
// 缺了才写。
import { homedir } from "node:os";
import type { PersonalAshMcp } from "@ash/shared";
import { ashMcpConfigDir } from "../mcp-registry/catalog.js";
import { registerAshMcp } from "../mcp-registry/register.js";
import { ashMcpHostFile, ashMcpStateIn } from "../mcp-registry/sources.js";
import { askCodexHere, codexAccepts, type CodexAsk } from "./codex-approve.js";

export { extractTomlTables } from "../codex-toml.js";
export type { CodexAsk } from "./codex-approve.js";

const ok = (serverName: string): PersonalAshMcp => ({ configured: true, serverName, problem: null });
const fail = (problem: string): PersonalAshMcp => ({ configured: false, serverName: null, problem });

/**
 * 这个个人配置目录里的 ash MCP 登记 —— **缺了就补**,补完把结果如实说出来。
 *
 * `hostHome` 只为回归测试留:产品代码永远用真 `homedir()`,测试拿一个假 HOME 来跑,
 * 免得测试碰宿主机那份 `~/.claude.json`(那是用户的真配置,一个字节都不该动)。
 *
 * `ask` 同样只为回归测试留 —— macOS 上探测层如实弃权,codex 那几条路在开发机上一条都
 * 跑不了,所以测试拿一个替身把它们逐个驱动起来(理由同 `probeCli` 的 `openUnit`)。
 */
export async function ensureAshMcp(
  dir: string,
  agentType: string,
  hostHome: string = homedir(),
  ask: CodexAsk = askCodexHere,
): Promise<PersonalAshMcp> {
  try {
    const result = await registerAshMcp({
      agentType,
      dir,
      hostHome,
      // 「发布前先问 CLI 本人」只有 codex 有:它的格式是 TOML,判官在它进程里。
      ...(agentType === "codex" ? { approve: (candidate: string) => codexAccepts(candidate, ask) } : {}),
    });
    return result.ok ? ok(result.serverName) : fail(result.why);
  } catch (e) {
    return fail(`补写 ash MCP 登记失败：${(e as Error).message}`);
  }
}

/**
 * 同一个问题的**只读**版:看一眼,不补、不建、不写。
 *
 * 谁要它:「共用宿主机 CLI」那一档(§八之二)。那一档真正生效的是**宿主机**的配置目录,
 * 而宿主那份 `~/.claude.json` 是用户自己的配置 —— 检查可以,写一个字都不行。
 */
export function readAshMcp(dir: string, agentType: string): PersonalAshMcp {
  const found = ashMcpRegistration(dir, agentType);
  return found.state === "present" ? ok(found.serverName!) : fail(found.detail);
}

export type AshMcpRegistration = {
  /**
   * present=登记在且没关 / absent=确实没有 / disabled=登记在但显式关掉了 /
   * unknown=读不出来，别据此下结论
   */
  state: "present" | "absent" | "disabled" | "unknown";
  serverName: string | null;
  detail: string;
};

/**
 * 同一个问题的**三态**版本。
 *
 * 为什么 `PersonalAshMcp` 那两态不够用：它把「确实没有登记」和「文件读不出来」一起记成
 * `configured:false`，只有文案能把它们分开。设置页拿它显示没问题 —— 两种都该提示用户去看
 * 一眼。但起跑前的预检要据此**拦下一整轮审查**，而拦错的代价是一条根本跑不起来的链，
 * 所以这两种必须分得开，由调用方自己决定向哪边开（预检一律向放行开，见
 * `ash-mcp-reachability.ts`）。
 */
export function ashMcpRegistration(dir: string, agentType: string): AshMcpRegistration {
  const found = ashMcpStateIn(dir, agentType);
  return {
    state: found.state,
    serverName: found.serverName,
    detail: found.detail || (found.state === "present" ? "" : "这个配置目录里没有 ash MCP 登记"),
  };
}

/**
 * 宿主机那份配置里的 ash MCP —— 共用档下 agent 真正用的就是它。
 *
 * claude 的用户级配置是 `~/.claude.json`(在 home 根,不在 `~/.claude` 里),codex 的是
 * `~/.codex/config.toml`;各家路径深浅不一,所以这里不能拿 home 当 dir 直接问。
 */
export function hostAshMcp(agentType: string, hostHome: string = homedir()): PersonalAshMcp {
  const dir = hostCliConfigDir(agentType, hostHome);
  return dir ? readAshMcp(dir, agentType) : fail(`${agentType} 没有宿主级配置目录，这一问不适用`);
}

/**
 * 宿主机上这个 CLI 真正读的配置目录。
 *
 * **必须尊重 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 那一族变量**:它们由 ash 进程原样继承给
 * 子进程,CLI 认的就是它们。写死 `homedir()` 会两头都错(第 1 轮审查 F1 的同类位置)——
 * 实际目录有登记却报缺失,默认目录有登记而实际目录没有时又漏报。哪家认哪个变量在
 * `mcp-registry/catalog.ts` 那张表里。
 */
export function hostCliConfigDir(agentType: string, hostHome: string = homedir()): string | null {
  return ashMcpConfigDir(agentType, process.env, hostHome);
}

/**
 * 宿主机上这个 CLI 的用户级配置文件在哪（跟着 `hostCliConfigDir` 走）。
 * 启动自检告警时拿它把路径指给用户（它不存在不代表 CLI 没装，见 `warnHostAshMcp`）。
 */
export function hostCliConfigFile(agentType: string, hostHome: string = homedir()): string | null {
  return ashMcpHostFile(agentType, process.env, hostHome);
}
