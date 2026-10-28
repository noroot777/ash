import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ASH_MCP_SERVER_NAME, LEGACY_ASH_MCP_SERVER_NAME } from "@ash/shared/mcp";

const readConfig = (codexHome?: string): string => {
  const configPath = join(codexHome?.trim() || join(homedir(), ".codex"), "config.toml");
  try { return readFileSync(configPath, "utf8"); } catch { return ""; }
};

const hasServer = (config: string, name: string): boolean =>
  new RegExp(`^\\[mcp_servers\\.${name}\\]`, "m").test(config);

/**
 * 新安装统一叫 ash；尚未重跑 setup 的机器可能仍只有历史 harness 条目。
 * 只在规范名确实不存在时回退，避免给一个未声明的 server 塞配置导致 Codex 整体拒载。
 */
export function codexAshMcpServerName(codexHome = process.env.CODEX_HOME): string | null {
  const config = readConfig(codexHome);
  if (hasServer(config, ASH_MCP_SERVER_NAME)) return ASH_MCP_SERVER_NAME;
  if (hasServer(config, LEGACY_ASH_MCP_SERVER_NAME)) return LEGACY_ASH_MCP_SERVER_NAME;
  return null;
}

/**
 * 「登记在，但被显式关掉了」—— `enabled = false` 的那一种。
 *
 * **刻意不并进 `codexAshMcpServerName`**：那个函数的返回值同时被 `ensureCodexAshMcp`
 * 当成「要不要补写一段」的判据，关掉时若回 null，它就会再追加一份 `[mcp_servers.ash]`，
 * 于是 config.toml 里出现重复表头、codex 连整份配置都解析不了。所以这一问单独回答，
 * 只服务于「起跑前能不能拿到 ash MCP」那道预检。
 *
 * 只看主表自己的 `enabled`：子表（`.env` / `.tools.*`）里的同名键不是这个意思。
 */
export function codexAshMcpDisabled(codexHome = process.env.CODEX_HOME): boolean {
  const name = codexAshMcpServerName(codexHome);
  if (!name) return false;                       // 没登记是另一回事，不归这里答
  let inside = false;
  for (const line of readConfig(codexHome).split(/\r?\n/)) {
    const header = /^\s*\[\[?([^\]]+)\]\]?\s*$/.exec(line);
    if (header) { inside = header[1].trim() === `mcp_servers.${name}`; continue; }
    if (inside && /^\s*enabled\s*=\s*false\b/.test(line)) return true;
  }
  return false;
}
