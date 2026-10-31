// setup 给 codex 接 ash MCP 的那一步。
//
// 「已经接过没有」**问 codex 本人**，不自己读 TOML。setup 得在 Node 22.16 上裸跑、导入不了
// server 那份结构扫描器（`server/src/codex-toml.ts`），而再写一份正则就是第五份判据 —— 上一版
// 就是 `^\[mcp_servers\.ash\]`：`[mcp_servers."ash"]` 它看不见，于是再追加一份同名表，TOML 里
// 那是重复定义，codex 整份配置解析失败（`duplicate key`），别的 MCP 一起没了（新链第 4 轮审查
// 第 2 条）。而「跑一次 npm run setup」正是派审预检给的补救办法。
//
// **用户那份配置只被我们在批准之后写一次**，codex 碰的全是沙盘里的副本（审查第 4 轮 F2）：
// 删历史名也交给 codex 自己（`codex mcp remove`，上一版按行首表头字面量删，
// `[mcp_servers.harness.tools.*]` 这类子表留成一条没有 command 的孤儿，codex 整份拒载 —— 新链
// 第 5 轮审查第 2 条），但它自己也是「写临时文件再 rename」：让它去改用户真文件，硬链接在那一步
// 就断了，我们后面再怎么保身份都来不及，删到一半失败还会把用户那份留在中间状态。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// 整条发布事务(预演 → 备份 → 写盘前再校验一次 → 就地写 → 读回来比对)只有一份实现,
// 规矩连同它的来历见该文件的头部注释。**这条路也必须走它**:上一版只在这里手写了「比对
// 快照 + 备份 + publishInPlace」三行,于是预演那一道完全没有,持续写盘故障照样把用户那份
// 留成半截(本轮审查 F2 的对称扫描项)。
import { publishConfirmed, TMP_MODE } from "./config-publish.mjs";

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

/**
 * @param listServers 问 codex 本人：`(home?) => parseCodexList(...)` 的结果。给了 home 就问
 *                    那个 `CODEX_HOME` 里的配置（沙盘），不给就问用户自己那份
 * @param removeServer 让 codex 本人在**沙盘**里删掉一条登记：`(name, home) => boolean`
 * @returns action ∈ kept（已有，不动）| blocked（codex 读不动 —— 现有的那份，或者补完那段的
 *          那份；写不进它所在的目录也算 —— 三种都是一个字节都没写）| added | migrated |
 *          foreignChange（批准期间用户那份被别的程序改过，所以没写）；added 带
 *          legacyLeft = 历史名没删掉
 */
export function registerCodexMcp({ configFile, mcpEntry, url, name, legacyName, listServers, removeServer }) {
  const before = listServers();
  if (!before.ok) return { action: "blocked", why: before.why };
  const current = before.servers.find((s) => s.name === name);
  if (current) return { action: "kept", enabled: current.enabled };
  const legacy = before.servers.some((s) => s.name === legacyName);

  const existing = existsSync(configFile) ? readFileSync(configFile, "utf8") : null;
  const sandbox = mkdtempSync(join(tmpdir(), "ash-setup-codex-"));
  const sandboxCfg = join(sandbox, "config.toml");
  try {
    // 迁移、追加、确认全在副本上做,用户那份这期间一个字节都不动。
    writeFileSync(sandboxCfg, existing ?? "", { mode: TMP_MODE });
    // 删不掉就留着：两个名字 ash 都认，名字不同不会重复定义；下面如实报「没删掉」。
    const legacyRemoved = legacy ? removeServer(legacyName, sandbox) : false;
    const base = readFileSync(sandboxCfg, "utf8");
    // TOML 的字符串是转义的,Windows 路径里的 `\` 必须成对写,否则 `\d`、`\n`
    // 会被当转义序列吞掉 —— 装完看着成功,codex 起 MCP 时才报路径不存在。
    const written = `${base}\n[mcp_servers.${name}]\ncommand = "node"\nargs = [${JSON.stringify(mcpEntry)}]\n\n`
      + `[mcp_servers.${name}.env]\nASH_URL = "${url}"\n`;
    writeFileSync(sandboxCfg, written, { mode: TMP_MODE });

    // 批准:拼完这份,codex 本人读得动吗、ash 真的列出来了吗。
    const after = listServers(sandbox);
    if (!after.ok) return { action: "blocked", why: `${after.why}（补上那段之后）` };
    if (!after.servers.some((s) => s.name === name)) {
      return { action: "blocked", why: `补上那段之后 codex 仍看不到 ${name}` };
    }

    // 批准过了才碰用户那份,而且只替换我们读到的那一版(问 codex 那一问是个子进程,这期间
    // 用户或另一个 setup 可能已经存过新内容,拿旧快照盖回去就是把它抹掉)。这几道
    // (新鲜度、预演、备份、读回来比对)全在发布器里,这里不再手写第二份。
    const published = publishConfirmed({ file: configFile, previous: existing, body: written });
    if (!published.ok) {
      return published.stale
        // 它一个字节都没被我们动过,给备份路径只会让人以为我们改了。
        ? { action: "foreignChange", why: published.why, backup: null }
        : { action: "blocked", why: published.why };
    }
    const legacyLeft = after.servers.some((s) => s.name === legacyName);
    if (legacy && legacyRemoved && !legacyLeft) return { action: "migrated", backup: published.backup };
    return { action: "added", backup: published.backup, legacyLeft };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}
