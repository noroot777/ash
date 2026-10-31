// 三个格式族的读 / 拼实现 —— 十五家 CLI 的 MCP 登记只有这三种写法。
//
// 刻意都是**纯函数**(配置全文进、结论或新全文出):读写事务在 `auth/config-publish.ts`,
// 那里才有「确认读到过 → 就地写 → 读回来比对」那一套文件身份保全。格式族碰不到文件系统,
// 所以新接一家 CLI 不可能漏掉那几条规矩。
//
// 共同的两条判据(三族一致,别在某一族悄悄放宽):
//  ① **已有登记一律不覆盖**,含历史名 `harness` —— 用户可能自己改过路径或 URL;
//  ② **「读不出来」绝不当成「没有」**:解析失败、写法超出认得的范围一律 unknown,
//     因为 absent 是个会被用来拦人的结论(`ash-mcp-reachability.ts` 的「向放行开」)。
import { ASH_MCP_SERVER_NAME, LEGACY_ASH_MCP_SERVER_NAME } from "@ash/shared/mcp";
import { extractTomlTables, scanCodexToml, tomlRootStringArray } from "../codex-toml.js";
import { readJsonLoose, spliceJsonMember } from "./json-edit.js";
import type {
  AshMcpCompose, AshMcpComposeOpts, AshMcpConfigState, AshMcpEntry, AshMcpLaunch, AshMcpNameFact,
  AshMcpNameScan, AshMcpShape,
} from "./types.js";

/** 认的那两个服务名(`ash` 和历史名 `harness`)—— **两条独立登记**,顺序就是优先。 */
export const ASH_MCP_NAMES = [ASH_MCP_SERVER_NAME, LEGACY_ASH_MCP_SERVER_NAME];

const WANTED = ASH_MCP_NAMES;

const present = (serverName: string): AshMcpConfigState => ({ state: "present", serverName, detail: "" });
const absent = (detail: string): AshMcpConfigState => ({ state: "absent", serverName: null, detail });
const unknown = (detail: string): AshMcpConfigState => ({ state: "unknown", serverName: null, detail });

// ── JSON 两族共用的小工具 ──────────────────────────────────────────────────

/**
 * `null` = 确认没有这个文件或内容是空白(当空文档,我们来建);`undefined` = 解析不了
 * (**别动它**)。注释和尾逗号都容得下,见 `json-edit.ts`。
 */
const parseDoc = (text: string | null): Record<string, unknown> | null | undefined =>
  readJsonLoose(text);

const asObject = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** 这条登记有没有被显式关掉。两种写法都认(`disabled: true` / `enabled: false`)。 */
const switchedOff = (entry: Record<string, unknown>): boolean =>
  entry.disabled === true || entry.enabled === false;

/** 这个键能不能写(已有的一律不覆盖,含**认不出来**的值 —— 见 `scanJson` 的 doubt 那一档)。 */
function takenNames(container: unknown): string[] {
  const servers = asObject(container);
  return servers ? WANTED.filter((n) => Object.hasOwn(servers, n)) : [];
}

const doubtScan = (doubt: string): AshMcpNameScan => ({ doubt, names: new Map() });
const noConfig = (): AshMcpNameScan => ({ missing: true, names: new Map() });

/**
 * 这一份配置里**选中**的那条登记 —— 整个格式族层**只有这一处**在做这个选择。
 *
 * 两个兼容名是两条独立登记,所以**先找开着的那条**:`ash` 关着、`harness` 开着时 CLI 那边
 * ash MCP 是能用的。本轮审查 F3 的病根就是各处自己选一遍:`hostBlock` 固定先挑 `ash`、
 * `read` 挑开着的那条,于是搬过去的是那条关着的;更早一版 `launch` 按名字取第一条,提示里
 * 给的是一个根本没在跑的命令,而 `read` 明明已经放行了。
 */
export function pickFact(scan: AshMcpNameScan): { name: string; fact: AshMcpNameFact } | null {
  for (const name of WANTED) {
    const fact = scan.names.get(name);
    if (fact?.status === "on") return { name, fact };
  }
  return null;
}

/**
 * 一份扫描结果折叠成四态。`at` = 这份来源的名字(有就当前缀 —— 几份配置一起看时,用户得
 * 知道说的是哪一份)。
 *
 * 顺序刻意是「开着的 > 认不出来 > 关着的 > 没有」:开着的那条一旦找到,另一个名字写成什么样
 * 都不改变「ash MCP 能用」这个事实(认不出来的那条照样不许覆盖,那道闸在 `takenNames`)。
 */
