// 安装时「这家 CLI 会读哪几份配置、合起来生效的是哪一条」—— 裸 Node 那一份的**读和判**。
//
// 为什么这个仓库里同一条规矩有两份实现:`setup.mjs` 跑在裸 Node 上(npm run setup 时还没
// build 过),导不进 server 那边的 TypeScript。两边各自的分工也一样 ——
// 这个文件 ↔ `server/src/mcp-registry/sources.ts`(站点表 + 来源 + 判定),
// `mcp-hosts.mjs` ↔ `server/src/mcp-registry/register.ts`(拼内容 + 发布事务)。
// `server/scripts/test-ash-mcp-registry.ts` 会把这张表和 `mcp-registry/catalog.ts` 那张
// 逐项比对(路径、环境变量、格式族、加载序、额外目录、启停策略、要不要 enabled/type),
// 对不上就红。

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { readForWrite } from "./config-publish.mjs";
import { readJsonLoose } from "./json-edit.mjs";
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
 *  · `load`      同一个目录里那几个文件名,按**实测的加载序从低到高**(含 `relative`)
 *  · `extraDirs` 默认目录之外、这家也读的固定路径目录(opencode 的 `~/.opencode/`):
 *                排在「指到文件的变量」之上、`altDirEnv` 之下,**只枚举真实存在的**
 *  · `switches`  这家自己的启停策略(根级名单),**逐家声明,别照邻居填**(见 `switchVerdict`)
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
    // 根级两个名单会把一条写得完全正确的登记直接打成 `Blocked`(真 gemini 0.60.0 实测,
    // 依据记在 TS 那张表的注释里)。**键存在就生效**,空数组 = 一个都不放行。
    switches: { off: ["mcp", "excluded"], only: ["mcp", "allowed"] },
  },
  grok: {
    bins: ["grok"], dirEnv: "GROK_HOME", dir: underHome(".grok"),
    relative: ["config.toml"], shape: "toml", enabled: true,
    // 根级这个数组是 grok **专有**的:同格式的 codex 压根不认它(两边实测,本轮审查 F2),
    // 所以它只能挂在这一家身上 —— 这张表里没有 codex(它走 `codex-mcp.mjs` 那条带 CLI 批准
    // 的路),但格式族不许再无条件解释这个键。
    switches: { off: ["disabled_mcp_servers"] },
  },
  kimi: {
    bins: ["kimi"], dirEnv: "KIMI_CODE_HOME", dir: underHome(".kimi-code"),
    relative: ["mcp.json"], shape: "mcpServers",
  },
  opencode: {
    bins: ["opencode"], dirEnv: "OPENCODE_CONFIG", dirEnvIsFile: true, dir: xdgConfig("opencode"),
    relative: ["opencode.json"], shape: "opencode",
    // 同目录三个名字都读,顺序就是实测的加载序;`~/.opencode/` 是另一层全局配置,压过默认
    // 目录和下面那个文件变量(都是真 opencode 1.19.3 逐格实测,依据记在 TS 那张表的 `source`)。
    load: [["config.json"], ["opencode.json"], ["opencode.jsonc"]],
    extraDirs: [underHome(".opencode")],
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
export const ASH = "ash";
export const LEGACY = "harness";

/** 某个配置目录里该写哪一份(`alternates` 存在哪个就用哪个,免得多出一份两边都生效)。 */
function fileInDir(dir, site) {
  // 实测过同目录加载序的家:落点取**存在的那几份里优先级最高的** —— 往更低那份写会被盖掉
  // (真 opencode:`.jsonc` 压 `.json` 压 `config.json`)。跟 TS 的 `ashMcpConfigFile` 同口径。
  if (site.load) {
    const existing = site.load.map((parts) => join(dir, ...parts)).filter((f) => existsSync(f));
    return existing.length ? existing[existing.length - 1] : join(dir, ...site.relative);
  }
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
function filesInDir(dir, site, create = true) {
  // `load` 的顺序就是实测的加载序(升序),落点是其中存在的最高那份 —— 跟 `fileInDir` 同一份
  // 判据,所以 `hostMcpFile` 取最后一个必然跟它一致。`create = false` 给 `extraDirs` 那一层:
  // 只枚举真实存在的,ash 不替用户造第二个全局配置目录。
  if (site.load) {
    const found = site.load.map((parts) => join(dir, ...parts)).filter((f) => existsSync(f));
    if (found.length) return found;
    return create ? [join(dir, ...site.relative)] : [];
  }
  const names = [site.relative, ...(site.alternates || [])];
  const found = names.map((parts) => join(dir, ...parts)).filter((f) => existsSync(f));
  const pick = fileInDir(dir, site);
  if (found.length) return [...found.filter((f) => f !== pick), pick];
  return create ? [pick] : [];
}

/**
 * 这家 CLI 在宿主机上**会读的全部配置**,按优先级**从低到高**。
 *
 * 为什么不是一个文件,以及这个顺序凭什么(真 opencode 1.19.3 逐格实测;TS 那份
 * `ashMcpHostSources` 同模型、同顺序,两边各一份实现是因为 setup 在裸 Node 上跑):
 *  · `OPENCODE_CONFIG` 是「再加一份」不是「取代」—— 全局那份里的 ash 照样生效;
 *  · 默认目录里 `opencode.json` 和 `opencode.jsonc` **两份都读**(上一版「找到第一个就只认
 *    它」,于是 ash 写在 `.json`、目录里又有一份 `.jsonc` 时判成没有,安装器还往 `.jsonc`
 *    里再补一条),而且 **`.jsonc` 压得住 `.json`**(本轮实测);
 *  · `OPENCODE_CONFIG_DIR` 是**再加一个目录**,优先级高于默认目录、**也高于上面那个文件**
 *    (本轮审查 F1 实测:上一版把文件排在它上面,排反了);
 *  · `OPENCODE_CONFIG_CONTENT` 里那整段 JSON 优先级最高、而且**没有文件可写**。
 *
 * `level` 大的优先级高,**相等 = 谁覆盖谁没实测**;实测过加载序的那几家(`sourcesMerge`)
 * 连同一个目录里的几个文件名都各占一级。判「到底有没有」一律走 `effectiveState`:这几份
 * **合起来**CLI 最终看到的是哪一条。
 */
export function hostMcpSources(agentType, { env = process.env, home = homedir() } = {}) {
  const site = HOST_SITES[agentType];
  if (!site) return [];
  const out = [];
  const ordered = site.sourcesMerge === true;
  let next = 0;
  const addDir = (dir, create = true) => {
    const files = filesInDir(dir, site, create);
    files.forEach((file, i) => out.push({ label: file, file, level: next + (ordered ? i : 0) }));
    next += ordered ? Math.max(files.length, 1) : 1;
  };
  // `dirEnv` 指到**目录**时整体取代默认目录;指到**文件**时这一层仍是默认目录(那份全局
  // 配置照样会被读,见上面第一条)。
  const dirOverride = site.dirEnv && !site.dirEnvIsFile ? (env[site.dirEnv] || "").trim() : "";
  addDir(dirOverride || site.dir(env, home));
  // **同一个路径在两个阶段各算一次**(本轮审查 F1-B,跟 TS 的 `ashMcpHostSources` 同口径):
  // 上一版按路径去重、只留第一次出现,于是 `OPENCODE_CONFIG` 指回默认目录那份时,它那一次
  // (最高优先级的)加载被整个删掉 —— 实测真 CLI 会再读一遍、结论相反。
  const file = site.dirEnvIsFile && site.dirEnv ? (env[site.dirEnv] || "").trim() : "";
  if (file) {
    // **相对路径按 CLI 自己的工作目录解**(实测,见 TS 那边 `ashMcpHostSources` 的说明)。
    // 安装器压根不知道那个目录(它跑在用户的 shell 里、CLI 之后在任务目录里跑),所以这份
    // 来源**证不出来**:既不当「不存在」也不当落点 —— 整体答看不准、一个字节都不写。
    if (isAbsolute(file)) out.push({ label: file, file, level: next++ });
    else {
      out.push({
        label: `$${site.dirEnv}=${file}`,
        file: null,
        unprovable: `$${site.dirEnv} 给的是相对路径 ${file}，它按 ${agentType} 自己的工作目录解 ——`
          + " 安装器这边算不出它指的是哪一份",
        level: next++,
      });
    }
  }
  // 默认目录之外那几个固定路径目录(opencode 的 `~/.opencode/`):**比上面那个文件高、
  // 比下面那个目录低**(实测)。只枚举真实存在的那几份。
  for (const extra of site.extraDirs || []) addDir(extra(env, home), false);
  const altDir = site.altDirEnv ? (env[site.altDirEnv] || "").trim() : "";
  if (altDir) addDir(altDir);
  const inline = site.contentEnv ? (env[site.contentEnv] || "").trim() : "";
  if (inline) out.push({ label: `$${site.contentEnv}`, file: null, text: inline, level: next++ });
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
 * 这家 CLI 的**别处开关**对这个名字怎么说 —— 跟 TS 的 `switchVerdict` 同口径(理由写在那边,
 * 别只改一侧):`{ off }` = 它明确挡住了(说清是哪一行在挡);`{ doubt }` = 那种写法没实测过;
 * null = 没挡。键路径按根级算,TOML 那族只有一层。
 */
function switchVerdict(doc, switches, name) {
  if (!switches) return null;
  const at = (path) => {
    let cur = doc;
    for (const key of path) {
      if (!cur || typeof cur !== "object" || Array.isArray(cur) || !Object.hasOwn(cur, key)) return null;
      cur = cur[key];
    }
    return { value: cur };
  };
  const show = (path) => path.join(".");
  const list = (path) => {
    const found = at(path);
    if (!found) return null;
    if (!Array.isArray(found.value)) {
      return { doubt: `根级 ${show(path)} 不是一个数组 —— 这家 CLI 拿它怎么判 ash 没实测过` };
    }
    return found.value.map(String);
  };
  if (switches.off) {
    const names = list(switches.off);
    if (names && !Array.isArray(names)) return names;
    if (names && names.includes(name)) {
      return { off: `${name} 被根级 ${show(switches.off)} 挡住了（这家 CLI 会把它判成不可用）` };
    }
  }
  if (switches.only) {
    // **键存在就生效**:空数组实测是「全挡」(真 gemini 0.60.0),不是「没配」。
    const names = list(switches.only);
    if (names && !Array.isArray(names)) return names;
    if (names && !names.includes(name)) {
      return {
        off: `根级 ${show(switches.only)} 是个白名单、里面没有 ${name}`
          + `（${names.length ? `只放行 ${names.join("、")}` : "空数组 = 一个都不放行"}）`,
      };
    }
  }
  return null;
}

/** `mcpServers` 那一族的逐条判据(跟 TS 的 `mcpServersFact` 同口径,**没有**跨来源合并)。 */
const mcpServersFact = (name, entry) => switchedOff(entry)
  ? { status: "off", detail: `${name} 这条登记是关着的`, raw: entry }
  : { status: "on", detail: "", raw: entry };

/**
 * opencode 这一族的逐条判据 —— 四档全是真 opencode 1.19.3 实测的,跟 TS 的 `opencodeFact`
 * 同口径(理由写在那边,别只改一侧):没写 `type` 就不是一条服务登记、只是个开关;连
 * `enabled` 都没写真 CLI 会整份拒载;`enabled` 不写 = 开着;**`disabled: true` 这个键
 * opencode 不认**(实测照样去连),所以既不当关着也不当没写,如实答看不准。
 */
const opencodeFact = (name, entry) => {
  if (!Object.hasOwn(entry, "type")) {
    if (!Object.hasOwn(entry, "enabled")) {
      return {
        status: "doubt",
        detail: `${name} 这条登记既没写 type 也没写 enabled —— opencode 会把整份配置判成非法、直接起不来`,
      };
    }
    return {
      status: "doubt",
      detail: `${name} 这条登记只写了开关、没写启动方式（没有 type）—— opencode 不把它当成一个服务`,
      // **只贡献这一个键**(本轮审查 F1-A,跟 TS 的 `opencodeFact` 同口径):走开关那一支时
      // 它同时写的 `command` / `environment` 真 CLI 一律丢掉,留着会在搬运时复活。
      raw: { enabled: entry.enabled },
    };
  }
  if (entry.enabled === false) return { status: "off", detail: `${name} 这条登记是关着的`, raw: entry };
  if (entry.disabled === true) {
    return {
      status: "doubt",
      detail: `${name} 这条登记写着 disabled: true —— opencode 实测不认这个键（照样会去连它），`
        + "而这一族里别的 CLI 认不认没实测过",
      raw: entry,
    };
  }
  return { status: "on", detail: "", raw: entry };
};

/** 逐字段深合并:对象按键往下合,其余(标量、数组)整条替换 —— 真 opencode 实测的口径。 */
function deepMergeRaw(lower, higher) {
  const out = { ...lower };
  const plain = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);
  for (const [key, value] of Object.entries(higher)) {
    const a = plain(out[key]);
    const b = plain(value);
    out[key] = a && b ? deepMergeRaw(a, b) : value;
  }
  return out;
}

/**
 * 这家 CLI 的几份来源**怎么合**。null = 不合(格式族没有实测依据,或这家 CLI 本身没实测过
 * 会不会合)—— 那时 `effectiveState` 走老判据:最高那层说了算、同层不一致就看不准。
 *
 * 合完**必须重新判状态**(上一轮审查 F1):状态和启动方式都只能从合完那份原值上算。
 * **两边一视同仁**:每份来源的 `raw` 在 `opencodeFact` 里已经投影成「这份来源真正贡献的
 * 字段」,所以这里直接深合 —— 上一版只过滤高的那份、最低那份原值照抄(本轮审查 F1-A)。
 */
function mergeFactsFor(site) {
  if (!site.sourcesMerge || site.shape !== "opencode") return null;
  return (name, lower, higher) => {
    if (!lower.raw) return lower;
    if (!higher.raw) return higher;
    return opencodeFact(name, deepMergeRaw(lower.raw, higher.raw));
  };
}

/** 认的那两个服务名 —— **两条独立登记**,顺序就是优先。跟 TS 那份 `ASH_MCP_NAMES` 同口径。 */
const NAMES = [ASH, LEGACY];

/**
 * 一份来源扫出来的**逐名事实**:`{ doubt?, missing?, names: Map<名, { status, detail }> }`,
 * status 是 `on` / `off` / `doubt`(写法认不出来)。
 *
 * 刻意**不折叠**,跟 TS 那份 `shapes.ts` 的 `scan` 一一对应:`ash` 和 `harness` 是两条独立
 * 登记,先压成一个四态结论就会把两个名字的事实混成一个(本轮审查 F3)。值认不出来(不是
 * 对象)一律 doubt —— 当没有去写就会把用户那个键覆盖掉,跟「已有登记一律不覆盖」自相矛盾。
 */
function scanSource(source, site) {
  const names = new Map();
  let text;
  // 证不出来的那一档(相对路径没带工作目录):看不准,别当成「没有」。
  if (source.unprovable) return { doubt: source.unprovable, names };
  if (source.file) {
    const read = readForWrite(source.file);
    if (!read) return { doubt: "读不出来", names };
    if (read.text === null) return { missing: true, names };
    text = read.text;
  } else {
    text = source.text || "";
  }
  if (site.shape === "toml") {
    const scan = scanTomlServers(text);
    if (scan.why) return { doubt: scan.why, names };
    // 根级那个数组**只在声明了它的那家才算**(grok 认、codex 不认,两边实测:本轮审查 F2)。
    const rootKey = site.switches?.off?.length === 1 ? site.switches.off[0] : null;
    const rootOff = rootKey ? scan.rootArrays[rootKey] || [] : [];
    for (const name of NAMES) {
      if (!scan.names.includes(name)) continue;
      names.set(name, rootOff.includes(name)
        ? { status: "off", detail: `[mcp_servers.${name}] 被根级 ${rootKey} 关掉了` }
        : { status: "on", detail: "" });
    }
    return { names };
  }
  const doc = readJsonLoose(text);
  if (doc === undefined) return { doubt: "解析不了", names };
  const servers = doc === null ? undefined : doc[site.shape === "opencode" ? "mcp" : "mcpServers"];
  if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) {
    return { doubt: "登记容器不是对象", names };
  }
  const factOf = site.shape === "opencode" ? opencodeFact : mcpServersFact;
  for (const name of NAMES) {
    const raw = servers ? servers[name] : undefined;
    if (raw === undefined) {
      // **这家明确挡住这个名字时,压根没登记也要如实说**(本轮审查 F2,跟 TS 的 `scanJson`
      // 同口径):补一条进去也是条用不上的登记,而用户看到的是「已接好」。没登记的名字里
      // **只问规范名** —— 历史名没在白名单里是常态,拿它说「被关掉了」会误判整份配置。
      if (name !== ASH) continue;
      const blocked = switchVerdict(doc, site.switches, name);
      if (blocked && blocked.off) names.set(name, { status: "off", detail: blocked.off });
      else if (blocked) names.set(name, { status: "doubt", detail: blocked.doubt });
      continue;
    }
    // 值不是对象 ⇒ doubt,而且**不带 raw**:那种写法合不动,跨来源合并时只能继续 doubt。
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      names.set(name, { status: "doubt", detail: `${name} 这条登记不是一个对象` });
      continue;
    }
    const fact = factOf(name, raw);
    // 这家自己的别处开关**压在条目之上**(本轮审查 F2),`raw` 照样留着(合并要的是贡献)。
    const switched = switchVerdict(doc, site.switches, name);
    if (switched && switched.off) {
      names.set(name, { status: "off", detail: switched.off, ...(fact.raw ? { raw: fact.raw } : {}) });
      continue;
    }
    if (switched) {
      names.set(name, { status: "doubt", detail: switched.doubt, ...(fact.raw ? { raw: fact.raw } : {}) });
      continue;
    }
    names.set(name, fact);
  }
  return { names };
}

