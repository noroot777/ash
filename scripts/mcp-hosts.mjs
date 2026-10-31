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
import { readJsonLoose, spliceJsonMember } from "./json-edit.mjs";
import { scanTomlServers } from "./toml-scan.mjs";

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
    // 那个变量是「再加一份」不是「取代」—— 真 opencode 三组实测,依据记在 TS 那张表的 source。
    envFileMerges: true,
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
 * 这家 CLI **会读的全部配置文件**,低优先级在前、写入目标在最后。
 *
 * `dirEnvIsFile` 那个变量是「再加一份」而不是「取代默认那份」(本轮审查 R3,真 opencode 实测:
 * 全局那份里的 ash 照样生效)。所以判「有没有」必须看全这几份 —— 只看写入目标那一份,就会往
 * 更高优先级那份里再补一条、把本来连得上的那条顶掉。
 */
export function hostMcpSources(agentType, { env = process.env, home = homedir() } = {}) {
  const site = HOST_SITES[agentType];
  if (!site) return [];
  const target = hostMcpFile(agentType, { env, home });
  if (!target) return [];
  const fallback = join(site.dir(env, home), ...site.relative);
  const alt = (site.alternates || []).map((c) => join(site.dir(env, home), ...c)).find((f) => existsSync(f));
  const base = alt || fallback;
  return site.dirEnvIsFile && base !== target ? [base, target] : [target];
}

/** 一份来源里有没有 ash:`present` / `absent` / `unsure`(看不准 ⇒ 调用方不许写)。 */
function sourceState(file, site) {
  const read = readForWrite(file);
  if (!read) return { state: "unsure", why: `${file} 读不出来` };
  if (read.text === null) return { state: "absent" };
  if (site.shape === "toml") {
    const scan = scanTomlServers(read.text);
    if (scan.why) return { state: "unsure", why: `${file}：${scan.why}` };
    const taken = scan.names.filter((n) => n === ASH || n === LEGACY);
    return taken.length ? { state: "present", name: taken[0] } : { state: "absent" };
  }
  const doc = readJsonLoose(read.text);
  if (doc === undefined) return { state: "unsure", why: `${file} 解析不了` };
  const servers = doc === null ? undefined : doc[site.shape === "opencode" ? "mcp" : "mcpServers"];
  if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) {
    return { state: "unsure", why: `${file} 的登记容器不是对象` };
  }
  const taken = [ASH, LEGACY].filter((n) => servers && Object.hasOwn(servers, n));
  return taken.length ? { state: "present", name: taken[0] } : { state: "absent" };
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
  // **先看这家 CLI 会读的其它来源**(本轮审查 R3):任一份已经有 ash ⇒ 不写(往更高优先级那份
  // 补一条会把它顶掉);任一份看不准 ⇒ 也不写,如实说。谁优先、合不合并见 `envFileMerges`。
  for (const other of hostMcpSources(agentType, { env, home }).filter((f) => f !== file)) {
    const state = sourceState(other, site);
    if (state.state === "present") {
      return { file: other, added: false, why: `${other} 里已经有 ${state.name} 登记（${agentType} 也会读这份），不动它` };
    }
    if (state.state === "unsure") {
      return { file, added: false, why: `${state.why} —— ${agentType} 也会读这份配置，看不准就不写` };
    }
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
  const doc = readJsonLoose(text);
  if (doc === undefined) return { why: `${file} 解析不了，没动它 —— 手工修好再重跑 setup` };
  const servers = doc === null ? undefined : doc[container];
  if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) {
    return { why: `${file} 的 ${container} 不是对象，没动它` };
  }
  const taken = [ASH, LEGACY].filter((n) => servers && Object.hasOwn(servers, n));
  if (taken.length) return { why: `${file} 里已经有 ${taken.join(" / ")} 登记，不动它` };
  const value = site.shape === "opencode"
    ? { type: "local", command: [entry.command, ...entry.args], environment: { ...entry.env }, enabled: true }
    : site.type ? { type: site.type, ...entry } : entry;
  // **文本插入,不重新序列化**(本轮审查 R4):大整数、`1e999`、`-0`、重复键、注释、键序、
  // 缩进全按字节留着 —— 上一版 `JSON.parse` → `JSON.stringify` 往返会悄悄改掉用户保存的值。
  // 也因此带注释的 `.jsonc` 现在能自动补接了(原来只能如实说一句、让用户自己加)。
  const spliced = spliceJsonMember(text, container, ASH, value);
  if (!spliced.body) return { why: `${file}：${spliced.why}` };
  return { body: spliced.body };
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
  const body = current.trim() ? `${current.trimEnd()}\n\n${block}\n` : `${block}\n`;
  // **发布前把候选自己再扫一遍**(本轮审查 R2):重复一张同名表会让 CLI 整份配置都读不出来,
  // 所以「拼完之后恰好一张 ash 表、而且还扫得准」是写出去的前置条件 —— 不能只信扫描器判对。
  const after = scanTomlServers(body);
  if (after.why) return { why: `拼出来的配置自己又读不准了（${after.why}），所以没写` };
  if (!after.names.includes(ASH)) return { why: "拼出来的配置自己又读不出那条 ash 登记，所以没写" };
  if (after.duplicateTables.includes(ASH)) {
    return { why: "拼出来的配置里有不止一张 ash 表（TOML 不许重复表，CLI 会整份拒载），所以没写" };
  }
  return { body };
}