export function foldScan(scan: AshMcpNameScan, at = ""): AshMcpConfigState {
  const say = (d: string) => (at ? `${at}：${d}` : d);
  if (scan.doubt) return unknown(say(scan.doubt));
  const live = pickFact(scan);
  if (live) return present(live.name);
  const facts = [...scan.names];
  const doubts = facts.filter(([, f]) => f.status === "doubt");
  if (doubts.length) return unknown(say(doubts.map(([, f]) => f.detail).join("；")));
  const off = facts.filter(([, f]) => f.status === "off");
  if (off.length) {
    return { state: "disabled", serverName: off[0]![0], detail: say(off.map(([, f]) => f.detail).join("、")) };
  }
  return absent(say(scan.missing ? "配置文件还不存在" : "没有 ash MCP 登记"));
}

/**
 * 读那一侧的**全部**实现:四个动作都是 `scan` 折一下或投影一下。
 *
 * 为什么非得这样收(本轮审查 F3):`read`/`hostRaw`/`hostBlock`/`launch` 原先各自走一遍
 * 「在容器里找 ash」,四处判据就有四种漂法。现在族里只实现 `scan`,「选中哪条」只有
 * `pickFact` 一处。
 */
function readSide(
  scan: (text: string | null) => AshMcpNameScan,
): Pick<AshMcpShape, "scan" | "read" | "hostRaw" | "hostBlock" | "launch"> {
  const pick = (text: string | null) => pickFact(scan(text));
  return {
    scan,
    read: (text) => foldScan(scan(text)),
    hostRaw: (text) => pick(text)?.fact.raw ?? null,
    hostBlock: (text) => pick(text)?.fact.block ?? null,
    launch: (text) => pick(text)?.fact.launch ?? null,
  };
}

/**
 * JSON 两族的逐名扫描。族间只差两件事,所以都做成参数:登记容器叫什么、启动方式怎么读
 * (`env` + 字符串命令 vs `environment` + 整条 argv)。
 *
 * **值不是对象一律 doubt**:`"ash": null`、`"ash": "node x.js"` 这种写法我们认不出来,
 * 当没有去写就会把用户那个键覆盖掉,跟「已有登记一律不覆盖」自相矛盾。
 */
function scanJson(
  container: string,
  text: string | null,
  launchOf: (entry: Record<string, unknown>) => AshMcpLaunch,
): AshMcpNameScan {
  const doc = parseDoc(text);
  if (doc === undefined) return doubtScan("配置解析不了（它可能正被 CLI 写到一半，也可能被手工改坏了）");
  if (doc === null) return noConfig();
  const servers = asObject(doc[container]);
  if (doc[container] !== undefined && !servers) return doubtScan("里的登记容器不是一个对象");
  const names = new Map<string, AshMcpNameFact>();
  for (const name of WANTED) {
    const raw = servers ? servers[name] : undefined;
    if (raw === undefined) continue;
    const entry = asObject(raw);
    if (!entry) {
      names.set(name, { status: "doubt", detail: `${name} 这条登记不是一个对象（值是 ${typeof raw}）` });
      continue;
    }
    names.set(name, switchedOff(entry)
      ? { status: "off", detail: `${name} 这条登记是关着的`, raw: entry }
      : { status: "on", detail: "", raw: entry, launch: launchOf(entry) });
  }
  return { names };
}

/**
 * 把一条登记按规范名写进容器 —— JSON 两族**只有这一处会改文档**。
 *
 * 规范名落地:宿主那份即使叫历史名 harness,搬过来也按 ash 登记(两边都叫 ash 之后,提示词
 * 里那句「ash MCP」才对得上工具名)。已有同名键一律不碰(含值认不出来的那种,见 `scanJson`):调用方本该先 `read` 过,这里是第二道闸,因为「覆盖用户已有登记」是不可逆的。
 */
function putJson(
  shape: AshMcpShape,
  container: string,
  text: string | null,
  value: Record<string, unknown>,
): AshMcpCompose {
  const doc = parseDoc(text);
  if (doc === undefined) return { why: "配置解析不了，没敢动它 —— 手工修好或删掉它再重启" };
  const taken = takenNames((doc ?? {})[container]);
  if (taken.length) return { why: `配置里已经有 ${taken.join(" / ")} 这条登记了，没有覆盖它` };
  // **文本插入,不重新序列化**(本轮审查 R4):大整数、`1e999`、`-0`、重复键、注释、键序、
  // 缩进全部按字节留着。上一版走 `JSON.parse` → `JSON.stringify` 往返,那条路会悄悄改掉用户
  // 保存的值(`9007199254740993` → `…992`),而回读只看 ash 在不在、看不出这种损失。
  // 顺带:注释不再会被抹掉,所以带注释的 `.jsonc` 也能自动补接了。
  const spliced = spliceJsonMember(text, container, ASH_MCP_SERVER_NAME, value);
  if (!spliced.body) return { why: spliced.why ?? "没能把那条登记插进去" };
  const body = spliced.body;
  // 自己复核一遍:这一族的「真解析器」就在手上(语义全在 JSON 语法里),所以拼完能当场验。
  const back = shape.read(body);
  if (back.state !== "present") return { why: `补上那条之后仍读不出 ash MCP 登记（${back.detail}）` };
  return { body };
}

