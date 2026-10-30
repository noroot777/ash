// codex 的 `config.toml` 里「ash 登记在不在、叫什么、关没关」—— **唯一**一份判据。
//
// 派审预检、设置页、隔离档自动补写、执行器注入回合身份四处都读它。以前各写各的：预检用
// 结构扫描，注入那一侧还是 `^\[mcp_servers\.ash\]` 行首正则 —— `[mcp_servers."ash"]` 这种
// codex 自己认得的写法，预检说「接好了」，注入却认不出来、不给 MCP 传回合身份，审查跑完
// 交卷照样 409（新链第 4 轮审查第 1 条）。判据只有一份，才不会出现「预检越准、越替一份
// 实际交不了卷的配置背书」。
import { ASH_MCP_SERVER_NAME, LEGACY_ASH_MCP_SERVER_NAME } from "@ash/shared/mcp";

const WANTED = [ASH_MCP_SERVER_NAME, LEGACY_ASH_MCP_SERVER_NAME];

/** 一条登记**怎么起** —— 只拿来出提示，不参与拦/放。 */
export type LaunchSpec = { command?: string | null; args?: unknown; ashUrl?: string | null };

type CodexServer = { enabled: boolean; spec: LaunchSpec };

export type CodexTomlScan = {
  servers: Map<string, CodexServer>;
  /** 非空 = 扫描器自己没把握（写法超出它认得的范围），调用方必须按「判不了」处理。 */
  doubt: string | null;
};

/**
 * 只认 TOML 的**结构**（表头、键路径），不解析值 —— 「有没有 ash 这条登记、是不是关着」
 * 只需要这些。认得的写法：
 *
 *   [mcp_servers.ash]        [ mcp_servers . "ash" ]       [mcp_servers.'ash'.env]
 *   mcp_servers.ash.command = "node"                       （根上的点号键）
 *   [mcp_servers]  ash = { command = "node", enabled = false }   （内联表）
 *
 * **兜底**：扫描器没认出任何登记、可文本里明明有 `mcp_servers.ash` / `mcp_servers.harness`
 * 出现在表头或行首键的位置 —— 说明写法超出了它认得的范围（多行字符串里的假表头、它没跟上的
 * 嵌套等）。那时不说「没有」，答 doubt。拦人只能落在「确定没有」上。别处出现这两个词（路径
 * 型表头、注释、值里）不算信号。
 */
export function scanCodexToml(text: string): CodexTomlScan {
  const servers = new Map<string, CodexServer>();
  const slot = (name: string) => {
    let s = servers.get(name);
    if (!s) { s = { enabled: true, spec: {} }; servers.set(name, s); }
    return s;
  };
  let table: string[] = [];
  let doubt: string | null = null;
  for (const stmt of statements(text)) {
    if (stmt.kind === "header") {
      table = stmt.path;
      const at = table.indexOf("mcp_servers");
      if (at > 0) doubt ??= `[${table.join(".")}] 把 mcp_servers 挂在了别的表底下`;
      // 表头本身就是一次登记（`[mcp_servers.ash]` 下面可以一行都没有）。
      if (at === 0 && table.length >= 2 && WANTED.includes(table[1]!)) slot(table[1]!);
      continue;
    }
    const path = [...table, ...stmt.path];
    const at = path.indexOf("mcp_servers");
    if (at > 0) { doubt ??= `${path.join(".")} 把 mcp_servers 挂在了别的表底下`; continue; }
    if (at < 0) continue;
    if (path.length === 1) {
      // `mcp_servers = { ash = {...} }`：整张表写成一个内联值，这一档不去拆。
      if (WANTED.some((n) => new RegExp(`\\b${n}\\b`).test(stmt.value))) {
        doubt ??= "mcp_servers 整个写成了内联表";
      }
      continue;
    }
    const name = path[1]!;
    if (!WANTED.includes(name)) continue;
    const s = slot(name);
    if (!applyServerValue(s, path.slice(2), stmt.value)) doubt ??= `${path.join(".")} 的值无法识别`;
  }
  if (!servers.size && !doubt) {
    // **只认「mcp_servers 底下的 ash」那个位置**：表头或点号键的第一段是 `mcp_servers`、
    // 第二段是兼容名。上一版拿「行首是 `[` 且行内有 ash/harness」当信号，codex 自己记项目
    // 信任的 `[projects."/Users/x/code/harness"]` 正好命中 —— 跑过这个仓库的机器上整份配置
    // 都成了「看不准」，预检放行、启动自检闭嘴（新链第 3 轮审查第 1 条）。
    const name = `["']?(?:${WANTED.join("|")})["']?`;
    const head = `["']?mcp_servers["']?\\s*\\.\\s*${name}`;
    const suspicious = new RegExp(`^\\s*\\[\\[?\\s*${head}\\s*[.\\]]|^\\s*${head}\\s*[.=]`, "m");
    if (suspicious.test(text)) {
      doubt = "文本里有像是 ash 登记的写法，但扫描器没认出来";
    }
  }
  return { servers, doubt };
}

