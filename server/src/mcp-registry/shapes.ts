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
import { extractTomlTables, scanCodexToml } from "../codex-toml.js";
import type {
  AshMcpCompose, AshMcpComposeOpts, AshMcpConfigState, AshMcpEntry, AshMcpLaunch, AshMcpShape,
} from "./types.js";

const WANTED = [ASH_MCP_SERVER_NAME, LEGACY_ASH_MCP_SERVER_NAME];

const present = (serverName: string): AshMcpConfigState => ({ state: "present", serverName, detail: "" });
const absent = (detail: string): AshMcpConfigState => ({ state: "absent", serverName: null, detail });
const unknown = (detail: string): AshMcpConfigState => ({ state: "unknown", serverName: null, detail });

// ── JSON 两族共用的小工具 ──────────────────────────────────────────────────

/** `null` = 确认没有这个文件或内容是空白(当空文档,我们来建);`undefined` = 解析不了(**别动它**)。 */
function parseDoc(text: string | null): Record<string, unknown> | null | undefined {
  if (text === null || !text.trim()) return null;
  try {
    const parsed = JSON.parse(stripJsonComments(text).text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * 注释一旦存在就**不自动改写这份配置**。
 *
 * 读是读得了(`stripJsonComments`),可拼回去用的是 `JSON.parse` 出来的文档对象 ——
 * 序列化出去注释全没了。用户在 `opencode.jsonc` / `kilo.jsonc` 里写的注释是他自己的内容,
 * 本轮的硬边界是「只在缺 ash 条目时追加,绝不动其它条目」,把人家的注释抹掉算动。
 * 所以这种文件改走「如实说一句,让用户自己加」那条路(预检会把这句显示出来)。
 */
function hasComments(text: string | null): boolean {
  return text !== null && stripJsonComments(text).stripped;
}

/**
 * `.jsonc` 这一族(kilo 的 `kilo.jsonc`、opencode 允许注释)读之前要去掉注释,
 * 否则一份合法配置会被判成「解析不了」。**只用于读**;写那一侧见 `hasComments`。
 */
function stripJsonComments(text: string): { text: string; stripped: boolean } {
  let out = "";
  let inString = false;
  let escape = false;
  let stripped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      stripped = true;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 1;
      stripped = true;
      continue;
    }
    out += ch;
  }
  return { text: out, stripped };
}

/** 两个 JSON 族共用的「能不能动这份文件」前置判断。 */
function jsonComposeGuard(text: string | null): { why: string } | null {
  if (hasComments(text)) {
    return {
      why: "配置里有注释，自动改写会把注释丢掉，所以没有动它 —— "
        + "请自己在里面加一条 ash 登记（或把注释挪到别处再重启）",
    };
  }
  return null;
}

const asObject = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** 这条登记有没有被显式关掉。两种写法都认(`disabled: true` / `enabled: false`)。 */
const switchedOff = (entry: Record<string, unknown>): boolean =>
  entry.disabled === true || entry.enabled === false;

/** 在容器里找 ash(或历史名)那条登记。 */
function pickEntry(container: unknown, file: string): AshMcpConfigState {
  const servers = asObject(container);
  if (container !== undefined && !servers) return unknown(`${file} 里的登记容器不是一个对象`);
  for (const name of WANTED) {
    const entry = servers ? asObject(servers[name]) : null;
    if (!entry) continue;
    return switchedOff(entry)
      ? { state: "disabled", serverName: name, detail: `${file} 里的 ${name} 这条登记是关着的` }
      : present(name);
  }
  return absent(`${file} 里没有 ash MCP 登记`);
}

const serialize = (doc: Record<string, unknown>): string => `${JSON.stringify(doc, null, 2)}\n`;

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
    const guard = jsonComposeGuard(text);
    if (guard) return guard;
    const doc = parseDoc(text);
    if (doc === undefined) return { why: "配置解析不了，没敢动它 —— 手工修好或删掉它再重启" };
    const base = doc ?? {};
    const servers = asObject(base[CONTAINER]);
    if (base[CONTAINER] !== undefined && !servers) {
      return { why: `配置里的 ${CONTAINER} 不是一个对象，没敢动它` };
    }
    const value = opts?.type ? { type: opts.type, ...entry } : { ...entry };
    // 规范名落地:宿主那份即使叫历史名 harness,搬过来也按 ash 登记(两边都叫 ash 之后,
    // 提示词里那句「ash MCP」才对得上工具名)。
    base[CONTAINER] = { ...(servers ?? {}), [ASH_MCP_SERVER_NAME]: value };
    const body = serialize(base);
    // 自己复核一遍:这一族的「真解析器」就在手上(语义全在 JSON 语法里),所以拼完能当场验。
    const back = mcpServersJsonShape.read(body);
    if (back.state !== "present") return { why: `补上那条之后仍读不出 ash MCP 登记（${back.detail}）` };
    return { body };
  },
  hostEntry(text) {
    const doc = parseDoc(text);
    const servers = doc ? asObject(doc[CONTAINER]) : null;
    if (!servers) return null;
    for (const name of WANTED) {
      const entry = asObject(servers[name]);
      if (entry && typeof entry.command === "string") {
        return {
          command: entry.command,
          args: Array.isArray(entry.args) ? entry.args.map(String) : [],
          env: Object.fromEntries(Object.entries(asObject(entry.env) ?? {}).map(([k, v]) => [k, String(v)])),
        };
      }
    }
    return null;
  },
  launch(text) {
    const doc = parseDoc(text);
    const servers = doc ? asObject(doc[CONTAINER]) : null;
    if (!servers) return null;
    for (const name of WANTED) {
      const entry = asObject(servers[name]);
      if (!entry) continue;
      const env = asObject(entry.env) ?? {};
      return {
        command: typeof entry.command === "string" ? entry.command : null,
        args: entry.args,
        ashUrl: typeof env.ASH_URL === "string" ? env.ASH_URL : null,
      };
    }
    return null;
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
    const guard = jsonComposeGuard(text);
    if (guard) return guard;
    const doc = parseDoc(text);
    if (doc === undefined) return { why: "配置解析不了，没敢动它 —— 手工修好或删掉它再重启" };
    const base = doc ?? {};
    const servers = asObject(base[OPENCODE_CONTAINER]);
    if (base[OPENCODE_CONTAINER] !== undefined && !servers) {
      return { why: `配置里的 ${OPENCODE_CONTAINER} 不是一个对象，没敢动它` };
    }
    base[OPENCODE_CONTAINER] = { ...(servers ?? {}), [ASH_MCP_SERVER_NAME]: opencodeEntry(entry) };
    const body = serialize(base);
    const back = opencodeJsonShape.read(body);
    if (back.state !== "present") return { why: `补上那条之后仍读不出 ash MCP 登记（${back.detail}）` };
    return { body };
  },
  launch(text) {
    const doc = parseDoc(text);
    const servers = doc ? asObject(doc[OPENCODE_CONTAINER]) : null;
    if (!servers) return null;
    for (const name of WANTED) {
      const entry = asObject(servers[name]);
      if (!entry) continue;
      const argv = Array.isArray(entry.command) ? entry.command.map(String) : [];
      const env = asObject(entry.environment) ?? {};
      return {
        command: argv[0] ?? null,
        args: argv.slice(1),
        ashUrl: typeof env.ASH_URL === "string" ? env.ASH_URL : null,
      };
    }
    return null;
  },
};