// ── ① `mcpServers` 这一族(claude / gemini / kimi / cursor / qwen / copilot / kiro / qoder / antigravity)──
//
// 同一个形状:顶层 `mcpServers` 对象,每条 `{ command, args, env }`。本轮在 gemini 上
// 用真 CLI 验过一遍(`gemini mcp add ash node <entry> -s user -e ASH_URL=…` 写出来的
// 就是这个形状),其余几家按各自官方文档(出处记在 `catalog.ts` 的 `source`)。

const CONTAINER = "mcpServers";

/** 这一族的启动方式:`command` 是字符串、`args` 另给、环境变量的键叫 `env`。 */
function mcpServersLaunch(entry: Record<string, unknown>): AshMcpLaunch {
  const env = asObject(entry.env) ?? {};
  return {
    command: typeof entry.command === "string" ? entry.command : null,
    args: entry.args,
    ashUrl: typeof env.ASH_URL === "string" ? env.ASH_URL : null,
  };
}

export const mcpServersJsonShape: AshMcpShape = {
  id: "mcp-servers-json",
  ...readSide((text) => scanJson(CONTAINER, text, mcpServersLaunch)),
  compose(text, entry, opts) {
    const value = opts?.type ? { type: opts.type, ...entry } : { ...entry };
    return putJson(mcpServersJsonShape, CONTAINER, text, value);
  },
  composeRaw(text, value) {
    return putJson(mcpServersJsonShape, CONTAINER, text, value);
  },
};

// ── ② opencode 这一族(opencode / kilo)────────────────────────────────────
//
// 顶层叫 `mcp`,一条登记长这样(本轮用真 opencode v…… 实测 `opencode mcp list` 读得出):
//   "ash": { "type": "local", "command": ["node", "<entry>"], "environment": {…}, "enabled": true }
// 注意 `command` 是**整条 argv 的数组**、环境变量的键叫 `environment` —— 跟上一族不是
// 同一个形状,所以单列一族,别拿 `mcpServers` 那份硬套。

const OPENCODE_CONTAINER = "mcp";

const opencodeEntry = (entry: AshMcpEntry) => ({
  type: "local",
  command: [entry.command, ...entry.args],
  environment: { ...entry.env },
  enabled: true,
});

/** 这一族的启动方式:`command` 是**整条 argv 的数组**、环境变量的键叫 `environment`。 */
function opencodeLaunch(entry: Record<string, unknown>): AshMcpLaunch {
  const argv = Array.isArray(entry.command) ? entry.command.map(String) : [];
  const env = asObject(entry.environment) ?? {};
  return {
    command: argv[0] ?? null,
    args: argv.slice(1),
    ashUrl: typeof env.ASH_URL === "string" ? env.ASH_URL : null,
  };
}

export const opencodeJsonShape: AshMcpShape = {
  id: "opencode-json",
  ...readSide((text) => scanJson(OPENCODE_CONTAINER, text, opencodeLaunch)),
  compose(text, entry) {
    return putJson(opencodeJsonShape, OPENCODE_CONTAINER, text, opencodeEntry(entry));
  },
  composeRaw(text, value) {
    return putJson(opencodeJsonShape, OPENCODE_CONTAINER, text, value);
  },
};

// ── ③ TOML 这一族(codex / grok)────────────────────────────────────────────
//
// `[mcp_servers.<名>]` + `[mcp_servers.<名>.env]`。grok 本轮实测写出来的跟 codex 一模一样
// (多一行 `enabled = true`),所以判据直接共用 codex 那份**结构**扫描器 —— 不再写第二份
// 正则:`[mcp_servers."ash"]`、缩进表头、点号键、内联表都认,它自己没把握时答 unknown。

/**
 * grok 还有一个根级开关 `disabled_mcp_servers = ["ash"]`(实测 `grok mcp disable ash` 会
 * 同时写它和 `enabled = false`)。
 *
 * 判据走 `codex-toml.ts` 的结构扫描器(**本轮审查 R7**:上一版拿全文正则扫,别人多行字符串
 * 里的同名行会被当成根级事实,把一条启用着的 ash 判成「已关闭」—— 而 disabled 在预检里是
 * 硬拒)。读不通或根级没这个键一律当「没关」:这个方向上的错最多是放过一轮(跑完没结论、
 * 有说明),反过来是当场拦掉一轮本来跑得起来的审查。
 */
