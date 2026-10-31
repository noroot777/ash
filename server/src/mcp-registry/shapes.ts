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
  AshMcpCompose, AshMcpComposeOpts, AshMcpConfigState, AshMcpEntry, AshMcpLaunch, AshMcpShape,
} from "./types.js";

const WANTED = [ASH_MCP_SERVER_NAME, LEGACY_ASH_MCP_SERVER_NAME];

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

/**
 * 在容器里找 ash(或历史名)那条登记。
 *
 * 两条判据都是本轮审查打出来的:
 *
 * ① **先找开着的那条,再汇总关着的**(R8)。两个兼容名是两条独立登记:`ash` 关着、
 *    `harness` 开着时,CLI 那边 ash MCP 是**能用**的 —— 上一版按 `WANTED` 的顺序取,
 *    取到关着的那条就当场返回 disabled,而 disabled 在预检里是硬拒。TOML 族一直是
 *    「先找 live」,JSON 这两族跟上。
 * ② **值不是对象一律 unknown**(N2)。`"ash": null`、`"ash": "node x.js"` 这种写法我们
 *    认不出来,上一版直接跳过当没有 —— 于是 compose 会把那个键覆盖掉,跟「已有登记一律
 *    不覆盖」自相矛盾。认不出来就说认不出来。
 */
function pickEntry(container: unknown, file: string): AshMcpConfigState {
  const servers = asObject(container);
  if (container !== undefined && !servers) return unknown(`${file} 里的登记容器不是一个对象`);
  const off: string[] = [];
  for (const name of WANTED) {
    const raw = servers ? servers[name] : undefined;
    if (raw === undefined) continue;
    const entry = asObject(raw);
    if (!entry) return unknown(`${file} 里的 ${name} 这条登记不是一个对象（值是 ${typeof raw}）`);
    if (!switchedOff(entry)) return present(name);
    off.push(name);
  }
  if (off.length) {
    return {
      state: "disabled",
      serverName: off[0]!,
      detail: `${file} 里的 ${off.join(" / ")} ${off.length > 1 ? "这几条登记都" : "这条登记"}是关着的`,
    };
  }
  return absent(`${file} 里没有 ash MCP 登记`);
}

/** 这个键能不能写(已有的一律不覆盖,含认不出来的值 —— 判据跟 `pickEntry` 同一份)。 */
function takenNames(container: unknown): string[] {
  const servers = asObject(container);
  return servers ? WANTED.filter((n) => Object.hasOwn(servers, n)) : [];
}

/**
 * 容器里**活着**的那一条登记(关着的跳过)。
 *
 * 三个地方共用这一份判据:搬宿主那条(`hostRaw`)、报状态(`pickEntry`)、给诊断提示
 * (`launch`)。各写一遍的后果上一版就犯过:`launch` 按名字取**第一条**,于是
 * `harness` 关着、`ash` 开着时,提示里拿的是那条关着的 —— 用户照着提示去查一个
 * 根本没在跑的命令,而 `read` 明明已经放行了(本轮审查不拦项)。
 */
function activeEntry(container: unknown): Record<string, unknown> | null {
  const servers = asObject(container);
  if (!servers) return null;
  for (const name of WANTED) {
    const entry = asObject(servers[name]);
    if (entry && !switchedOff(entry)) return entry;
  }
  return null;
}

/** 宿主那条**开着**的登记原值(关着的不搬,见 `AshMcpShape.hostRaw`)。 */
const pickHostRaw = activeEntry;

