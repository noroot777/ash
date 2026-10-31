// 安装时给各家 CLI 的**宿主机**配置补上 ash MCP 登记 —— 裸 Node 那一份。
//
// 为什么又有一份:`setup.mjs` 跑在裸 Node 上(npm run setup 时还没 build 过),导不进
// server 那边的 TypeScript。所以同一条规矩在这个仓库里有两份实现,靠回归测试钉着不漂:
// `server/scripts/test-ash-mcp-registry.ts` 会把这张表和 `mcp-registry/catalog.ts` 那张
// 逐项比对(路径、环境变量、格式族、要不要 enabled/type),对不上就红。
//
// 边界(用户 2026-10-30 的硬要求,这里是唯一会碰用户宿主配置的写入口):
//  · **只在缺 ash 条目时追加**,其它条目(含用户自己装的第三方 MCP)一个字节都不动;
//  · 已有 ash 或历史名 harness 一律不覆盖 —— 用户可能自己改过 URL 或路径;
//  · 读不出来、解析不了、有注释(序列化会丢注释)一律不写,如实回一句话;
//  · **就地写**,不走 temp+rename:换上去的是新文件,Windows 的 DACL、POSIX 扩展 ACL 都
//    抄不过去,硬链接还会被断开(规矩全文见 server/src/auth/config-publish.ts)。
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const atHome = (_env, home) => home;
const underHome = (...segments) => (_env, home) => join(home, ...segments);
const xdgConfig = (name) => (env, home) =>
  join((env.XDG_CONFIG_HOME || "").trim() || join(home, ".config"), name);

/**
 * 一家 CLI 的落点。字段跟 TS 那张表一一对应:
 *  · `bins`      这台机器上装没装(装了才写 —— 没装就建目录等于乱留垃圾)
 *  · `dirEnv`    「整体取代配置目录」的变量;`dirEnvIsFile` = 它指的是文件
 *  · `shape`     三个格式族之一
 *  · `type`      这条登记要不要带 `"type": "stdio"`(cursor 文档说必填,claude 自己也写)
 *  · `enabled`   TOML 那一族要不要带 `enabled = true`(跟着该 CLI 自己 mcp add 的写法)
 */
export const HOST_SITES = {
  gemini: {
    bins: ["gemini"], dirEnv: "GEMINI_CLI_HOME", dir: atHome,
    relative: [".gemini", "settings.json"], shape: "mcpServers",
  },
  grok: {
    bins: ["grok"], dirEnv: "GROK_HOME", dir: underHome(".grok"),
    relative: ["config.toml"], shape: "toml", enabled: true,
  },
  kimi: {
    bins: ["kimi"], dirEnv: "KIMI_CODE_HOME", dir: underHome(".kimi-code"),
    relative: ["mcp.json"], shape: "mcpServers",
  },
  opencode: {
    bins: ["opencode"], dirEnv: "OPENCODE_CONFIG", dirEnvIsFile: true, dir: xdgConfig("opencode"),
    relative: ["opencode.json"], alternates: [["opencode.jsonc"]], shape: "opencode",
  },
  cursor: {
    bins: ["cursor-agent", "agent"], dirEnv: null, dir: underHome(".cursor"),
    relative: ["mcp.json"], shape: "mcpServers", type: true,
  },
  qwen: {
    bins: ["qwen"], dirEnv: "QWEN_HOME", dir: atHome,
    relative: [".qwen", "settings.json"], shape: "mcpServers",
  },
  qoder: {
    bins: ["qodercli"], dirEnv: null,
    dir: (env, home) => join(home, (env.QODER_CONFIG_DIR_NAME || "").trim() || ".qoder"),
    relative: ["mcp.json"], shape: "mcpServers",
  },
  copilot: {
    bins: ["copilot"], dirEnv: "COPILOT_HOME", dir: underHome(".copilot"),
    relative: ["mcp-config.json"], shape: "mcpServers",
  },
  kiro: {
    bins: ["kiro-cli"], dirEnv: null, dir: underHome(".kiro"),
    relative: ["settings", "mcp.json"], shape: "mcpServers",
  },
  kilo: {
    bins: ["kilo"], dirEnv: "KILO_CONFIG", dirEnvIsFile: true, dir: xdgConfig("kilo"),
    relative: ["kilo.json"],
    alternates: [["kilo.jsonc"], ["config.json"], ["opencode.json"], ["opencode.jsonc"]],
    shape: "opencode",
  },
  antigravity: {
    bins: ["antigravity", "agy"], dirEnv: null, dir: underHome(".gemini", "config"),
    relative: ["mcp_config.json"], shape: "mcpServers",
  },
  pi: {
    bins: ["pi"], dirEnv: "PI_CODING_AGENT_DIR", dir: underHome(".pi", "agent"),
    relative: ["mcp.json"], shape: "mcpServers",
  },
};

