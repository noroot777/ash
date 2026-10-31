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
function filesInDir(dir, site) {
  const names = [site.relative, ...(site.alternates || [])];
  const found = names.map((parts) => join(dir, ...parts)).filter((f) => existsSync(f));
  const pick = fileInDir(dir, site);
  return found.length ? [...found.filter((f) => f !== pick), pick] : [pick];
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
  const addDir = (dir) => {
    const files = filesInDir(dir, site);
    files.forEach((file, i) => out.push({ label: file, file, level: next + (ordered ? i : 0) }));
    next += ordered ? files.length : 1;
  };
  // `dirEnv` 指到**目录**时整体取代默认目录;指到**文件**时这一层仍是默认目录(那份全局
  // 配置照样会被读,见上面第一条)。
  const dirOverride = site.dirEnv && !site.dirEnvIsFile ? (env[site.dirEnv] || "").trim() : "";
  addDir(dirOverride || site.dir(env, home));
  // **同一个路径在两个阶段各算一次**(本轮审查 F1-B,跟 TS 的 `ashMcpHostSources` 同口径):
  // 上一版按路径去重、只留第一次出现,于是 `OPENCODE_CONFIG` 指回默认目录那份时,它那一次
  // (最高优先级的)加载被整个删掉 —— 实测真 CLI 会再读一遍、结论相反。
  const file = site.dirEnvIsFile && site.dirEnv ? (env[site.dirEnv] || "").trim() : "";
  if (file) out.push({ label: file, file, level: next++ });
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
    for (const name of NAMES) {
      if (!scan.names.includes(name)) continue;
      names.set(name, scan.disabled.includes(name)
        ? { status: "off", detail: `[mcp_servers.${name}] 被 disabled_mcp_servers 关掉了` }
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
    if (raw === undefined) continue;
    // 值不是对象 ⇒ doubt,而且**不带 raw**:那种写法合不动,跨来源合并时只能继续 doubt。
    names.set(name, !raw || typeof raw !== "object" || Array.isArray(raw)
      ? { status: "doubt", detail: `${name} 这条登记不是一个对象` }
      : factOf(name, raw));
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
function effectiveState(sources, site) {
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
    const why = `${blindWhy(blind)} —— 这家 CLI 会读的配置里有读不准的那一份：它可能正把别处`
      + "那条登记关掉，也可能让这家 CLI 整份配置一起拒载（真 opencode 实测：任何一份读不通就起不来）";
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
