// 「这一轮 agent 手上会不会有 ash MCP」的**配置文件那一档** —— 问不了 CLI 本人时的退路。
//
// ── 为什么要有这一档 ────────────────────────────────────────────────────────
//
// 判据本来只问 CLI 自己（`ash-mcp-reachability.ts` 顶部讲了为什么不读配置文件）。可问 CLI
// 要起进程，而起进程之前必须拿到一台能核销它的内核圈定（`ash-mcp-probe.ts`）—— macOS 上
// 压根没有这台设备，从 ssh 会话起的 Linux、只读 cgroup 的容器也没有。新链第 1 轮审查在这台
// Mac 上用真配置实测：配置里**确实**没有 ash 登记，派审预检 `reachable:true`、启动自检一声
// 不吭 —— 2026-10-28 那起事故（35 分钟审查、交不了卷）在这些机器上一字不改地能再来一遍。
//
// 所以「问不了 CLI」时退到读配置文件。这一档**不起任何进程**，也就不会把前几轮关掉的
// 「起一条收不回来的查询」重新放开。
//
// ── 它凭什么能拦人：只在「确定没有」时说没有 ────────────────────────────────────
//
// 第 1 版就是读配置文件，被审查用真实 CLI 打穿过（见 reachability 顶部那三个反例 + TOML
// 正则判不准）。这一档照样要面对那些反例，处置一律是**向放行开**：
//
//  · claude 的项目级登记（`--scope local`）：读 `.claude.json` 的 `projects[<目录>]`，
//    目录及其祖先都看；
//  · claude 的 `.mcp.json`（`--scope project`）：启用与否取决于审批状态，判不了 ⇒ unknown；
//  · 企业托管的 `managed-mcp.json`：存在即 unknown；
//  · codex 的 `-c mcp_servers.…` 覆盖：调用方带了 extraArgs 就不进这一档（同 claude 那条）；
//  · codex 项目内的 `.codex/config.toml`：里面提到 `mcp_servers` 即 unknown；
//  · TOML：不用正则判「有没有」，用一个只认表头/键路径的扫描器（见 `scanCodexToml`），
//    加引号、缩进、点号键、内联表都认；扫描器自己没把握时还有一道兜底（见那段注释）。
//
// 结论也要如实标出来源：这一档说「没有」时，文案里写明「读配置得出、未经 CLI 确认」，
// 并带上问不了 CLI 的原因 —— 用户至少知道这一次的证据是什么。
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ASH_MCP_SERVER_NAME, LEGACY_ASH_MCP_SERVER_NAME } from "@ash/shared/mcp";
import { resolveBin } from "./executors/bin-resolve.js";
import { boundListeningPort } from "./listening-port.js";

const WANTED = [ASH_MCP_SERVER_NAME, LEGACY_ASH_MCP_SERVER_NAME];

export type FileVerdict =
  | { state: "present"; hint: string | null }
  | { state: "unknown"; why: string }
  | { state: "absent"; detail: string }
  | { state: "disabled"; detail: string };

/** 一条登记**怎么起** —— 只拿来出提示，不参与拦/放。 */
export type LaunchSpec = { command?: string | null; args?: unknown; ashUrl?: string | null };

/**
 * 配置文件那一档的结论。`env` 是这一轮真正要用的那份（带着注入的 `CLAUDE_CONFIG_DIR` /
 * `CODEX_HOME`），`dirs` 是这一轮可能跑在的目录（`undefined` = 宿主默认上下文）。
 */
export function fileAshMcpVerdict(
  agentType: string,
  env: NodeJS.ProcessEnv,
  dirs: (string | undefined)[],
): FileVerdict {
  try {
    if (agentType === "claude") return claudeVerdict(env, dirs);
    if (agentType === "codex") return codexVerdict(env, dirs);
  } catch (e) {
    return { state: "unknown", why: `读配置失败：${(e as Error).message}` };
  }
  return { state: "unknown", why: `${agentType} 不归这里判` };
}

// ── claude ─────────────────────────────────────────────────────────────────

/** 企业托管的 MCP 配置（Claude Code 文档里的三处固定路径）。存在就不归我们判。 */
const MANAGED_MCP = process.platform === "darwin"
  ? "/Library/Application Support/ClaudeCode/managed-mcp.json"
  : process.platform === "win32"
    ? "C:\\ProgramData\\ClaudeCode\\managed-mcp.json"
    : "/etc/claude-code/managed-mcp.json";