function tomlRootDisabled(text: string, name: string): boolean {
  return tomlRootStringArray(text, "disabled_mcp_servers")?.includes(name) === true;
}


/**
 * 把一段 `[mcp_servers.…]` 原文接到配置末尾。**只在扫描器确定「没有」时才接**。
 *
 * 判据跟读那一侧(`read`)问同一个扫描器:判错成「没有」就会再追加一份同名表,那在 TOML
 * 里是重复定义,CLI 整份配置都读不出来(连用户别的 MCP 一起没了)。
 */
function appendToml(text: string | null, block: string): AshMcpCompose {
  const current = text ?? "";
  const scan = scanCodexToml(current);
  if (scan.doubt) {
    return { why: `看不准配置里有没有 ash MCP 登记（${scan.doubt}），没有自动追加，免得写出重复的表` };
  }
  // 整张表写成内联值之后 TOML 不许再用表头扩展 —— 照写进去 CLI 整份拒载(codex 真机实测)。
  if (scan.sealed) {
    return {
      why: `配置里 ${scan.sealed}，所以没有自动补写 —— 请在那个内联表里自己加一条 `
        + `${ASH_MCP_SERVER_NAME}，或者把它改写成 [mcp_servers.xxx] 的普通表写法再重启`,
    };
  }
  const body = current.trim() ? `${current.trimEnd()}\n\n${block}\n` : `${block}\n`;
  // 自己这道只是**预筛**:TOML 的判官住在 CLI 进程里(codex 那条路会再问它本人,
  // 见 `auth/codex-approve.ts`)。
  const back = scanCodexToml(body);
  if (back.doubt) return { why: `补上那段之后配置自己都读不通了（${back.doubt}）` };
  if (!back.servers.get(ASH_MCP_SERVER_NAME)?.enabled) {
    return { why: `补上那段之后仍读不出启用着的 [mcp_servers.${ASH_MCP_SERVER_NAME}]` };
  }
  return { body };
}

/**
 * TOML 的逐名扫描。判据走 `codex-toml.ts` 的结构扫描器(它只认那两个兼容名),**两种关法
 * 都看**:条目上的 `enabled = false` 和根级 `disabled_mcp_servers`。
 *
 * `block` 顺手在这里取好(表头改成规范名):搬宿主那条时整段原文照搬,连底下的子表一起 ——
 * 上一版 `hostBlock` 自己又按名字固定先挑 `ash`,跟这里挑**开着**那条的判据不是一套
 * (本轮审查 F3)。
 */
function scanToml(text: string | null): AshMcpNameScan {
  if (text === null) return noConfig();
  const found = scanCodexToml(text);
  if (found.doubt) return doubtScan(found.doubt);
  const names = new Map<string, AshMcpNameFact>();
  for (const name of WANTED) {
    const one = found.servers.get(name);
    if (!one) continue;
    const block = extractTomlTables(text, name, ASH_MCP_SERVER_NAME) ?? undefined;
    if (one.enabled && !tomlRootDisabled(text, name)) {
      names.set(name, { status: "on", detail: "", block, launch: one.spec });
      continue;
    }
    // 关法有两种,说清是哪一种:用户要照着去改的就是那一行(只说「关着的」等于让他自己去翻)。
    names.set(name, {
      status: "off",
      detail: one.enabled
        ? `[mcp_servers.${name}] 被 disabled_mcp_servers 关掉了`
        : `[mcp_servers.${name}] 写着 enabled = false`,
      block,
    });
  }
  return { names };
}

export const mcpServersTomlShape: AshMcpShape = {
  id: "mcp-servers-toml",
  ...readSide(scanToml),
  compose(text, entry, opts) {
    return appendToml(text, tomlBlock(entry, opts?.enabled === true));
  },
  blockFor: (entry, opts) => tomlBlock(entry, opts?.enabled === true),
  appendBlock: appendToml,
};

/** 一条 ash 登记的 TOML 原文。路径一律走 `JSON.stringify` —— Windows 的 `\` 必须成对写。 */
export function tomlBlock(entry: AshMcpEntry, enabled: boolean): string {
  const head = `[mcp_servers.${ASH_MCP_SERVER_NAME}]`;
  const lines = [
    head,
    `command = ${JSON.stringify(entry.command)}`,
    `args = [${entry.args.map((a) => JSON.stringify(a)).join(", ")}]`,
  ];
  if (enabled) lines.push("enabled = true");
  const env = Object.entries(entry.env);
  if (env.length) {
    lines.push("", `[mcp_servers.${ASH_MCP_SERVER_NAME}.env]`);
    for (const [k, v] of env) lines.push(`${k} = ${JSON.stringify(v)}`);
  }
  return lines.join("\n");
}

export type { AshMcpCompose, AshMcpComposeOpts, AshMcpEntry, AshMcpLaunch };
