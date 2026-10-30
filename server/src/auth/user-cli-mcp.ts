// 个人 CLI 配置目录里的 ash MCP 登记 —— 隔离档下必须补的一位。
//
// 为什么非补不可:agent 交卷靠 ash MCP 的 `complete_task`,而那条登记是安装时用
// `claude mcp add ash --scope user` 写进**宿主机** `~/.claude.json` 的。隔离档起跑时
// 注入 `CLAUDE_CONFIG_DIR`,claude **整个取代** `~/.claude` 且不回落(user-cli.ts 顶部),
// 于是 agent 手上压根没有 `complete_task`。
// 2026-09-01 现场(任务 QeKaxh9q):活干完了、代码也提交了,最后一步
// `mcp__ash__complete_task` 撞回一句 "No such tool available",按完成协议记 failed ——
// 而界面上只看得到「失败」,看不出是工具不存在。README 早写着「未接入 MCP 的 agent
// 无法交卷,所有任务将显示为失败」,隔离档等于在用户不知情的情况下把一台**已经接入**的
// 实例退回了那个状态。
//
// codex 侧同源、且更隐蔽:宿主 `~/.codex/config.toml` 有 `[mcp_servers.ash]`,而个人
// `CODEX_HOME` 里连 `config.toml` 都没有,`codexAshMcpServerName()` 于是返回 null ——
// 丢的不只是工具,连回合身份 `env_vars` 都跟着不注了。
//
// 边界,两条:
//  · **只搬 ash 这一条**,不搬宿主的其它 mcpServers。隔离档的意义是抹去宿主的订阅和
//    凭证,把别人的 server 一起搬过去就把那层意义破坏了;ash 自己这条是**完成协议的
//    一部分**,不是用户装的第三方能力。
//  · **已有登记一律不覆盖**(含历史名 `harness`)——用户可能自己改过 URL 或路径。
//
// 幂等,所以挂在 `ensureUserCliDir()` 上每次起跑都过一遍:已经有了就是两次文件读,
// 缺了才写。写一律走临时文件 + rename —— 这份 `.claude.json` 同时也是 CLI 自己在写的
// 文件,半截内容比缺一条登记更糟。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PersonalAshMcp } from "@ash/shared";
import { ASH_MCP_SERVER_NAME, LEGACY_ASH_MCP_SERVER_NAME } from "@ash/shared/mcp";
import { extractTomlTables, scanCodexToml } from "../codex-toml.js";
import { resolveLaunch } from "../executors/bin-resolve.js";

export { extractTomlTables } from "../codex-toml.js";
import { currentListeningPort } from "../listening-port.js";
import { REPO_DIR } from "../paths.js";

/** 本仓库这份 MCP 服务的入口。宿主没登记过时按它现拼一条。 */
const MCP_ENTRY = join(REPO_DIR, "mcp", "dist", "index.js");

const NO_SOURCE =
  `宿主机的配置里没有 ash MCP，仓库里也没有 ${MCP_ENTRY}(先在仓库根跑一次 npm run build，` +
  `或按 docs/install.md 走一遍 MCP 接入)`;

const ok = (serverName: string): PersonalAshMcp => ({ configured: true, serverName, problem: null });
const fail = (problem: string): PersonalAshMcp => ({ configured: false, serverName: null, problem });

/**
 * 这个个人配置目录里的 ash MCP 登记 —— **缺了就补**,补完把结果如实说出来。
 *
 * `hostHome` 只为回归测试留:产品代码永远用真 `homedir()`,测试拿一个假 HOME 来跑,
 * 免得测试碰宿主机那份 `~/.claude.json`(那是用户的真配置,一个字节都不该动)。
 */
export function ensureAshMcp(dir: string, agentType: string, hostHome: string = homedir()): PersonalAshMcp {
  try {
    if (agentType === "claude") return ensureClaudeAshMcp(dir, hostHome);
    if (agentType === "codex") return ensureCodexAshMcp(dir, hostHome);
    return fail(`${agentType} 没有个人配置目录，这一问不适用`);
  } catch (e) {
    return fail(`补写 ash MCP 登记失败：${(e as Error).message}`);
  }
}