/** 这一份里**选中**的那条登记:先找开着的那条(整份只有这一处在选,跟 TS 的 `pickFact` 同口径)。 */
function pickFact(scan) {
  for (const name of NAMES) {
    const fact = scan.names.get(name);
    if (fact && fact.status === "on") return { name, fact };
  }
  return null;
}

/** 一份扫描结果折叠成四态(跟 TS 的 `foldScan` 同口径;`label` 是这份来源的名字)。 */
function foldScan(scan, label) {
  const say = (d) => `${label}：${d}`;
  if (scan.doubt) return { state: "unsure", why: say(scan.doubt), label };
  const live = pickFact(scan);
  if (live) return { state: "present", name: live.name, label };
  const facts = [...scan.names.entries()];
  const doubts = facts.filter(([, f]) => f.status === "doubt");
  if (doubts.length) return { state: "unsure", why: doubts.map(([, f]) => say(f.detail)).join("；"), label };
  const off = facts.filter(([, f]) => f.status === "off");
  if (off.length) {
    return { state: "disabled", name: off[0][0], why: off.map(([, f]) => say(f.detail)).join("、"), label };
  }
  return { state: "absent", label };
}

/**
 * 几份来源合起来,这家 CLI **最终看到的**是哪一条登记 —— 跟 TS 那份 `resolveAshMcp` 同一套
 * 判据:实测过合并语义的那几家走**逐字段合并**,状态从合完那份原值上重算(本轮审查 F1)。
 * 上一版是「声明了这个名字的来源里,优先级最高的那份说了算」,而真 opencode 实测里那三种
 * 形状都错:低的那份写完整登记、高的那份只写 `{"enabled": true}` 时真 CLI 连得上;来源层级
 * 本身排反了;同层两份都开着时真 CLI 用的是后面那份。没实测过的家仍走老判据。
 *
 * **逐个兼容名各算一次**(上一轮审查 F3):更早一版先把每份来源压成一个四态、再按优先级选
 * 赢家,于是「高优先级那份里 `ash` 关着、低优先级那份里 `harness` 开着」被判成关着,而真 CLI
 * 那边工具明明连得上 —— 安装器据此报「被关掉了,没有替你打开」,用户照着去翻一个其实没问题
 * 的配置。
 *
 * 四处一律回 unsure(看不准就不写):这家的合并语义本身没实测(`sourcesMerge` 不为真)而几份
 * 结论不一致;**同一层**里同一个名字有两份不一致的写法;合完那条自己就认不出来;有一份整份
 * 读不准、而且优先级不低于那条生效的登记(它可能正把那条关掉)。
 */
