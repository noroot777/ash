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
// 边界,两条:
//  · **只搬 ash 这一条**,不搬宿主的其它 mcpServers。隔离档的意义是抹去宿主的订阅和
//    凭证,把别人的 server 一起搬过去就把那层意义破坏了;ash 自己这条是**完成协议的
//    一部分**,不是用户装的第三方能力。
//  · **已有登记一律不覆盖**(含历史名 `harness`)——用户可能自己改过 URL 或路径。
//
// 幂等,所以挂在 `ensureUserCliDir()` 上每次起跑都过一遍:已经有了就是两次文件读,
// 缺了才写。写一律走临时文件 + rename —— 这份 `.claude.json` 同时也是 CLI 自己在写的
// 文件,半截内容比缺一条登记更糟。
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PersonalAshMcp } from "@ash/shared";
import { ASH_MCP_SERVER_NAME, LEGACY_ASH_MCP_SERVER_NAME } from "@ash/shared/mcp";
import { codexAshMcpServerName } from "../executors/codex-mcp.js";
import { currentListeningPort } from "../listening-port.js";
import { REPO_DIR } from "../paths.js";

/** 本仓库这份 MCP 服务的入口。宿主没登记过时按它现拼一条。 */
const MCP_ENTRY = join(REPO_DIR, "mcp", "dist", "index.js");

const NO_SOURCE =
  `宿主机的配置里没有 ash MCP，仓库里也没有 ${MCP_ENTRY}(先在仓库根跑一次 npm run build，` +
  `或按 docs/install.md 走一遍 MCP 接入)`;

const ok = (serverName: string): PersonalAshMcp => ({ configured: true, serverName, problem: null });
const fail = (problem: string): PersonalAshMcp => ({ configured: false, serverName: null, problem });

/**
 * 这个个人配置目录里的 ash MCP 登记 —— **缺了就补**,补完把结果如实说出来。
 *
 * `hostHome` 只为回归测试留:产品代码永远用真 `homedir()`,测试拿一个假 HOME 来跑,
 * 免得测试碰宿主机那份 `~/.claude.json`(那是用户的真配置,一个字节都不该动)。
 */
export function ensureAshMcp(dir: string, agentType: string, hostHome: string = homedir()): PersonalAshMcp {
  try {
    if (agentType === "claude") return ensureClaudeAshMcp(dir, hostHome);
    if (agentType === "codex") return ensureCodexAshMcp(dir, hostHome);
    return fail(`${agentType} 没有个人配置目录，这一问不适用`);
  } catch (e) {
    return fail(`补写 ash MCP 登记失败：${(e as Error).message}`);
  }
}

// ── claude:~/.claude.json 的 mcpServers ────────────────────────────────────

function ensureClaudeAshMcp(dir: string, hostHome: string): PersonalAshMcp {
  const file = join(dir, ".claude.json");
  const doc = readJsonObject(file);
  if (!doc) return fail(`${file} 解析不了，没敢动它 —— 手工修好或删掉它再重启`);
  const already = claudeServerName(doc);
  if (already) return ok(already);
  const entry = hostClaudeEntry(hostHome) ?? builtinClaudeEntry();
  if (!entry) return fail(NO_SOURCE);
  const servers = (doc.mcpServers ?? {}) as Record<string, unknown>;
  // 规范名落地:宿主那份即使是历史名 harness,定义搬过来也按 ash 登记(同一个 server,
  // setup 迟早要迁;两边都叫 ash 之后,提示词里那句「ash MCP」才对得上工具名)。
  doc.mcpServers = { ...servers, [ASH_MCP_SERVER_NAME]: entry };
  writeAtomic(file, `${JSON.stringify(doc, null, 2)}\n`);
  return ok(ASH_MCP_SERVER_NAME);
}

function claudeServerName(doc: Record<string, unknown>): string | null {
  const servers = doc.mcpServers as Record<string, unknown> | undefined;
  if (!servers || typeof servers !== "object") return null;
  if (servers[ASH_MCP_SERVER_NAME]) return ASH_MCP_SERVER_NAME;
  if (servers[LEGACY_ASH_MCP_SERVER_NAME]) return LEGACY_ASH_MCP_SERVER_NAME;
  return null;
}