type Statement =
  | { kind: "header"; path: string[]; line: number; array: boolean }
  | { kind: "pair"; path: string[]; value: string };

/**
 * 把 TOML 切成「表头」和「键 = 值」两种语句。值可以跨行（多行数组/内联表/多行字符串），
 * 所以按括号深度和多行字符串状态把续行拼回去 —— 续行里的 `[` 不会被当成表头。
 */
function statements(text: string): Statement[] {
  const out: Statement[] = [];
  let pending: { path: string[]; value: string } | null = null;
  let depth = 0;
  let ml: '"""' | "'''" | null = null;
  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n]!;
    if (pending) {
      const scanned = scanValue(raw, depth, ml);
      pending.value += `\n${scanned.text}`;
      depth = scanned.depth; ml = scanned.ml;
      if (!depth && !ml) { out.push({ kind: "pair", ...pending }); pending = null; }
      continue;
    }
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      // 不在续行里时，行首的 `[` 只可能是表头；引号里的 `]` 不算收尾。
      const header = /^\[\[?((?:[^\]"']|"(?:[^"\\]|\\.)*"|'[^']*')*)\]/.exec(line);
      if (header) out.push({ kind: "header", path: keyPath(header[1]!), line: n, array: line.startsWith("[[") });
      continue;
    }
    const eq = splitKey(line);
    if (!eq) continue;
    const scanned = scanValue(eq.value, 0, null);
    depth = scanned.depth; ml = scanned.ml;
    if (depth || ml) pending = { path: eq.path, value: scanned.text };
    else out.push({ kind: "pair", path: eq.path, value: scanned.text });
  }
  if (pending) out.push({ kind: "pair", ...pending });
  return out;
}

/** `a."b".'c'` → ["a","b","c"]。点号只在引号外才是分隔符。 */
function keyPath(raw: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of raw) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ".") { parts.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur.trim());
  return parts;
}

/** 找引号外的第一个 `=`，切成键路径和值。 */
function splitKey(line: string): { path: string[]; value: string } | null {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "=") return { path: keyPath(line.slice(0, i)), value: line.slice(i + 1) };
  }
  return null;
}