/**
 * 同一个问题的**只读**版:看一眼,不补、不建、不写。
 *
 * 谁要它:「共用宿主机 CLI」那一档(§八之二)。那一档真正生效的是**宿主机**的配置目录,
 * 而宿主那份 `~/.claude.json` 是用户自己的配置 —— 检查可以,写一个字都不行。
 */
export function readAshMcp(dir: string, agentType: string): PersonalAshMcp {
  const found = ashMcpRegistration(dir, agentType);
  return found.state === "present" ? ok(found.serverName!) : fail(found.detail);
}

export type AshMcpRegistration = {
  /**
   * present=登记在且没关 / absent=确实没有 / disabled=登记在但写着 `enabled = false` /
   * unknown=读不出来，别据此下结论
   */
  state: "present" | "absent" | "disabled" | "unknown";
  serverName: string | null;
  detail: string;
};

/**
 * 同一个问题的**三态**版本。
 *
 * 为什么 `PersonalAshMcp` 那两态不够用：它把「确实没有登记」和「文件读不出来」一起记成
 * `configured:false`，只有文案能把它们分开。设置页拿它显示没问题 —— 两种都该提示用户去看
 * 一眼。但起跑前的预检要据此**拦下一整轮审查**，而拦错的代价是一条根本跑不起来的链，
 * 所以这两种必须分得开，由调用方自己决定向哪边开（预检一律向放行开，见
 * `ash-mcp-reachability.ts`）。
 */
export function ashMcpRegistration(dir: string, agentType: string): AshMcpRegistration {
  const none = (detail: string): AshMcpRegistration => ({ state: "absent", serverName: null, detail });
  const dunno = (detail: string): AshMcpRegistration => ({ state: "unknown", serverName: null, detail });
  const file = agentType === "claude" ? join(dir, ".claude.json")
    : agentType === "codex" ? join(dir, "config.toml")
    : null;
  if (!file) return dunno(`${agentType} 没有个人配置目录，这一问不适用`);
  // **先分清「没有这个文件」和「有但读不动」**：下面两条读取路径都把所有异常吞成
  // 「空」，于是一次 EACCES / EIO 会被说成「没有登记」（第 1 轮审查 N1）。absent 是个
  // 会被用来拦人的结论，只有确实没有文件才配得上它。
  const probe = fileState(file);
  if (probe === "unreadable") return dunno(`${file} 读不出来`);
  if (probe === "missing") return none(`${file} 还不存在`);
  try {
    if (agentType === "claude") {
      const doc = readJsonObject(file);
      // 解析不了 ≠ 没登记：文件可能正被 CLI 写到一半，也可能是用户手工改坏了一个花括号。
      if (!doc) return dunno(`${file} 解析不了`);
      const name = claudeServerName(doc);
      return name
        ? { state: "present", serverName: name, detail: "" }
        : none("这个配置目录里没有 ash MCP 登记");
    }
    // 和执行器注入（`codexAshMcpServerName`）读的是同一个扫描器，但这里要三态：注入那边只要
    // 「往哪个名字里塞」，这里还得分出「关着」与「扫描器没把握」—— 禁用的登记若被报成「在」，
    // 启动自检的快速通道会放过那道算得出「没启用」的 CLI 确认（新链第 1 轮审查第 2 条）。
    const scan = scanCodexToml(readFileSync(file, "utf8"));
    if (scan.doubt) return dunno(scan.doubt);
    const names = [...scan.servers.keys()];
    const live = names.find((n) => scan.servers.get(n)!.enabled);
    if (live) return { state: "present", serverName: live, detail: "" };
    if (names.length) {
      return {
        state: "disabled",
        serverName: names[0]!,
        detail: `${names.map((n) => `[mcp_servers.${n}]`).join("、")} 写着 enabled = false`,
      };
    }
    return none("这个配置目录里没有 ash MCP 登记");
  } catch (e) {
    return dunno(`读 ash MCP 登记失败：${(e as Error).message}`);
  }
}

/** 「没有这个文件」/「有但读不动」/「读得动」。判 absent 之前必须先过这一关（N1）。 */
function fileState(file: string): "missing" | "readable" | "unreadable" {
  try {
    readFileSync(file);
    return "readable";
  } catch (e) {
    return (e as { code?: string }).code === "ENOENT" ? "missing" : "unreadable";
  }
}