function claudeVerdict(env: NodeJS.ProcessEnv, dirs: (string | undefined)[]): FileVerdict {
  if (existsSync(MANAGED_MCP)) return { state: "unknown", why: `有企业托管的 ${MANAGED_MCP}` };
  const file = join(env.CLAUDE_CONFIG_DIR?.trim() || homedir(), ".claude.json");
  const read = readText(file);
  if (read.kind === "unreadable") return { state: "unknown", why: `${file} 读不出来` };
  let doc: Record<string, unknown> = {};
  if (read.kind === "text" && read.text.trim()) {
    try {
      const parsed = JSON.parse(read.text) as unknown;
      // 解析不了 ≠ 没登记：CLI 可能正写到一半，也可能是用户手工改坏了一个花括号。
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { state: "unknown", why: `${file} 不是一个 JSON 对象` };
      }
      doc = parsed as Record<string, unknown>;
    } catch {
      return { state: "unknown", why: `${file} 解析不了` };
    }
  }
  // 用户级（`--scope user`）。
  const user = pickServer(doc.mcpServers);
  if (user) return { state: "present", hint: launchHint(claudeSpec(user)) };
  // 项目级（`--scope local`）住在 `projects[<绝对路径>]` —— 键是哪一层目录由 CLI 决定，
  // 所以每个候选目录连同它的祖先都看一遍。
  const projects = doc.projects && typeof doc.projects === "object"
    ? doc.projects as Record<string, unknown> : {};
  for (const dir of withAncestors(dirs)) {
    const entry = projects[dir];
    const local = entry && typeof entry === "object"
      ? pickServer((entry as Record<string, unknown>).mcpServers) : null;
    if (local) return { state: "present", hint: launchHint(claudeSpec(local)) };
    // `--scope project` 的 `.mcp.json`：用不用得上要看用户批没批过，这一档判不了。
    const shared = join(dir, ".mcp.json");
    if (existsSync(shared) && mentionsAsh(readText(shared))) {
      return { state: "unknown", why: `${shared} 里有登记，启用与否取决于审批状态` };
    }
  }
  return { state: "absent", detail: `${file} 里没有 ash MCP 登记（用户级、项目级都没有）` };
}

function pickServer(servers: unknown): Record<string, unknown> | null {
  if (!servers || typeof servers !== "object") return null;
  for (const name of WANTED) {
    const s = (servers as Record<string, unknown>)[name];
    if (s && typeof s === "object") return s as Record<string, unknown>;
  }
  return null;
}

function claudeSpec(entry: Record<string, unknown>): LaunchSpec {
  const envBlock = entry.env && typeof entry.env === "object" ? entry.env as Record<string, unknown> : {};
  return {
    command: typeof entry.command === "string" ? entry.command : null,
    args: entry.args,
    ashUrl: typeof envBlock.ASH_URL === "string" ? envBlock.ASH_URL : null,
  };
}

// ── codex ──────────────────────────────────────────────────────────────────

function codexVerdict(env: NodeJS.ProcessEnv, dirs: (string | undefined)[]): FileVerdict {
  const file = join(env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "config.toml");
  // codex 也认项目里的 `.codex/config.toml`（受信任的项目）。合并规则这一档不去复刻：
  // 只要那里提到 `mcp_servers`，就不归这里判。
  for (const dir of withAncestors(dirs)) {
    const project = join(dir, ".codex", "config.toml");
    if (resolve(project) === resolve(file)) continue;
    const read = readText(project);
    if (read.kind === "unreadable") return { state: "unknown", why: `${project} 读不出来` };
    if (read.kind === "text" && /mcp_servers/.test(read.text)) {
      return { state: "unknown", why: `${project} 里配了 mcp_servers，合并规则这一档不复刻` };
    }
  }
  const read = readText(file);
  if (read.kind === "unreadable") return { state: "unknown", why: `${file} 读不出来` };
  if (read.kind === "missing") return { state: "absent", detail: `${file} 还不存在` };
  const scan = scanCodexToml(read.text);
  if (scan.doubt) return { state: "unknown", why: `${file}：${scan.doubt}` };
  const states = [...scan.servers.values()];
  if (!states.length) return { state: "absent", detail: `${file} 里没有 [mcp_servers.ash]` };
  const live = [...scan.servers.entries()].find(([, s]) => s.enabled);
  if (live) return { state: "present", hint: launchHint(live[1].spec) };
  const names = [...scan.servers.keys()].map((n) => `[mcp_servers.${n}]`).join("、");
  return { state: "disabled", detail: `${file} 里的 ${names} 写着 enabled = false` };
}