export function effectiveState(sources, site) {
  if (!sources.length) return { state: "unsure", why: "算不出这家 CLI 会读哪几份配置" };
  const read = sources.map((source) => ({ source, scan: scanSource(source, site) }));
  const folded = read.map((r) => foldScan(r.scan, r.source.label));
  const merge = mergeFactsFor(site);
  if (read.length > 1 && !site.sourcesMerge && new Set(folded.map((f) => f.state)).size > 1) {
    return {
      state: "unsure",
      why: "这家 CLI 会读好几份配置，而它们的结论不一致、合并规则 ash 没实测过："
        + folded.map((f) => f.why || `${f.label}：${f.state === "present" ? "里已经有 ash 登记" : f.state}`).join("；"),
    };
  }
  const picks = [];
  for (const name of NAMES) {
    // `read` 是升序的(见 `hostMcpSources`),所以这几份本身就是加载序。
    const declared = read.filter((r) => r.scan.names.has(name));
    if (!declared.length) continue;
    if (merge) {
      const fact = declared
        .map((r) => r.scan.names.get(name))
        .reduce((lower, higher) => merge(name, lower, higher));
      const source = declared[declared.length - 1].source;
      const at = declared.length > 1 ? declared.map((r) => r.source.label).join(" + ") : source.label;
      if (fact.status === "doubt") picks.push({ why: `${at}：${fact.detail}` });
      else picks.push({ name, fact, source });
      continue;
    }
    const top = Math.max(...declared.map((r) => r.source.level));
    const winners = declared
      .filter((r) => r.source.level === top)
      .map((r) => ({ name, fact: r.scan.names.get(name), source: r.source }));
    const unsure = winners.find((w) => w.fact.status === "doubt");
    if (unsure) {
      picks.push({ why: `${unsure.source.label}：${unsure.fact.detail}` });
      continue;
    }
    if (new Set(winners.map((w) => w.fact.status)).size > 1) {
      picks.push({
        why: `同一层里好几份配置都写了 ${name} 这条登记、结论还不一致、谁覆盖谁 ash 没实测过（`
          + winners.map((w) => `${w.source.label}：${w.fact.status === "on" ? "开着" : "关着"}`).join("；") + "）",
      });
      continue;
    }
    // 同层、状态一致 ⇒ 取**写入落点那一份**(`filesInDir` 把它排在最后),跟 `hostMcpFile`
    // 指的是同一份,不会出现「说的是 a、写的是 b」。
    picks.push(winners[winners.length - 1]);
  }
  const live = picks.find((p) => p.fact && p.fact.status === "on");
  // 整份读不准的那些 —— **一份都不许放过**(本轮审查 F1-C,跟 TS 的 `resolveAshMcp` 同口径):
  // 实测真 opencode 读到任何一份读不通的配置就整份拒载(不管它在哪一层、有没有提到 ash),
  // 那时压根没有「生效的登记」可言。上一版只拦「优先级不低于生效那条」的,于是低层一份坏
  // 文件 + 高层一条完整登记会被答成 present、安装器还说「已经有生效的 ash 登记」。
  const blind = read.filter((r) => r.scan.doubt);
  const blindWhy = (over) => [...new Set(
    over.map((b) => foldScan(b.scan, b.source.label).why))].join("；");
  if (blind.length) {
    // 两种「看不准」分开说(跟 TS 同口径):**读不通**那种会让真 CLI 整份拒载,**证不出来**
    // 那种只是算不出它指的是哪一份 —— 混成一句会让用户去修一份其实好着的文件。
    const broken = blind.filter((b) => !b.source.unprovable);
    const vague = blind.filter((b) => b.source.unprovable);
    const why = [
      broken.length
        ? `${blindWhy(broken)} —— 这家 CLI 会读的配置里有读不准的那一份：它可能正把别处那条`
          + "登记关掉，也可能让这家 CLI 整份配置一起拒载（真 opencode 实测：任何一份读不通就起不来）"
        : "",
      vague.length ? `${blindWhy(vague)} —— 所以「别处都没有」这句也证不出来` : "",
    ].filter(Boolean).join("；");
    return { state: "unsure", why: live ? `${live.source.label} 里有生效的 ${live.name} 登记，但 ${why}` : why };
  }
  if (live) return { state: "present", name: live.name, label: live.source.label };
  const unsure = picks.filter((p) => p.why);
  if (unsure.length) return { state: "unsure", why: unsure.map((u) => u.why).join("；") };
  const off = picks.filter((p) => p.fact);
  if (off.length) {
    return {
      state: "disabled",
      name: off[0].name,
      why: off.map((o) => `${o.source.label}：${o.fact.detail}`).join("、"),
      label: off[0].source.label,
    };
  }
  // 一个名字都没声明 ⇒ 确实没有。措辞用**最后那份**(优先级最高的那份,也是写入落点)。
  return folded[folded.length - 1];
}