/**
 * 把一条登记按规范名写进容器 —— JSON 两族**只有这一处会改文档**。
 *
 * 规范名落地:宿主那份即使叫历史名 harness,搬过来也按 ash 登记(两边都叫 ash 之后,提示词
 * 里那句「ash MCP」才对得上工具名)。已有同名键一律不碰(含值认不出来的那种,见 `pickEntry`
 * 的 ②):调用方本该先 `read` 过,这里是第二道闸,因为「覆盖用户已有登记」是不可逆的。
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

export const mcpServersJsonShape: AshMcpShape = {
  id: "mcp-servers-json",
  read(text) {
    const doc = parseDoc(text);
    if (doc === undefined) return unknown("配置解析不了（它可能正被 CLI 写到一半，也可能被手工改坏了）");
    if (doc === null) return absent("配置文件还不存在");
    return pickEntry(doc[CONTAINER], "配置");
  },
  compose(text, entry, opts) {
    const value = opts?.type ? { type: opts.type, ...entry } : { ...entry };
    return putJson(mcpServersJsonShape, CONTAINER, text, value);
  },
  composeRaw(text, value) {
    return putJson(mcpServersJsonShape, CONTAINER, text, value);
  },
  hostRaw(text) {
    const doc = parseDoc(text);
    return doc ? pickHostRaw(doc[CONTAINER]) : null;
  },
  launch(text) {
    const doc = parseDoc(text);
    // 取**活着**那一条(见 `activeEntry`):关着的那条拿来当提示会把人引到一个没在跑的命令上。
    const entry = doc ? activeEntry(doc[CONTAINER]) : null;
    if (!entry) return null;
    const env = asObject(entry.env) ?? {};
    return {
      command: typeof entry.command === "string" ? entry.command : null,
      args: entry.args,
      ashUrl: typeof env.ASH_URL === "string" ? env.ASH_URL : null,
    };
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

export const opencodeJsonShape: AshMcpShape = {
  id: "opencode-json",
  read(text) {
    const doc = parseDoc(text);
    if (doc === undefined) return unknown("配置解析不了（它可能正被 CLI 写到一半，也可能被手工改坏了）");
    if (doc === null) return absent("配置文件还不存在");
    return pickEntry(doc[OPENCODE_CONTAINER], "配置");
  },
  compose(text, entry) {
    return putJson(opencodeJsonShape, OPENCODE_CONTAINER, text, opencodeEntry(entry));
  },
  composeRaw(text, value) {
    return putJson(opencodeJsonShape, OPENCODE_CONTAINER, text, value);
  },
  hostRaw(text) {
    const doc = parseDoc(text);
    return doc ? pickHostRaw(doc[OPENCODE_CONTAINER]) : null;
  },
  launch(text) {
    const doc = parseDoc(text);
    const entry = doc ? activeEntry(doc[OPENCODE_CONTAINER]) : null;
    if (!entry) return null;
    const argv = Array.isArray(entry.command) ? entry.command.map(String) : [];
    const env = asObject(entry.environment) ?? {};
    return {
      command: argv[0] ?? null,
      args: argv.slice(1),
      ashUrl: typeof env.ASH_URL === "string" ? env.ASH_URL : null,
    };
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

export const mcpServersTomlShape: AshMcpShape = {
  id: "mcp-servers-toml",
  read(text) {
    if (text === null) return absent("配置文件还不存在");
    const scan = scanCodexToml(text);
    if (scan.doubt) return unknown(scan.doubt);
    const names = [...scan.servers.keys()];
    if (!names.length) return absent("配置里没有 [mcp_servers.ash]");
    const live = names.find((n) => scan.servers.get(n)!.enabled && !tomlRootDisabled(text, n));
    if (live) return present(live);
    // 关法有两种,说清是哪一种:用户要照着去改的就是那一行(只说「关着的」等于让他自己去翻)。
    const off = names
      .map((n) => scan.servers.get(n)!.enabled
        ? `[mcp_servers.${n}] 被 disabled_mcp_servers 关掉了`
        : `[mcp_servers.${n}] 写着 enabled = false`)
      .join("、");
    return { state: "disabled", serverName: names[0]!, detail: off };
  },
  compose(text, entry, opts) {
    return appendToml(text, tomlBlock(entry, opts?.enabled === true));
  },
  hostBlock: tomlHostBlock,
  blockFor: (entry, opts) => tomlBlock(entry, opts?.enabled === true),
  appendBlock: appendToml,
  launch(text) {
    if (text === null) return null;
    const scan = scanCodexToml(text);
    // 关法有两种,`read` 两种都看 —— 这里也必须两种都看(只看条目上那个 `enabled` 的话,
    // 根级 `disabled_mcp_servers` 关掉的那条会被当成在跑的拿去当提示)。
    const live = [...scan.servers.entries()].find(([name, s]) => s.enabled && !tomlRootDisabled(text, name));
    return live ? live[1].spec : null;
  },
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

/** TOML 族搬宿主那条登记:整段原文照搬(表头顺手改成规范名)。 */
export function tomlHostBlock(text: string): string | null {
  return extractTomlTables(text, ASH_MCP_SERVER_NAME)
    ?? extractTomlTables(text, LEGACY_ASH_MCP_SERVER_NAME, ASH_MCP_SERVER_NAME);
}

export type { AshMcpCompose, AshMcpComposeOpts, AshMcpEntry, AshMcpLaunch };