export type CodexTomlScan = {
  servers: Map<string, { enabled: boolean; spec: LaunchSpec }>;
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
 * **兜底**：扫描器没认出任何登记、可文本里明明有 `ash`/`harness` 出现在表头或行首键的
 * 位置 —— 说明写法超出了它认得的范围（多行字符串里的假表头、它没跟上的嵌套等）。那时
 * 不说「没有」，答 doubt。拦人只能落在「确定没有」上。
 */
export function scanCodexToml(text: string): CodexTomlScan {
  const servers = new Map<string, { enabled: boolean; spec: LaunchSpec }>();
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
    const rest = path.slice(2).join(".");
    const value = stmt.value.trim();
    if (!rest) {
      // `ash = { ... }` 内联表：开关和启动方式从值里认。
      if (/\benabled\s*=\s*false\b/.test(value)) s.enabled = false;
      s.spec.command = inlineString(value, "command") ?? s.spec.command;
      s.spec.ashUrl = inlineString(value, "ASH_URL") ?? s.spec.ashUrl;
    } else if (rest === "enabled") {
      if (/^false\b/.test(value)) s.enabled = false;
    } else if (rest === "command") {
      s.spec.command = tomlString(value);
    } else if (rest === "args") {
      s.spec.args = tomlStringArray(value);
    } else if (rest === "env.ASH_URL") {
      s.spec.ashUrl = tomlString(value);
    } else if (rest === "env") {
      s.spec.ashUrl = inlineString(value, "ASH_URL") ?? s.spec.ashUrl;
    }
  }
  if (!servers.size && !doubt) {
    const names = WANTED.join("|");
    const suspicious = new RegExp(
      `^\\s*\\[[^\\]]*\\b(?:${names})\\b|^\\s*["']?(?:${names})["']?\\s*[.=]`, "m",
    );
    if (/mcp_servers/.test(text) && suspicious.test(text)) {
      doubt = "文本里有像是 ash 登记的写法，但扫描器没认出来";
    }
  }
  return { servers, doubt };
}

type Statement =
  | { kind: "header"; path: string[] }
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
  for (const raw of text.split(/\r?\n/)) {
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
      if (header) out.push({ kind: "header", path: keyPath(header[1]!) });
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

/** 内联表里 `key = "…"` 那一项的字符串值。 */
function inlineString(value: string, key: string): string | null {
  const m = new RegExp(`\\b${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|'[^']*')`).exec(value);
  return m ? tomlString(m[1]!) : null;
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

// ── 「登记在」不等于「起得来」：只出提示，不拦人 ─────────────────────────────────

/**
 * 登记里写的启动方式在这台机器上明显起不来时，说一句（新链第 1 轮审查第 3 条）。
 *
 * 只出提示、不改拦/放：这些判据都是推断（PATH 是 ash 这边的、端口可能有意指向别的实例），
 * 拿推断去拦一轮审查，正是这条链反复警惕的「把查不到变成拦住」。
 */
export function launchHint(spec: LaunchSpec): string | null {
  const notes: string[] = [];
  const cmd = spec.command?.trim();
  if (cmd) {
    const found = isAbsolute(cmd) ? existsSync(cmd) : !!resolveBin(cmd);
    if (!found) notes.push(`登记里的 command「${cmd}」在 ash 这边找不到`);
  }
  if (Array.isArray(spec.args)) {
    for (const arg of spec.args) {
      if (typeof arg === "string" && isAbsolute(arg) && /\.[mc]?js$/.test(arg) && !existsSync(arg)) {
        notes.push(`登记指向的 ${arg} 不存在`);
      }
    }
  }
  // 只认**确知**的端口（listen 过才有）：猜出来的 4317 拿去比对只会制造假提示。
  const port = boundListeningPort();
  if (spec.ashUrl && port) {
    try {
      const u = new URL(spec.ashUrl);
      const target = Number(u.port || (u.protocol === "https:" ? 443 : 80));
      const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname);
      if (local && target !== port) notes.push(`登记里的 ASH_URL 指向端口 ${target}，ash 现在监听的是 ${port}`);
    } catch { /* 不是 URL：不归这里说 */ }
  }
  return notes.length ? `${notes.join("；")}（只是提示，这一轮没拦）` : null;
}

// ── 小工具 ────────────────────────────────────────────────────────────────

type TextRead = { kind: "text"; text: string } | { kind: "missing" } | { kind: "unreadable" };

/** 「没有这个文件」和「有但读不动」必须分开：只有前者配得上「没有登记」。 */
function readText(file: string): TextRead {
  try {
    return { kind: "text", text: readFileSync(file, "utf8") };
  } catch (e) {
    return (e as { code?: string }).code === "ENOENT" || (e as { code?: string }).code === "ENOTDIR"
      ? { kind: "missing" } : { kind: "unreadable" };
  }
}

function mentionsAsh(read: TextRead): boolean {
  if (read.kind === "unreadable") return true;     // 读不动就当它可能有
  return read.kind === "text" && WANTED.some((n) => read.text.includes(`"${n}"`));
}

/** 候选目录连同它们的全部祖先（去重）。`undefined` = 宿主默认上下文，没有目录可看。 */
function withAncestors(dirs: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const d of dirs) {
    if (!d) continue;
    let cur = resolve(d);
    while (!seen.has(cur)) {
      seen.add(cur);
      const up = dirname(cur);
      if (up === cur) break;
      cur = up;
    }
  }
  return [...seen];
}
