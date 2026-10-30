// setup 给 codex 接 ash MCP 的那一步。
//
// 「已经接过没有」**问 codex 本人**，不自己读 TOML。setup 得在 Node 22.16 上裸跑、导入不了
// server 那份结构扫描器（`server/src/codex-toml.ts`），而再写一份正则就是第五份判据 —— 上一版
// 就是 `^\[mcp_servers\.ash\]`：`[mcp_servers."ash"]` 它看不见，于是再追加一份同名表，TOML 里
// 那是重复定义，codex 整份配置解析失败（`duplicate key`），别的 MCP 一起没了（新链第 4 轮审查
// 第 2 条）。而「跑一次 npm run setup」正是派审预检给的补救办法。
//
// 所以：codex 读不动现在这份配置就不写；写完再问一遍，读不动了就原样还回去。迁移历史名时
// 删旧条目也交给 codex 自己（`codex mcp remove`）—— 上一版按行首表头字面量删，
// `[mcp_servers.harness.tools.*]` 这类子表留成一条没有 command 的孤儿，codex 整份拒载，
// 迁移必然回滚，还把一份本来健康的配置说成「读不出来」（新链第 5 轮审查第 2 条）。
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

/** 同目录临时文件 + rename：codex 读到的要么是旧的、要么是写完的，没有半截。 */
function writeAtomic(file, body) {
  const tmp = `${file}.ash-tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, file);
}

/**
 * @param listServers 问 codex 本人：`() => parseCodexList(...)` 的结果
 * @param removeServer 让 codex 本人删掉一条登记（`codex mcp remove <名>`），成功回 true
 * @returns action ∈ kept（已有，不动）| blocked（codex 读不动现有配置，没写）| added | migrated
 *          | rolledBack（写完 codex 读不动了，已还原）| foreignChange（写完 codex 读不动，但这
 *          期间文件被别的程序改过，所以没还原）；added 带 legacyLeft = 历史名没删掉
 */
export function registerCodexMcp({ configFile, mcpEntry, url, name, legacyName, listServers, removeServer }) {
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
  // 还原。`expect` 给了就先确认**盘上还是我们自己写下的那一版**(server 侧同一条不变量,
  // 审查第 2 轮 F1):问 codex 那一问是个子进程,这期间用户或另一个 setup 可能已经存过新
  // 内容,拿旧快照盖回去就是把它抹掉。不是我们那一版就什么都不动,如实报出来。
  const restore = (why, expect) => {
    if (expect !== undefined) {
      const now = existsSync(configFile) ? readFileSync(configFile, "utf8") : null;
      if (now !== expect) {
        return {
          action: "foreignChange",
          why: `${why}；而 ${configFile} 在这期间被别的程序改过，所以没有还原（免得盖掉那次改动）`,
          backup: existing !== null ? backup : null,
        };
      }
    }
    if (existing !== null) writeAtomic(configFile, existing);
    else rmSync(configFile, { force: true });
    return { action: "rolledBack", why, backup: existing !== null ? backup : null };
  };
  // 删不掉就留着：两个名字 ash 都认，名字不同不会重复定义；下面如实报「没删掉」。
  if (legacy && !removeServer(legacyName)) {
    const now = existsSync(configFile) ? readFileSync(configFile, "utf8") : null;
    if (now !== existing) return restore(`codex mcp remove ${legacyName} 失败`);
  }
  const base = existsSync(configFile) ? readFileSync(configFile, "utf8") : "";
  // TOML 的字符串是转义的,Windows 路径里的 `\` 必须成对写,否则 `\d`、`\n`
  // 会被当转义序列吞掉 —— 装完看着成功,codex 起 MCP 时才报路径不存在。
  const written = `${base}\n[mcp_servers.${name}]\ncommand = "node"\nargs = [${JSON.stringify(mcpEntry)}]\n\n`
    + `[mcp_servers.${name}.env]\nASH_URL = "${url}"\n`;
  writeAtomic(configFile, written);

  const after = listServers();
  if (!after.ok || !after.servers.some((s) => s.name === name)) {
    return restore(after.ok ? `写完 codex 仍看不到 ${name}` : after.why, written);
  }
  const backupPath = existing !== null ? backup : null;
  const legacyLeft = after.servers.some((s) => s.name === legacyName);
  if (legacy && !legacyLeft) return { action: "migrated", backup: backupPath };
  return { action: "added", backup: backupPath, legacyLeft };
}