/**
 * 宿主机那份配置里的 ash MCP —— 共用档下 agent 真正用的就是它。
 *
 * claude 的用户级配置是 `~/.claude.json`(在 home 根,不在 `~/.claude` 里),codex 的是
 * `~/.codex/config.toml`;两条路径差一层,所以这里不能拿 home 当 dir 直接问。
 */
export function hostAshMcp(agentType: string, hostHome: string = homedir()): PersonalAshMcp {
  const dir = hostCliConfigDir(agentType, hostHome);
  return dir ? readAshMcp(dir, agentType) : fail(`${agentType} 没有宿主级配置目录，这一问不适用`);
}

/**
 * 宿主机上这个 CLI 真正读的配置目录。
 *
 * **必须尊重 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`**：那两个变量由 ash 进程原样继承给
 * 子进程，CLI 认的就是它们。写死 `homedir()` 会两头都错（第 1 轮审查 F1 的同类位置）——
 * 实际目录有登记却报缺失，默认目录有登记而实际目录没有时又漏报。
 *
 * 两个 CLI 的路径差一层：claude 的用户级配置是配置目录**根**下的 `.claude.json`，
 * codex 的是 `$CODEX_HOME/config.toml`。
 */
export function hostCliConfigDir(agentType: string, hostHome: string = homedir()): string | null {
  if (agentType === "claude") return process.env.CLAUDE_CONFIG_DIR?.trim() || hostHome;
  if (agentType === "codex") return process.env.CODEX_HOME?.trim() || join(hostHome, ".codex");
  return null;
}

/**
 * 宿主机上这个 CLI 的用户级配置文件在哪（跟着 `hostCliConfigDir` 走）。
 * 启动自检告警时拿它把路径指给用户（它不存在不代表 CLI 没装，见 `warnHostAshMcp`）。
 */
export function hostCliConfigFile(agentType: string, hostHome: string = homedir()): string | null {
  const dir = hostCliConfigDir(agentType, hostHome);
  if (!dir) return null;
  return agentType === "claude" ? join(dir, ".claude.json") : join(dir, "config.toml");
}

// ── claude:~/.claude.json 的 mcpServers ────────────────────────────────────

function ensureClaudeAshMcp(dir: string, hostHome: string): PersonalAshMcp {
  const file = join(dir, ".claude.json");
  const read = readForWrite(file);
  if (!read) return fail(`${file} 读不出来，没有自动补写 —— 修好它的权限再重启`);
  const doc = parseJsonObject(read.text);
  if (!doc) return fail(`${file} 解析不了，没敢动它 —— 手工修好或删掉它再重启`);
  const already = claudeServerName(doc);
  if (already) return ok(already);
  const entry = hostClaudeEntry(hostHome) ?? builtinClaudeEntry();
  if (!entry) return fail(NO_SOURCE);
  const servers = (doc.mcpServers ?? {}) as Record<string, unknown>;
  // 规范名落地:宿主那份即使是历史名 harness,定义搬过来也按 ash 登记(同一个 server,
  // setup 迟早要迁;两边都叫 ash 之后,提示词里那句「ash MCP」才对得上工具名)。
  doc.mcpServers = { ...servers, [ASH_MCP_SERVER_NAME]: entry };
  const why = writeVerified(read, `${JSON.stringify(doc, null, 2)}\n`, (written) => {
    const back = parseJsonObject(written);
    if (!back) return `补写完 ${file} 自己都解析不了`;
    return claudeServerName(back) ? null : `补写完 ${file} 里仍读不出 ash MCP 登记`;
  });
  return why ? fail(why) : ok(ASH_MCP_SERVER_NAME);
}

function claudeServerName(doc: Record<string, unknown>): string | null {
  const servers = doc.mcpServers as Record<string, unknown> | undefined;
  if (!servers || typeof servers !== "object") return null;
  if (servers[ASH_MCP_SERVER_NAME]) return ASH_MCP_SERVER_NAME;
  if (servers[LEGACY_ASH_MCP_SERVER_NAME]) return LEGACY_ASH_MCP_SERVER_NAME;
  return null;
}