/** 跟踪一段值文本的括号深度与多行字符串状态，并去掉引号外的行尾注释。 */
function scanValue(
  text: string,
  depth: number,
  ml: '"""' | "'''" | null,
): { text: string; depth: number; ml: '"""' | "'''" | null } {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ml) {
      if (text.startsWith(ml, i)) { out += ml; i += 2; ml = null; } else out += ch;
      continue;
    }
    if (quote) {
      out += ch;
      if (ch === "\\" && quote === '"') { out += text[i + 1] ?? ""; i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
      ml = text.slice(i, i + 3) as '"""' | "'''"; out += ml; i += 2; continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
    if (ch === "#") break;
    if (ch === "[" || ch === "{") depth++;
    if (ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    out += ch;
  }
  return { text: out, depth, ml };
}

function inlinePairs(raw: string): { path: string[]; value: string }[] | null {
  const value = raw.trim();
  if (!value.startsWith("{") || !value.endsWith("}")) return null;
  const body = value.slice(1, -1);
  const fields: { path: string[]; value: string }[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  let multiline: string | null = null;
  for (let index = 0; index <= body.length; index++) {
    const character = body[index];
    if (multiline) {
      if (character === "\\" && multiline === '"""') { index++; continue; }
      if (body.startsWith(multiline, index)) { index += 2; multiline = null; }
      continue;
    }
    if (quote) {
      if (character === "\\" && quote === '"') { index++; continue; }
      if (character === quote) quote = null;
      continue;
    }
    if (body.startsWith('"""', index) || body.startsWith("'''", index)) {
      multiline = body.slice(index, index + 3); index += 2; continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === "[" || character === "{") depth++;
    if (character === "]" || character === "}") depth--;
    if (depth < 0) return null;
    if (depth || (character !== "," && index !== body.length)) continue;
    const field = body.slice(start, index).trim();
    if (field) {
      const pair = splitKey(field);
      if (!pair) return null;
      fields.push(pair);
    } else if (index !== body.length) return null;
    start = index + 1;
  }
  return depth || quote || multiline ? null : fields;
}

function applyServerValue(server: CodexServer, path: string[], raw: string): boolean {
  const value = raw.trim();
  if (!path.length || (path.length === 1 && path[0] === "env")) {
    const fields = inlinePairs(value);
    return fields !== null && fields.every((field) => applyServerValue(server, [...path, ...field.path], field.value));
  }
  if (path.length === 1) {
    if (path[0] === "enabled") {
      if (value !== "true" && value !== "false") return false;
      server.enabled = value === "true";
    } else if (path[0] === "command") server.spec.command = tomlString(value);
    else if (path[0] === "args") server.spec.args = tomlStringArray(value);
  } else if (path.length === 2 && path[0] === "env" && path[1] === "ASH_URL") {
    server.spec.ashUrl = tomlString(value);
  }
  return true;
}

function tomlString(raw: string): string | null {
  const v = raw.trim();
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1);
  if (v.startsWith('"') && v.endsWith('"')) {
    try { return JSON.parse(v) as string; } catch { return null; }
  }
  return null;
}

function tomlStringArray(raw: string): string[] {
  const out: string[] = [];
  for (const m of raw.matchAll(/"(?:[^"\\]|\\.)*"|'[^']*'/g)) {
    const s = tomlString(m[0]);
    if (s !== null) out.push(s);
  }
  return out;
}

/**
 * 执行器往哪个名字里注入 `-c mcp_servers.<名>.env_vars=…`（回合身份靠它进 MCP 子进程）。
 *
 * 只认扫描器**正面认出来**的登记 —— 往一个没声明的名字里塞 `-c`，codex 整份配置都起不来
 * （实测 codex-cli 0.153：`invalid transport in mcp_servers.harness`）。带引号的表头、内联表
 * 都接受不带引号的 `-c` 覆盖（同版本实测）。两个兼容名都在时取开着的那个，都开着取规范名。
 */
export function codexInjectionTarget(text: string): string | null {
  const { servers } = scanCodexToml(text);
  const names = WANTED.filter((n) => servers.has(n));
  return names.find((n) => servers.get(n)!.enabled) ?? names[0] ?? null;
}

/**
 * 把 `[mcp_servers.<name>]` 连同它的子表（`.env` 等）整段抠出来，表头一律改写成
 * `[mcp_servers.<as>…]` 的规范拼法（带引号、带行尾注释的表头都认，历史名顺手改成规范名）。
 *
 * 切段用的是扫描器同一份表头识别：多行字符串里的 `[` 不算表头，`[[…]]` 数组表也算一次
 * 切换。抠出来的东西必须自己就能被认成一条**有启动命令**的登记，否则返回 null 让调用方
 * 用内置模板 —— 一部分写在 `[mcp_servers]` 底下的点号键里时，只抠走 `.env` 那段会造出
 * 一条没有 command 的登记，codex 照样整份拒载。
 */
export function extractTomlTables(config: string, name: string, as = name): string | null {
  const lines = config.split(/\r?\n/);
  const heads = statements(config).filter((s) => s.kind === "header");
  const picked: string[] = [];
  heads.forEach((h, i) => {
    if (h.path[0] !== "mcp_servers" || h.path[1] !== name) return;
    const rest = h.path.slice(2).map((seg) => `.${/^[A-Za-z0-9_-]+$/.test(seg) ? seg : JSON.stringify(seg)}`).join("");
    const head = `mcp_servers.${as}${rest}`;
    picked.push(h.array ? `[[${head}]]` : `[${head}]`, ...lines.slice(h.line + 1, heads[i + 1]?.line ?? lines.length));
  });
  while (picked.length && !picked[picked.length - 1]!.trim()) picked.pop();
  if (!picked.length) return null;
  const block = picked.join("\n");
  return scanCodexToml(block).servers.get(as)?.spec.command ? block : null;
}
