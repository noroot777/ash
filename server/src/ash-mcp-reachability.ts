// 「这一轮起跑之后，agent 手上会不会有 ash MCP」—— 派审前的那道预检。
//
// 2026-10-28 现场：一位用户的 codex 审查者跑满 35 分钟、报告完整落盘，最后一句是
// 「当前未提供 report_stage 工具，无法实际上报 verify_failed」。ash 这边只写了一句
// 「未能正常给出结论，已停止自动链」。真相是那次会话里 ash MCP 整组工具都不在 ——
// codex 的 ash MCP 来自它自己的 `config.toml`，起不来时只往 stderr 写一行、退出码
// 照样 0，ash 这边一无所知，于是 35 分钟和 5.81M token 一起作废。
//
// 这一问**在起跑前就答得出来**：登记在不在，是读一个文件的事。所以审查轮不必先跑完
// 再发现自己交不了卷。
//
// 判据只有一条硬规矩：**向放行开**。拦错一轮审查，用户得到的是一条根本跑不起来的链；
// 放过一轮，最差也只是回到今天的样子（跑完没结论，由 `review-channel-gap.ts` 如实说明
// 原因）。所以只有「确实没有登记」「明确写着 enabled = false」这两种确定答案才拦，
// 文件读不出来、执行器不是 claude/codex、配置目录问不出来，一律放行。
import { homedir } from "node:os";
import { join } from "node:path";
import { ashMcpRegistration } from "./auth/user-cli-mcp.js";
import { cliConfigDirForOwner } from "./auth/run-env.js";
import { codexAshMcpDisabled } from "./executors/codex-mcp.js";

export interface AshMcpReach {
  /** false 只在**确定拿不到**时出现；任何不确定都是 true */
  reachable: boolean;
  /** reachable=false 时写给用户的一句话（已含自查办法） */
  problem: string | null;
}

const ok = (): AshMcpReach => ({ reachable: true, problem: null });

/** 自查命令，直接写进拦截文案 —— 只说「没有登记」，用户还得自己去搜怎么查。 */
const HOW_TO_CHECK: Record<string, string> = {
  claude: "claude mcp get ash",
  codex: "codex mcp list --json（看 ash 在不在、enabled 是不是 true）",
};

/**
 * 这一轮真正生效的 CLI 配置目录。
 *
 * 隔离档下是归属人的个人目录（`cliConfigDirForOwner` 给的那个，两个 CLI 都只有一层）；
 * 共用档/自用模式下回落到宿主机默认位置 —— 注意 claude 的用户级配置是 home **根**下的
 * `.claude.json`，codex 的是 `~/.codex/config.toml`，两条路径差一层，不能拿 home 当
 * 同一个 dir 直接问。
 */
function configDirFor(agentType: string, isolated: string | null): string | null {
  if (isolated) return isolated;
  if (agentType === "claude") return homedir();
  if (agentType === "codex") return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  return null;
}

/**
 * 这条任务下一轮起跑时，它的 agent 够不够得着 ash MCP。
 *
 * 只认 claude / codex：别的执行器的 MCP 登记不经 ash 的手（`scripts/setup.mjs` 也只管
 * 这两个加 kimi），对它们一律放行 —— 「ash 不知道」不等于「它没有」。
 */
export async function ashMcpReachability(
  ownerUserId: string | null | undefined,
  agentType: string,
): Promise<AshMcpReach> {
  if (agentType !== "claude" && agentType !== "codex") return ok();
  let dir: string | null;
  try {
    dir = configDirFor(agentType, await cliConfigDirForOwner(ownerUserId ?? null, agentType));
  } catch {
    return ok();                                  // 配置目录都问不出来，就没资格拦人
  }
  if (!dir) return ok();
  const found = ashMcpRegistration(dir, agentType);
  if (found.state === "unknown") return ok();     // 读不出来 ≠ 没有
  if (found.state === "absent") {
    return {
      reachable: false,
      problem: `${agentType} 的配置目录 ${dir} 里没有 ash MCP 登记，这一轮跑完也上报不了结论`
        + `（自查：${HOW_TO_CHECK[agentType]}；接法见 docs/install.md，或在仓库根跑一次 npm run setup）`,
    };
  }
  if (agentType === "codex" && codexAshMcpDisabled(dir)) {
    return {
      reachable: false,
      problem: `${join(dir, "config.toml")} 里的 [mcp_servers.${found.serverName}] 写着 enabled = false，`
        + `codex 不会加载它，这一轮跑完也上报不了结论（自查：${HOW_TO_CHECK.codex}）`,
    };
  }
  return ok();
}