/** 宿主机上那条(装 ash 时 `claude mcp add` 写下的)。读不出来就当没有。 */
function hostClaudeEntry(hostHome: string): unknown | null {
  const doc = readJsonObject(join(hostHome, ".claude.json"));
  if (!doc) return null;
  const servers = doc.mcpServers as Record<string, unknown> | undefined;
  if (!servers || typeof servers !== "object") return null;
  return servers[ASH_MCP_SERVER_NAME] ?? servers[LEGACY_ASH_MCP_SERVER_NAME] ?? null;
}

function builtinClaudeEntry(): unknown | null {
  if (!existsSync(MCP_ENTRY)) return null;
  return { type: "stdio", command: "node", args: [MCP_ENTRY], env: { ASH_URL: localUrl() } };
}

// ── codex:$CODEX_HOME/config.toml 的 [mcp_servers.*] ───────────────────────

function ensureCodexAshMcp(dir: string, hostHome: string): PersonalAshMcp {
  // 「有没有」跟读那一侧（`ashMcpRegistration`）问同一个扫描器。上一版用的是执行器注入
  // `env_vars` 的严格行首正则，认不出 `[mcp_servers."ash"]`、缩进表头，判成「没有」就再
  // append 一份 —— 同名表重复，codex 整份配置都读不出来（新链第 2 轮审查第 5 条）。
  // 所以只有扫描器**确定没有**时才写；关着的、看不准的都不碰，如实报出来。
  const file = join(dir, "config.toml");
  const read = readForWrite(file);
  if (!read) return fail(`${file} 读不出来，没有自动追加`);
  const current = read.text ?? "";
  const scan = scanCodexToml(current);
  if (scan.doubt) return fail(`看不准 ${file} 里有没有 ash MCP 登记（${scan.doubt}），没有自动追加，免得写出重复的表`);
  const names = [...scan.servers.keys()];
  const live = names.find((n) => scan.servers.get(n)!.enabled);
  if (live) return ok(live);
  if (names.length) {
    return fail(`${file} 里的 ${names.map((n) => `[mcp_servers.${n}]`).join("、")} 写着 enabled = false，没有替你打开`);
  }
  // **这张表还能不能用表头扩展**：我们唯一会写的东西就是追加一段 `[mcp_servers.ash]`，
  // 而整张表写成内联值之后 TOML 不许这么扩展 —— 照写进去 codex 整份拒载，用户别的 MCP
  // 一起加载不了（第 2 轮审查 F1 真机实测）。所以这一档只能如实报，让用户自己挑一种改法。
  if (scan.sealed) {
    return fail(
      `${file} 里 ${scan.sealed}，所以没有自动补写 —— 请在那个内联表里自己加一条 `
      + `${ASH_MCP_SERVER_NAME}，或者把它改写成 [mcp_servers.xxx] 的普通表写法再重启`,
    );
  }
  const block = hostCodexBlock(hostHome) ?? builtinCodexBlock();
  if (!block) return fail(NO_SOURCE);
  // 同一份原文 + 同一段要追加的内容,失败过一次就不再写第二遍:设置页每读一次都会走到这里,
  // 而「写进去 → 验不过 → 还原」每一轮都要动一次用户的配置文件(中间崩一次就把坏的留在
  // 那儿了)。任一段变了(用户改了自己的配置、宿主那条改好了)自然重试。
  const attempt = fingerprint(file, current, block);
  const failedBefore = failedWrites.get(attempt);
  if (failedBefore) return fail(failedBefore);
  const why = writeVerified(read, current.trim() ? `${current.trimEnd()}\n\n${block}\n` : `${block}\n`, (written) => {
    const back = scanCodexToml(written);
    // 搬过来的那段若带上游没想到的形状(表头、转义、值),扫描器自己都读不通 —— 那份文件
    // 现在就是 codex 也读不动的样子,说「已接好」等于把别的 MCP 一起弄没了。
    if (back.doubt) return `追加完 ${file} 自己都读不通了（${back.doubt}）`;
    if (!back.servers.get(ASH_MCP_SERVER_NAME)?.enabled) {
      return `追加完 ${file} 里仍读不出启用着的 [mcp_servers.${ASH_MCP_SERVER_NAME}]`;
    }
    const real = codexReads(dir);
    return real.state === "bad" ? `${real.why}，没敢留下这次追加` : null;
  });
  if (why) failedWrites.set(attempt, why);
  return why ? fail(why) : ok(ASH_MCP_SERVER_NAME);
}

