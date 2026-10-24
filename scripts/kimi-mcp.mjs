import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function registerKimiMcp({ configDir, mcpEntry, url, nodeBin = process.execPath }) {
  const file = join(configDir, "mcp.json");
  const existing = existsSync(file) ? readFileSync(file, "utf8") : null;
  const config = existing === null ? {} : JSON.parse(existing);
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`${file} 不是 JSON 对象，未修改`);
  }
  if (config.mcpServers !== undefined &&
    (!config.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers))) {
    throw new Error(`${file} 的 mcpServers 不是对象，未修改`);
  }
  const servers = config.mcpServers ?? {};
  if (Object.hasOwn(servers, "ash") || Object.hasOwn(servers, "harness")) {
    return { file, added: false };
  }
  servers.ash = { command: nodeBin, args: [mcpEntry], env: { ASH_URL: url } };
  config.mcpServers = servers;
  mkdirSync(configDir, { recursive: true });
  if (existing !== null) copyFileSync(file, `${file}.bak-ash-setup`);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  return { file, added: true };
}
