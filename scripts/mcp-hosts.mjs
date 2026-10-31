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
 *  · `dirEnv`    指到配置文件/目录的变量;`dirEnvIsFile` = 它指的是文件
 *  · `altDirEnv` 「再加一个配置目录」的变量(优先级高于默认目录)
 *  · `contentEnv` 整段配置就装在这个变量里(优先级最高,**没有文件可写**)
 *  · `sourcesMerge` 这家会读好几份、而且合并语义实测过(见 `effectiveState`)
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
    // 这家会读好几份配置、合起来看、高优先级那份赢 —— 真 opencode 逐格实测,八格依据记在
    // TS 那张表的 source 里(本轮审查 F4)。`sourcesMerge` 的语义见 `effectiveState`。
    altDirEnv: "OPENCODE_CONFIG_DIR",
    contentEnv: "OPENCODE_CONFIG_CONTENT",
    sourcesMerge: true,
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

/** 某个配置目录里该写哪一份(`alternates` 存在哪个就用哪个,免得多出一份两边都生效)。 */
function fileInDir(dir, site) {
  for (const candidate of site.alternates || []) {
    const file = join(dir, ...candidate);
    if (existsSync(file)) return file;
  }
  return join(dir, ...site.relative);
}

/**
 * 这一层目录里**实际存在**的那几份;一份都不存在时给出该写哪一份。
 *
 * 「该写哪一份」只有 `fileInDir` 一份判据,所以把它挑中的那个**排在最后** —— `hostMcpFile`
 * 取的是最后一个,两边因此必然一致(kilo 同时有 `config.json` 和 `opencode.jsonc` 时,
 * alternates 的顺序就是优先级,按 existsSync 的自然顺序取最后一个会挑错)。
 */
function filesInDir(dir, site, level) {
  const names = [site.relative, ...(site.alternates || [])];
  const found = names.map((parts) => join(dir, ...parts)).filter((f) => existsSync(f));
  const pick = fileInDir(dir, site);
  const files = found.length ? [...found.filter((f) => f !== pick), pick] : [pick];
  return files.map((file) => ({ label: file, file, level }));
}

/**
 * 这家 CLI 在宿主机上**会读的全部配置**,按优先级**从低到高**。
 *
 * 为什么不是一个文件(真 opencode 逐格实测,本轮审查 F4;TS 那份 `ashMcpHostSources` 同模型):
 *  · `OPENCODE_CONFIG` 是「再加一份」不是「取代」—— 全局那份里的 ash 照样生效;
 *  · 默认目录里 `opencode.json` 和 `opencode.jsonc` **两份都读**(上一版「找到第一个就只认
 *    它」,于是 ash 写在 `.json`、目录里又有一份 `.jsonc` 时判成没有,安装器还往 `.jsonc`
 *    里再补一条);
 *  · `OPENCODE_CONFIG_DIR` 是**再加一个目录**、优先级高于默认目录;
 *  · `OPENCODE_CONFIG_CONTENT` 里那整段 JSON 优先级最高、而且**没有文件可写**。
 *
 * 判「到底有没有」一律走 `effectiveState`:这几份合起来 CLI 最终看到的是哪一条。
 */
export function hostMcpSources(agentType, { env = process.env, home = homedir() } = {}) {
  const site = HOST_SITES[agentType];
  if (!site) return [];
  // `dirEnv` 指到**目录**时整体取代默认目录;指到**文件**时这一层仍是默认目录(那份全局
  // 配置照样会被读,见上面第一条)。
  const dirOverride = site.dirEnv && !site.dirEnvIsFile ? (env[site.dirEnv] || "").trim() : "";
  const out = filesInDir(dirOverride || site.dir(env, home), site, 0);
  const altDir = site.altDirEnv ? (env[site.altDirEnv] || "").trim() : "";
  if (altDir) out.push(...filesInDir(altDir, site, 1));
  const file = site.dirEnvIsFile && site.dirEnv ? (env[site.dirEnv] || "").trim() : "";
  if (file && !out.some((s) => s.file === file)) out.push({ label: file, file, level: 2 });
  const inline = site.contentEnv ? (env[site.contentEnv] || "").trim() : "";
  if (inline) out.push({ label: `$${site.contentEnv}`, file: null, text: inline, level: 3 });
  return out;
}

/** 写入落点 = **优先级最高的那份可写来源**(只读来源当然不能当落点)。 */
export function hostMcpFile(agentType, { env = process.env, home = homedir() } = {}) {
  const writable = hostMcpSources(agentType, { env, home }).filter((s) => s.file);
  return writable.length ? writable[writable.length - 1].file : null;
}

/** 这条登记有没有被显式关掉。两种写法都认(`disabled: true` / `enabled: false`),跟 TS 同口径。 */
const switchedOff = (entry) => entry.disabled === true || entry.enabled === false;

/**
 * 一份来源里有没有 ash:`present` / `absent` / `disabled` / `unsure`(看不准 ⇒ 调用方不许写)。
 *
 * 判据跟 TS 那份 `shapes.ts` 的 `pickEntry` 一一对应:先找**开着**的那条(两个兼容名是两条
 * 独立登记),都关着才报 disabled;值认不出来(不是对象)一律 unsure —— 当没有去写就会把
 * 用户那个键覆盖掉,跟「已有登记一律不覆盖」自相矛盾。
 */