/** 写失败过的「原文 + 要追加的那段」指纹 → 当时的原因。见 `ensureCodexAshMcp` 里那段注释。 */
const failedWrites = new Map<string, string>();

const fingerprint = (file: string, current: string, block: string): string =>
  createHash("sha256").update(`${file}\u0000${current}\u0000${block}`).digest("hex");

/** 问 codex 本人花多久算问不动。它只是个只读子命令，本机实测几百毫秒。 */
const CODEX_READ_MS = 10_000;

/**
 * 把补写完的文件交给 **codex 本人**解析一遍 —— 「这份 TOML 合不合法」只有它说了算
 * （第 2 轮审查 F1）。
 *
 * 为什么不能只拿我们自己的扫描器复核：它是个**结构**扫描器，看得出新表头落进了文件里，
 * 证不了这个表头在这份 TOML 上**合法**。`sealed` 把实测到的那一种挡在写之前了，但那是
 * 枚举；这一问才是真实解析。`scripts/codex-mcp.mjs` 里 setup 那条路也是这么问的，两边
 * 对「什么叫真的读通了」只有一个答案。
 *
 * `cwd` 刻意设成这个配置目录自己：`codex mcp list` 会把**项目级** `.codex/config.toml`
 * 合进来，在仓库里问的话，别人项目配置里的毛病会算到这次补写头上（白白还原一份好文件），
 * 项目里的 ash 登记又会给一份其实没写成的配置背书。
 *
 * 问不动（没解析到 codex、起不来、超时、输出看不懂）**不算失败**：那时只能退回扫描器
 * 那一档，不拿「问不出来」去还原一份可能是好的文件。
 */
function codexReads(dir: string): { state: "ok" | "bad" | "unasked"; why: string } {
  const plan = resolveLaunch("codex", ["mcp", "list", "--json"]);
  if (!plan) return { state: "unasked", why: "这台机器上没解析出 codex 的启动方式" };
  const res = spawnSync(plan.file, plan.args, {
    cwd: dir,
    encoding: "utf8",
    windowsHide: true,
    timeout: CODEX_READ_MS,
    env: { ...process.env, CODEX_HOME: dir },
    // Windows 上 `codex` 是 `.cmd` 垫片,`resolveLaunch` 给的是 `cmd.exe /d /s /c "..."`
    // 那一套 —— **这个开关必须跟着传**,不传 Node 会把那串参数再引号化一遍,cmd 找不到
    // 命令、退 1(Windows 真机上就是这么红的:STDERR 回了一整串带引号的命令行)。
    ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true as const } : {}),
  });
  if (res.error || res.signal) {
    return { state: "unasked", why: `codex mcp list 没跑成（${res.error?.message ?? res.signal}）` };
  }
  if (res.status !== 0) {
    const said = `${res.stderr ?? ""}\n${res.stdout ?? ""}`.split("\n").map((l) => l.trim())
      .filter(Boolean).slice(0, 3).join(" / ");
    return { state: "bad", why: `codex 读不动补写之后的配置（退出码 ${res.status}）：${said}` };
  }
  let listed: unknown;
  try { listed = JSON.parse(res.stdout ?? ""); } catch { return { state: "unasked", why: "codex mcp list 的输出看不懂" }; }
  if (!Array.isArray(listed)) return { state: "unasked", why: "codex mcp list 的输出不是列表" };
  const hit = listed.find((e) => (e as { name?: unknown } | null)?.name === ASH_MCP_SERVER_NAME) as
    { enabled?: unknown } | undefined;
  if (!hit) return { state: "bad", why: `codex 读完补写之后的配置，仍然没列出 ${ASH_MCP_SERVER_NAME}` };
  if (hit.enabled === false) return { state: "bad", why: `codex 说补写之后的 ${ASH_MCP_SERVER_NAME} 是关着的` };
  return { state: "ok", why: "" };
}

