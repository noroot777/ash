// setup 给 codex 接 ash MCP 的那一步。
//
// 「已经接过没有」**问 codex 本人**，不自己读 TOML。setup 得在 Node 22.16 上裸跑、导入不了
// server 那份结构扫描器（`server/src/codex-toml.ts`），而再写一份正则就是第五份判据 —— 上一版
// 就是 `^\[mcp_servers\.ash\]`：`[mcp_servers."ash"]` 它看不见，于是再追加一份同名表，TOML 里
// 那是重复定义，codex 整份配置解析失败（`duplicate key`），别的 MCP 一起没了（新链第 4 轮审查
// 第 2 条）。而「跑一次 npm run setup」正是派审预检给的补救办法。
//
// 所以：codex 读不动现在这份配置就不写；写完再问一遍，读不动了就原样还回去。
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** `codex mcp list --json` 的结果 → `{ ok, servers:[{name, enabled}] }` 或 `{ ok:false, why }`。 */
export function parseCodexList(status, stdout) {
  if (status !== 0) return { ok: false, why: `codex mcp list 退出码 ${status}` };
  try {
    const listed = JSON.parse(stdout);
    if (!Array.isArray(listed)) throw new Error("not an array");
    return { ok: true, servers: listed.map((e) => ({ name: String(e?.name), enabled: e?.enabled !== false })) };
  } catch {
    return { ok: false, why: "codex mcp list 的输出看不懂" };
  }
}

/** 删掉历史名那几段规范拼法的表（迁移用；带引号的拼法删不掉也无妨 —— 名字不同，不会重复）。 */
function withoutMcpServer(config, name) {
  const sections = new Set([`mcp_servers.${name}`, `mcp_servers.${name}.env`]);
  let skip = false;
  return config.split(/(?<=\n)/).filter((line) => {
    const header = /^\[([^\]]+)\]/.exec(line)?.[1];
    if (header) skip = sections.has(header);
    return !skip;
  }).join("");
}

/**
 * @param listServers 问 codex 本人：`() => parseCodexList(...)` 的结果
 * @returns action ∈ kept（已有，不动）| blocked（codex 读不动现有配置，没写）| added | migrated
 *          | rolledBack（写完 codex 读不动了，已还原）
 */
export function registerCodexMcp({ configFile, mcpEntry, url, name, legacyName, listServers }) {
  const before = listServers();
  if (!before.ok) return { action: "blocked", why: before.why };
  const current = before.servers.find((s) => s.name === name);
  if (current) return { action: "kept", enabled: current.enabled };
  const legacy = before.servers.some((s) => s.name === legacyName);

  const existing = existsSync(configFile) ? readFileSync(configFile, "utf8") : null;
  mkdirSync(dirname(configFile), { recursive: true });
  // 先备份再写:改的是用户自己的配置文件,出错要能一键还原。
  const backup = `${configFile}.bak-ash-setup`;
  if (existing !== null) copyFileSync(configFile, backup);
  // TOML 的字符串是转义的,Windows 路径里的 `\` 必须成对写,否则 `\d`、`\n`
  // 会被当转义序列吞掉 —— 装完看着成功,codex 起 MCP 时才报路径不存在。
  const base = legacy ? withoutMcpServer(existing ?? "", legacyName) : (existing ?? "");
  writeFileSync(
    configFile,
    `${base}\n[mcp_servers.${name}]\ncommand = "node"\nargs = [${JSON.stringify(mcpEntry)}]\n\n`
      + `[mcp_servers.${name}.env]\nASH_URL = "${url}"\n`,
  );

  const after = listServers();
  if (!after.ok || !after.servers.some((s) => s.name === name)) {
    if (existing !== null) writeFileSync(configFile, existing);
    else rmSync(configFile, { force: true });
    return { action: "rolledBack", why: after.ok ? `写完 codex 仍看不到 ${name}` : after.why };
  }
  return { action: legacy ? "migrated" : "added", backup: existing !== null ? backup : null };
}
