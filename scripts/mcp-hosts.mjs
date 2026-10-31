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
//  · 落盘走 `config-publish.mjs` 那套**发布事务**(确认读到过 → 就地写 → 失败回写 → 写完
//    读回来比对)。本轮审查 R1:上一版直接 `writeFileSync`,注入一次 ENOSPC 就把用户整份
//    配置留成了半截 —— 有备份不等于失败安全,CLI 读的是活动那份。
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { publishConfirmed, readForWrite } from "./config-publish.mjs";

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
 *  · `opaque`    同目录里这家也读、而我们读不了格式的文件(trae 的原生 YAML):存在就不写
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
    relative: ["mcp.json"], shape: "mcpServers", type: "stdio",
  },
  qwen: {
    // `QWEN_HOME` 是最终配置目录,不是 home(审查 R3;依据记在 TS 那张表的 source 里)。
    bins: ["qwen"], dirEnv: "QWEN_HOME", dir: underHome(".qwen"),
    relative: ["settings.json"], shape: "mcpServers",
  },
  qoder: {
    bins: ["qodercli"], dirEnv: null,
    dir: (env, home) => join(home, (env.QODER_CONFIG_DIR_NAME || "").trim() || ".qoder"),
    relative: ["mcp.json"], shape: "mcpServers",
  },
  copilot: {
    bins: ["copilot"], dirEnv: "COPILOT_HOME", dir: underHome(".copilot"),
    relative: ["mcp-config.json"], shape: "mcpServers", type: "local",
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
  trae: {
    // 原生配置是 YAML(`~/.trae/traecli.yaml`),本仓没有保得住注释缩进的 YAML 写入器,
    // 所以走它另外支持的标准 `mcpServers` JSON;同目录那几份 YAML 它也读、我们读不了,
    // 存在就一个字都不写(`opaque`)。
    bins: ["traecli"], dirEnv: null, dir: underHome(".trae"),
    relative: ["mcp.json"], alternates: [[".mcp.json"]],
    opaque: [["traecli.yaml"], ["mcp.yaml"], [".mcp.yaml"]],
    shape: "mcpServers", type: "stdio",
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
  // 同目录有这家也读、而我们读不了格式的配置(trae 的原生 YAML)⇒ 一个字都不写:ash 可能
  // 已经写在那里面了,而同名登记同时来自两份配置、谁生效没有文档依据。
  const opaque = (site.opaque || []).map((parts) => join(dirname(file), ...parts)).find((f) => existsSync(f));
  if (opaque) {
    return {
      file,
      added: false,
      why: `${opaque} 这份配置 ${agentType} 也会读，而 ash 读不了它的格式，所以没动 ${file}`
        + "（请在那份配置里自己加一条 ash 登记，接法见 docs/install.md）",
    };
  }
  // **先拿到一次成功的读**:读不动不是「空」(见 config-publish.mjs 的 readForWrite)。
  const read = readForWrite(file);
  if (!read) return { file, added: false, why: `${file} 读不出来，没有自动补写` };
  const entry = { command: nodeBin, args: [mcpEntry], env: { ASH_URL: url } };
  const written = site.shape === "toml"
    ? composeToml(read.text, entry, site)
    : composeJson(read.text, entry, site, file);
  if (!written.body) return { file, added: false, why: written.why };
  const published = publishConfirmed({ file, previous: read.text, body: written.body });
  if (!published.ok) return { file, added: false, why: published.why };
  return { file, added: true, backup: published.backup };
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
    : site.type ? { type: site.type, ...entry } : entry;
  config[container] = current;
  return { body: `${JSON.stringify(config, null, 2)}\n` };
}

/** `[mcp_servers.ash]`(grok;codex 走 `codex-mcp.mjs` 那条带 CLI 批准的路)。 */
function composeToml(text, entry, site) {
  const current = text === null ? "" : text;
  const scan = scanTomlServers(current);
  // 判不准一律不写:TOML 里重复一张同名表会让 CLI 整份配置都读不出来,连用户别的 MCP 一起没了。
  if (scan.why) return { why: `${scan.why}，所以没敢自动追加（写重了会让整份配置读不出来）` };
  const taken = scan.names.filter((n) => n === ASH || n === LEGACY);
  if (taken.length) return { why: `配置里已经有 ${taken.join(" / ")} 这条登记了，不动它` };
  if (scan.disabled.some((n) => n === ASH || n === LEGACY)) {
    return { why: `配置里的 disabled_mcp_servers 关掉了 ${scan.disabled.join(" / ")}，没有替你打开` };
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

/**
 * 这份 TOML 里已经登记了哪几个 MCP、根级关掉了哪几个 —— **结构判据,不是全文搜**。
 *
 * 上一版「只要提到 mcp_servers 就不写」(本轮审查 R6):用户早先装过任何一个第三方 MCP,
 * ash 就永远接不上,而 grok 没有隔离档那条路可以后补 —— 安装器跳过就是真的没接上。
 * 反过来也不能退成正则全文扫(那是 R7 在 TS 侧的病):多行字符串里的示例会被当成真事实。
 *
 * 所以**只认两种写法,其余一律回 why**(不写比写错便宜得多):
 *  · `[mcp_servers.<名>]` / `[[…]]` / `[mcp_servers."名"]` 这样的表头 —— 取名字;
 *  · 根级 `disabled_mcp_servers = ["a","b"]`(写在一行里的数组);
 *  · 别的地方再出现 `mcp_servers` 这个词(内联表 `mcp_servers = { … }`、点号键
 *    `mcp_servers.ash.command = …`、某个值里带着这个词)⇒ 判不准,不写。
 *
 * 注释和多行字符串先剔掉再判(它们里面的文本不是事实);单行引号里的文本不剔 —— 那种
 * 情况会落到「判不准」,方向偏向不写。
 */
function scanTomlServers(text) {
  const bare = [];                                  // 剔掉注释和多行字符串之后的同构行
  let ml = null;
  for (const raw of text.split(/\r?\n/)) {
    if (ml) {                                       // 多行字符串里:只找它的收尾
      bare.push("");
      if (raw.includes(ml)) ml = null;
      continue;
    }
    const opened = /("""|''')/.exec(raw);
    if (opened) {
      bare.push(raw.slice(0, opened.index));
      if (!raw.slice(opened.index + 3).includes(opened[1])) ml = opened[1];
      continue;
    }
    bare.push(raw.replace(/#.*$/, ""));
  }
  if (ml) return { why: "配置里有一个多行字符串到文件结尾还没收尾（这份 TOML 本身读不通）" };

  const names = [];
  let disabled = [];
  const rest = [];
  for (const line of bare.map((l) => l.trim())) {
    if (!line) continue;
    if (line.startsWith("[")) {
      const header = /^\[\[?((?:[^\]"']|"(?:[^"\\]|\\.)*"|'[^']*')*)\]\]?$/.exec(line);
      const path = header ? tomlKeyPath(header[1]) : null;
      if (!path) return { why: `表头 ${line} 按 TOML 读不通` };
      if (path[0] === "mcp_servers") {
        // `[mcp_servers]` 本体底下只能靠点号键给出名字 —— 那一档我们不认,交给「判不准」。
        if (path.length < 2) return { why: "配置里有一张 [mcp_servers] 总表（名字写在点号键里，ash 认不了）" };
        names.push(path[1]);
      }
      continue;
    }
    const off = /^disabled_mcp_servers[ \t]*=[ \t]*\[(.*)\][ \t]*$/.exec(line);
    if (off) {
      disabled = [...(off[1].match(/"(?:[^"\\]|\\.)*"|'[^']*'/g) || [])].map((q) => unquoteToml(q) ?? "");
      continue;
    }
    rest.push(line);
  }
  // 剩下的地方不许再出现这个词:内联表、点号键、值里带着它,我们都读不准。
  const stray = rest.find((l) => /mcp_servers/.test(l));
  if (stray) return { why: `配置里这一行提到了 mcp_servers，而 ash 读不准它的写法：${stray.slice(0, 60)}` };
  return { names, disabled };
}

/** `mcp_servers."ash".env` → `["mcp_servers","ash","env"]`;读不通返回 null。 */
function tomlKeyPath(raw) {
  const out = [];
  let i = 0;
  while (i < raw.length) {
    while (raw[i] === " " || raw[i] === "\t") i++;
    if (raw[i] === '"' || raw[i] === "'") {
      const re = raw[i] === '"' ? /^"(?:[^"\\]|\\.)*"/ : /^'[^']*'/;
      const m = re.exec(raw.slice(i));
      const text = m ? unquoteToml(m[0]) : null;
      if (!m || text === null) return null;
      out.push(text);
      i += m[0].length;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(raw.slice(i));
      if (!m) return null;
      out.push(m[0]);
      i += m[0].length;
    }
    while (raw[i] === " " || raw[i] === "\t") i++;
    if (i >= raw.length) break;
    if (raw[i] !== ".") return null;
    i++;
  }
  return out.length ? out : null;
}

/** TOML 的字符串字面量 → 文本(双引号按转义解码,单引号原样);读不通返回 null。 */
function unquoteToml(raw) {
  if (raw.startsWith("'")) return raw.slice(1, -1);
  try { return JSON.parse(raw); } catch { return null; }
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