const ASH = "ash";
const LEGACY = "harness";

/** 这家 CLI 的配置文件落在哪(`alternates` 存在哪个就用哪个,免得多出一份两边都生效)。 */
export function hostMcpFile(agentType, { env = process.env, home = homedir() } = {}) {
  const site = HOST_SITES[agentType];
  if (!site) return null;
  const override = site.dirEnv ? (env[site.dirEnv] || "").trim() : "";
  if (override && site.dirEnvIsFile) return override;
  const dir = override || site.dir(env, home);
  for (const candidate of site.alternates || []) {
    const file = join(dir, ...candidate);
    if (existsSync(file)) return file;
  }
  return join(dir, ...site.relative);
}

/**
 * 缺了就追加。返回 `{ file, added, why }`:`added:false` + `why` = 没写,原因如实说。
 *
 * 不认得的 agentType 直接抛 —— 调用方拼错名字该当场知道,不该静默跳过(静默正是这轮在治的病)。
 */
export function registerHostMcp({ agentType, mcpEntry, url, nodeBin = process.execPath, env = process.env, home = homedir() }) {
  const site = HOST_SITES[agentType];
  if (!site) throw new Error(`没有 ${agentType} 的 MCP 落点`);
  const file = hostMcpFile(agentType, { env, home });
  const existing = readOrNull(file);
  const entry = { command: nodeBin, args: [mcpEntry], env: { ASH_URL: url } };
  const written = site.shape === "toml"
    ? composeToml(existing, entry, site)
    : composeJson(existing, entry, site, file);
  if (!written.body) return { file, added: false, why: written.why };
  if (existing !== null) copyFileSync(file, `${file}.bak-ash-setup`);
  else mkdirSync(dirname(file), { recursive: true });
  // 就地写(理由见文件头)。原来有内容的话,写坏了至少还有上面那份 .bak-ash-setup。
  writeFileSync(file, written.body, "utf8");
  return { file, added: true };
}

function readOrNull(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;                                   // 读不动就不是「空」,别拿它当底稿去写
  }
}

/** `mcpServers`(claude/gemini/kimi/cursor/qwen/qoder/copilot/kiro/antigravity/pi)与 opencode 的 `mcp`。 */
function composeJson(text, entry, site, file) {
  const container = site.shape === "opencode" ? "mcp" : "mcpServers";
  if (text !== null && hasJsonComments(text)) {
    return { why: `${file} 里有注释，自动改写会把注释丢掉，所以没动它 —— 请自己加一条 ash 登记` };
  }
  const config = text === null || !text.trim() ? {} : JSON.parse(text);
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`${file} 不是 JSON 对象，未修改`);
  }
  const servers = config[container];
  if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) {
    throw new Error(`${file} 的 ${container} 不是对象，未修改`);
  }
  const current = servers || {};
  if (Object.hasOwn(current, ASH) || Object.hasOwn(current, LEGACY)) {
    return { why: `${file} 里已经有 ash/harness 登记，不动它` };
  }
  current[ASH] = site.shape === "opencode"
    ? { type: "local", command: [entry.command, ...entry.args], environment: { ...entry.env }, enabled: true }
    : site.type ? { type: "stdio", ...entry } : entry;
  config[container] = current;
  return { body: `${JSON.stringify(config, null, 2)}\n` };
}

/** `[mcp_servers.ash]`(grok;codex 走 `codex-mcp.mjs` 那条带 CLI 批准的路)。 */
function composeToml(text, entry, site) {
  const current = text === null ? "" : text;
  // 裸 Node 这边没有那个结构扫描器(它在 server/src/codex-toml.ts),所以**只要提到
  // mcp_servers 就不写**:TOML 里重复一张同名表会让 CLI 整份配置都读不出来,连用户别的
  // MCP 一起没了。宁可不写、如实说一句。
  if (/mcp_servers/.test(current)) {
    return { why: "配置里已经提到 mcp_servers，没敢自动追加（重复的表会让整份配置读不出来）" };
  }
  const lines = [
    `[mcp_servers.${ASH}]`,
    `command = ${JSON.stringify(entry.command)}`,
    `args = [${entry.args.map((a) => JSON.stringify(a)).join(", ")}]`,
  ];
  if (site.enabled) lines.push("enabled = true");
  lines.push("", `[mcp_servers.${ASH}.env]`);
  for (const [k, v] of Object.entries(entry.env)) lines.push(`${k} = ${JSON.stringify(v)}`);
  const block = lines.join("\n");
  return { body: current.trim() ? `${current.trimEnd()}\n\n${block}\n` : `${block}\n` };
}

/** 有注释就不改写(理由同 TS 那边的 `jsonComposeGuard`)。 */
function hasJsonComments(text) {
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) return true;
  }
  return false;
}