function hostCodexBlock(hostHome: string): string | null {
  const config = readTextOrEmpty(join(hostHome, ".codex", "config.toml"));
  if (!config) return null;
  return (
    extractTomlTables(config, ASH_MCP_SERVER_NAME) ??
    // 历史名的定义照搬,但表头改成规范名(理由同 claude 那边)。
    extractTomlTables(config, LEGACY_ASH_MCP_SERVER_NAME, ASH_MCP_SERVER_NAME)
  );
}

function builtinCodexBlock(): string | null {
  if (!existsSync(MCP_ENTRY)) return null;
  return (
    `[mcp_servers.${ASH_MCP_SERVER_NAME}]\n` +
    `command = "node"\n` +
    `args = [${JSON.stringify(MCP_ENTRY)}]\n\n` +
    `[mcp_servers.${ASH_MCP_SERVER_NAME}.env]\n` +
    `ASH_URL = ${JSON.stringify(localUrl())}\n`
  );
}

// ── 小工具 ────────────────────────────────────────────────────────────────

const localUrl = () => `http://127.0.0.1:${currentListeningPort() ?? 4317}`;

/** 只读用:读不动、解析不了都是 null(调用方当「没有」或「判不了」)。 */
function readJsonObject(file: string): Record<string, unknown> | null {
  const read = readForWrite(file);
  return read ? parseJsonObject(read.text) : null;
}

/** `null` 文本 = 确认没有这个文件 → 空文档(我们来建);解析不了 = null(**别动它**,上层如实报错)。 */
function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (raw === null || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readTextOrEmpty(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * 一次**成功**的读:`text === null` = 确认没有这个文件(ENOENT)。读不动(权限、IO、是个目录)
 * 返回 null —— 那不是「空」,拿它当空去写,就是一份只剩 MCP 登记的新文件把用户的整份配置
 * 盖掉,界面还报「已接好」(新链第 5 轮审查第 1 条:claude 那半边就是这么丢的)。
 */
type ConfirmedRead = { readonly file: string; readonly text: string | null; readonly __confirmed: true };

function readForWrite(file: string): ConfirmedRead | null {
  try {
    return { file, text: readFileSync(file, "utf8"), __confirmed: true };
  } catch (e) {
    return (e as { code?: string }).code === "ENOENT" ? { file, text: null, __confirmed: true } : null;
  }
}

/**
 * 同目录临时文件 + rename:CLI 自己也在写这份文件,不能让它读到半截。
 * 只收 `readForWrite` 的结果 —— 「写之前必须拿到一次成功的读」由类型钉住,不靠各分支自己记。
 */
function writeAtomic(read: ConfirmedRead, body: string): void {
  const file = read.file;
  const tmp = `${file}.ash-tmp`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, file);
}

/**
 * 写 + **自己再读一遍** + 验不过就原样还回去。
 *
 * 为什么不能写完就报「已接好」:补进去的那段是**搬来的**(宿主那份配置里的 `[mcp_servers.ash]`,
 * 连注释、奇怪的表头和转义一起搬),拼完的文件未必还读得通。读不通的 config.toml 对 codex 是
 * 整份拒载 —— 用户别的 MCP 一起没了,而界面上写着「已接好」。
 *
 * `verify` 返回 null = 验过了;返回一句话 = 哪里不对(文件已被还原,这句话会原样报给用户)。
 */
function writeVerified(read: ConfirmedRead, body: string, verify: (written: string) => string | null): string | null {
  writeAtomic(read, body);
  const after = readForWrite(read.file);
  const why = !after || after.text === null ? `补写完 ${read.file} 又读不出来` : verify(after.text);
  if (!why) return null;
  try {
    // 原来没有这个文件就删掉:别留一份自己都读不动的残骸在那挡着 CLI。
    if (read.text === null) rmSync(read.file, { force: true });
    else writeAtomic(read, read.text);
  } catch (e) {
    return `${why}；还原也失败了（${(e as Error).message}），请手工检查 ${read.file}`;
  }
  return `${why}，已把它还原成补写前的样子`;
}