function sourceState(source, site) {
  let text;
  if (source.file) {
    const read = readForWrite(source.file);
    if (!read) return { state: "unsure", why: `${source.label} 读不出来` };
    if (read.text === null) return { state: "absent" };
    text = read.text;
  } else {
    text = source.text || "";
  }
  if (site.shape === "toml") {
    const scan = scanTomlServers(text);
    if (scan.why) return { state: "unsure", why: `${source.label}：${scan.why}` };
    const taken = scan.names.filter((n) => n === ASH || n === LEGACY);
    if (!taken.length) return { state: "absent" };
    const off = taken.filter((n) => scan.disabled.includes(n));
    return off.length === taken.length
      ? { state: "disabled", name: taken[0], why: `${source.label} 里的 ${taken.join(" / ")} 被 disabled_mcp_servers 关掉了` }
      : { state: "present", name: taken.find((n) => !off.includes(n)) };
  }
  const doc = readJsonLoose(text);
  if (doc === undefined) return { state: "unsure", why: `${source.label} 解析不了` };
  const servers = doc === null ? undefined : doc[site.shape === "opencode" ? "mcp" : "mcpServers"];
  if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) {
    return { state: "unsure", why: `${source.label} 的登记容器不是对象` };
  }
  const off = [];
  for (const name of [ASH, LEGACY]) {
    const raw = servers ? servers[name] : undefined;
    if (raw === undefined) continue;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { state: "unsure", why: `${source.label} 里的 ${name} 这条登记不是一个对象` };
    }
    if (!switchedOff(raw)) return { state: "present", name };
    off.push(name);
  }
  return off.length
    ? { state: "disabled", name: off[0], why: `${source.label} 里的 ${off.join(" / ")} 登记是关着的` }
    : { state: "absent" };
}

/**
 * 几份来源合起来,这家 CLI **最终看到的**是哪一条登记 —— 跟 TS 那份 `effectiveConfigState`
 * 同一条判据:**声明了这个名字的来源里,优先级最高的那份说了算**。高优先级那份只写
 * `{"enabled": false}` 也算声明,它会合到低优先级那条上、把它关掉(真 opencode 实测)。
 *
 * 两处一律回 unsure(看不准就不写):**同一层**两份结论不一致(同层谁覆盖谁没实测);
 * 这家的合并语义本身没实测(`sourcesMerge` 不为真)而几份结论不一致。
 */
function effectiveState(sources, site) {
  // `label` = 最终说了算的那一份来源,话术里要指名道姓(用户得知道去看哪个文件)。
  const read = sources.map((source) => ({ source, st: { ...sourceState(source, site), label: source.label } }));
  if (!read.length) return { state: "unsure", why: "算不出这家 CLI 会读哪几份配置" };
  if (read.length === 1) return read[0].st;
  const kinds = new Set(read.map((r) => r.st.state));
  if (!site.sourcesMerge && kinds.size > 1) {
    return {
      state: "unsure",
      why: "这家 CLI 会读好几份配置，而它们的结论不一致、合并规则 ash 没实测过："
        + read.map((r) => r.st.why || `${r.source.label}：${r.st.state}`).join("；"),
    };
  }
  const declared = read.filter((r) => r.st.state !== "absent");
  if (!declared.length) return read[read.length - 1].st;
  const top = Math.max(...declared.map((r) => r.source.level));
  const winners = declared.filter((r) => r.source.level === top);
  const unsure = winners.find((r) => r.st.state === "unsure");
  if (unsure) return unsure.st;
  if (new Set(winners.map((r) => r.st.state)).size > 1) {
    return {
      state: "unsure",
      why: "这家 CLI 同一层里有好几份配置，它们的结论不一致、谁覆盖谁 ash 没实测过："
        + winners.map((r) => r.st.why || `${r.source.label}：${r.st.state}`).join("；"),
    };
  }
  return winners[0].st;
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
  // **先看这家 CLI 会读的全部来源**(本轮审查 F4):判的是「最终生效的是哪一条」,不是
  // 「有没有任一份里有」—— 高优先级那份只写 `{"enabled": false}` 也会把低优先级那条关掉
  // (真 opencode 实测)。已经生效 ⇒ 不写(往别处补一条也顶不过它);关着 ⇒ 不替用户打开;
  // 看不准 ⇒ 不写,如实说。谁优先、合不合并见 `effectiveState` 与站点上的 `sourcesMerge`。
  const sources = hostMcpSources(agentType, { env, home });
  if (sources.length > 1) {
    const state = effectiveState(sources, site);
    if (state.state === "present") {
      return {
        file: state.label,
        added: false,
        why: `${state.label} 里已经有生效的 ${state.name} 登记（${agentType} 也会读这份），不动它`,
      };
    }
    if (state.state === "disabled") {
      return { file, added: false, why: `${state.why} —— 没有替你打开` };
    }
    if (state.state === "unsure") {
      return { file, added: false, why: `${state.why} —— 看不准就不写，你那几份配置一个字节都没动` };
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
  // **发布前把候选自己再读一遍**(本轮审查 F5):「写进去了」不等于「生效的那条就是它」——
  // 同名容器重复时,生效的是最后一个(`JSON.parse` 语义)。编辑器现在也插在最后那个里,
  // 但前置条件要由这里独立确认一次:读不出来、或者读出来的不是我们这条,一律不写。
  // TOML 那一族同理(见 composeToml 末尾),两族都不许只凭「字节落盘了」报成功。
  const back = readJsonLoose(spliced.body);
  const live = back === null || back === undefined ? undefined : back[container];
  if (!live || typeof live !== "object" || Array.isArray(live) || !Object.hasOwn(live, ASH)) {
    return { why: `${file}：拼出来的配置里，生效的那个 ${container} 容器仍然没有 ash 登记，所以没写` };
  }
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