// ── ③ TOML 这一族(codex / grok)────────────────────────────────────────────
//
// `[mcp_servers.<名>]` + `[mcp_servers.<名>.env]`。grok 本轮实测写出来的跟 codex 一模一样
// (多一行 `enabled = true`),所以判据直接共用 codex 那份**结构**扫描器 —— 不再写第二份
// 正则:`[mcp_servers."ash"]`、缩进表头、点号键、内联表都认,它自己没把握时答 unknown。

/**
 * grok 还有一个根级开关 `disabled_mcp_servers = ["ash"]`(实测 `grok mcp disable ash` 会
 * 同时写它和 `enabled = false`)。这里只认**写在一行里**的那种数组,多行的认不出来就
 * 当没有 —— 方向刻意偏向「放行」:多行数组被漏读,最坏是放过一轮(跑完没结论,有说明);
 * 反过来误判成「关着」会当场拦掉一轮本来跑得起来的审查。
 */
function tomlRootDisabled(text: string, name: string): boolean {
  const line = /^[ \t]*disabled_mcp_servers[ \t]*=[ \t]*\[(.*)\][ \t]*(?:#.*)?$/m.exec(text);
  if (!line) return false;
  return new RegExp(`['"]${name}['"]`).test(line[1]!);
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
    const live = [...scan.servers.entries()].find(([, s]) => s.enabled);
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