/** 宿主机上那条(装 ash 时 `claude mcp add` 写下的)。读不出来就当没有。 */
function hostClaudeEntry(hostHome: string): unknown | null {
  const doc = readJsonObject(join(hostHome, ".claude.json"));
  if (!doc) return null;
  const servers = doc.mcpServers as Record<string, unknown> | undefined;
  if (!servers || typeof servers !== "object") return null;
  return servers[ASH_MCP_SERVER_NAME] ?? servers[LEGACY_ASH_MCP_SERVER_NAME] ?? null;
}

function builtinClaudeEntry(): unknown | null {
  if (!existsSync(MCP_ENTRY)) return null;
  return { type: "stdio", command: "node", args: [MCP_ENTRY], env: { ASH_URL: localUrl() } };
}

// ── codex:$CODEX_HOME/config.toml 的 [mcp_servers.*] ───────────────────────

function ensureCodexAshMcp(dir: string, hostHome: string): PersonalAshMcp {
  // 「有没有」的判据跟执行器用的是同一份(codex-mcp.ts),免得两边对 TOML 的理解漂移。
  const already = codexAshMcpServerName(dir);
  if (already) return ok(already);
  const block = hostCodexBlock(hostHome) ?? builtinCodexBlock();
  if (!block) return fail(NO_SOURCE);
  const file = join(dir, "config.toml");
  const current = readTextOrEmpty(file);
  writeAtomic(file, current.trim() ? `${current.trimEnd()}\n\n${block}\n` : `${block}\n`);
  return ok(ASH_MCP_SERVER_NAME);
}

function hostCodexBlock(hostHome: string): string | null {
  const config = readTextOrEmpty(join(hostHome, ".codex", "config.toml"));
  if (!config) return null;
  return (
    extractTomlTables(config, ASH_MCP_SERVER_NAME) ??
    // 历史名的定义照搬,但表头改成规范名(理由同 claude 那边)。
    extractTomlTables(config, LEGACY_ASH_MCP_SERVER_NAME)?.replaceAll(
      `[mcp_servers.${LEGACY_ASH_MCP_SERVER_NAME}`,
      `[mcp_servers.${ASH_MCP_SERVER_NAME}`,
    ) ??
    null
  );
}

function builtinCodexBlock(): string | null {
  if (!existsSync(MCP_ENTRY)) return null;
  return (
    `[mcp_servers.${ASH_MCP_SERVER_NAME}]\n` +
    `command = "node"\n` +
    `args = [${JSON.stringify(MCP_ENTRY)}]\n\n` +
    `[mcp_servers.${ASH_MCP_SERVER_NAME}.env]\n` +
    `ASH_URL = ${JSON.stringify(localUrl())}\n`
  );
}

/**
 * 把 `[mcp_servers.<name>]` 连同它的子表(`.env` 等)整段抠出来。
 *
 * 只认**行首的表头**来切段:`[[…]]` 数组表也算一次切换,否则紧跟在目标段后面的
 * 数组表会被当成正文一起搬走。
 */
export function extractTomlTables(config: string, name: string): string | null {
  const wanted = `mcp_servers.${name}`;
  const picked: string[] = [];
  let inside = false;
  for (const line of config.split(/\r?\n/)) {
    const header = /^\s*\[\[?([^\]]+)\]\]?\s*$/.exec(line);
    if (header) {
      const path = header[1].trim();
      inside = path === wanted || path.startsWith(`${wanted}.`);
    }
    if (inside) picked.push(line);
  }
  while (picked.length && !picked[picked.length - 1].trim()) picked.pop();
  return picked.length ? picked.join("\n") : null;
}

// ── 小工具 ────────────────────────────────────────────────────────────────

const localUrl = () => `http://127.0.0.1:${currentListeningPort() ?? 4317}`;

/** 文件不存在 = 空文档(我们来建);解析不了 = null(**别动它**,上层如实报错)。 */
function readJsonObject(file: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readTextOrEmpty(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** 同目录临时文件 + rename:CLI 自己也在写这份文件,不能让它读到半截。 */
function writeAtomic(file: string, body: string): void {
  const tmp = `${file}.ash-tmp`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, file);
}
