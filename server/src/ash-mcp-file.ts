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
//  · claude 的项目级登记（`--scope local`）：读 `.claude.json` 的 `projects[<键>]`，键按
//    claude 自己的规则算（主仓的 git 根，或不在仓库里时目录本身，见 `claudeProjectKeys`）；
//  · claude 的 `.mcp.json`（`--scope project`）：启用与否取决于审批状态，判不了 ⇒ unknown；
//  · 企业托管的 `managed-mcp.json`：存在即 unknown；
//  · codex 的 `-c mcp_servers.…` 覆盖：调用方带了 extraArgs 就不进这一档（同 claude 那条）；
//  · codex 项目内的 `.codex/config.toml`：里面提到 `mcp_servers` 即 unknown；
//  · TOML：不用正则判「有没有」，用一个只认表头/键路径的扫描器（见 `scanCodexToml`），
//    加引号、缩进、点号键、内联表都认；扫描器自己没把握时还有一道兜底（见那段注释）。
//
// 结论也要如实标出来源：这一档说「没有」时，文案里写明「读配置得出、未经 CLI 确认」，
// 并带上问不了 CLI 的原因 —— 用户至少知道这一次的证据是什么。
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { ASH_MCP_SERVER_NAME, LEGACY_ASH_MCP_SERVER_NAME } from "@ash/shared/mcp";
import { type LaunchSpec, scanCodexToml } from "./codex-toml.js";
import { resolveBin } from "./executors/bin-resolve.js";
import { boundListeningPort } from "./listening-port.js";

const WANTED = [ASH_MCP_SERVER_NAME, LEGACY_ASH_MCP_SERVER_NAME];

export { type CodexTomlScan, type LaunchSpec, scanCodexToml } from "./codex-toml.js";

export type FileVerdict =
  | { state: "present"; hint: string | null }
  | { state: "unknown"; why: string }
  | { state: "absent"; detail: string }
  | { state: "disabled"; detail: string };


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
  // 项目级（`--scope local`）住在 `projects[<键>]`，键只有一个，见 `claudeProjectKeys`。
  // 上一版把每个候选目录的**全部祖先**都当键，于是仓库外面某个上层目录的登记（claude 根本
  // 不认）会让下面所有任务放行（新链第 3 轮审查第 3 条）。
  const projects = doc.projects && typeof doc.projects === "object"
    ? doc.projects as Record<string, unknown> : {};
  for (const dir of dirs) {
    if (!dir) continue;
    const keys = claudeProjectKeys(dir);
    if (!keys) return { state: "unknown", why: `${dir} 的 git 结构读不懂，算不出 claude 把项目级登记挂在哪` };
    for (const key of keys) {
      const entry = projects[key];
      const local = entry && typeof entry === "object"
        ? pickServer((entry as Record<string, unknown>).mcpServers) : null;
      if (local) return { state: "present", hint: launchHint(claudeSpec(local)) };
    }
  }
  // `--scope project` 的 `.mcp.json`：用不用得上要看用户批没批过，这一档判不了。**这一份要
  // 一路看到文件系统根** —— 跟项目级登记不一样，claude 2.1 实测会读 git 根外面上层目录里的
  // `.mcp.json`（`claude mcp get` 报 Project config / Pending approval）。
  for (const dir of withAncestors(dirs)) {
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
  //
  // **哪些算「项目里的」要照 codex 自己的范围来**，否则一份根本不生效的配置会替这一轮
  // 下结论（新链第 2 轮审查第 2 条：`CODEX_HOME` 指到别处、任务目录在 `$HOME` 下时，祖先
  // 里那份宿主 `~/.codex/config.toml` 让整条判成「判不了」）。codex-cli 0.153 实测两条：
  //  · 向上找只到 git 根为止，根外面的 `.codex/config.toml` 不读；
  //  · `CODEX_HOME` 指到别处时，`~/.codex/config.toml` 不会被当成项目配置读进来（哪怕
  //    任务目录就在 `$HOME` 下、一路没有 git 根）。
  // 所以这两份都跳过：生效的用户配置下面单独读，宿主默认那份这一轮压根不生效。
  const hostDefault = resolve(join(homedir(), ".codex", "config.toml"));
  for (const dir of upToGitRoot(dirs)) {
    const project = join(dir, ".codex", "config.toml");
    if (resolve(project) === resolve(file) || resolve(project) === hostDefault) continue;
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
/**
 * claude 把项目级（`--scope local`）登记挂在哪个键上。claude 2.1.283 实测：
 *  · 在 git 仓库里，键是**主仓**的根 —— 从子目录、从 worktree 里跑，认的都是主仓那一条；
 *    子目录自己的键、worktree 自己路径的键、git 根外面祖先的键，一概不认；
 *  · 不在 git 仓库里，键就是这个目录本身（它的祖先也不认）。
 * 符号链接两种写法都给（`/tmp` 与 `/private/tmp`），多认一个只会偏向放行。
 *
 * 返回 null = git 结构读不懂（子模块、bare 仓库、gitdir 指向说不清的地方），调用方判不了。
 */
function claudeProjectKeys(dir: string): string[] | null {
  let cur = resolve(dir);
  let key: string | null = null;
  for (;;) {
    const dotGit = join(cur, ".git");
    if (existsSync(dotGit)) { key = mainRepoRoot(cur, dotGit); if (!key) return null; break; }
    const up = dirname(cur);
    if (up === cur) { key = resolve(dir); break; }
    cur = up;
  }
  const keys = [key];
  try { const real = realpathSync(key); if (real !== key) keys.push(real); } catch { /* 留原样 */ }
  return keys;
}

/** `.git` 是目录 ⇒ 这里就是主仓；是文件（worktree）⇒ 顺着 `gitdir` → `commondir` 找回主仓。 */
function mainRepoRoot(top: string, dotGit: string): string | null {
  try {
    if (statSync(dotGit).isDirectory()) return top;
    const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
    if (!gitdir) return null;
    const own = resolve(top, gitdir);
    const commondir = join(own, "commondir");
    if (!existsSync(commondir)) return null;           // 子模块之类：没有 commondir，不去猜
    const common = resolve(own, readFileSync(commondir, "utf8").trim());
    return basename(common) === ".git" ? dirname(common) : null;
  } catch {
    return null;
  }
}

/** 每个目录往上走到（含）最近的 git 根为止；一路没有 git 根就走到文件系统根。 */
function upToGitRoot(dirs: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const d of dirs) {
    if (!d) continue;
    let cur = resolve(d);
    while (!seen.has(cur)) {
      seen.add(cur);
      if (existsSync(join(cur, ".git"))) break;
      const up = dirname(cur);
      if (up === cur) break;
      cur = up;
    }
  }
  return [...seen];
}

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
