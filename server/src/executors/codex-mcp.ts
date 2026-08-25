import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ASH_MCP_SERVER_NAME, LEGACY_ASH_MCP_SERVER_NAME } from "@ash/shared/mcp";

const hasServer = (config: string, name: string): boolean =>
  new RegExp(`^\\[mcp_servers\\.${name}\\]`, "m").test(config);

/**
 * 新安装统一叫 ash；尚未重跑 setup 的机器可能仍只有历史 harness 条目。
 * 只在规范名确实不存在时回退，避免给一个未声明的 server 塞配置导致 Codex 整体拒载。
 */
export function codexAshMcpServerName(codexHome = process.env.CODEX_HOME): string {
  const configPath = join(codexHome?.trim() || join(homedir(), ".codex"), "config.toml");
  let config = "";
  try { config = readFileSync(configPath, "utf8"); } catch { /* 新安装按规范名 */ }
  if (hasServer(config, ASH_MCP_SERVER_NAME)) return ASH_MCP_SERVER_NAME;
  if (hasServer(config, LEGACY_ASH_MCP_SERVER_NAME)) return LEGACY_ASH_MCP_SERVER_NAME;
  return ASH_MCP_SERVER_NAME;
}
