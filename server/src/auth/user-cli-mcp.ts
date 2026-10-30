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
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PersonalAshMcp } from "@ash/shared";
import { ASH_MCP_SERVER_NAME, LEGACY_ASH_MCP_SERVER_NAME } from "@ash/shared/mcp";
import { probeCli, type ProbeOutcome } from "../ash-mcp-probe.js";
import { extractTomlTables, scanCodexToml } from "../codex-toml.js";

export { extractTomlTables } from "../codex-toml.js";
import { currentListeningPort } from "../listening-port.js";
import { DATA_DIR, REPO_DIR } from "../paths.js";

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
 *
 * **为什么是 async**:codex 那半边要把候选配置交给 codex 本人解析一遍才敢发布,而那一次
 * 子进程必须走探测执行层(异步、带归属、收得回来),不能在事件循环里同步 spawn
 * (本轮审查 F2)。`ask` 同样只为回归测试留 —— macOS 上探测层如实弃权,那几条路在开发机上
 * 一条都跑不了,所以测试拿一个替身把它们逐个驱动起来(理由同 `probeCli` 的 `openUnit`)。
 */
export async function ensureAshMcp(
  dir: string,
  agentType: string,
  hostHome: string = homedir(),
  ask: CodexAsk = askCodexHere,
): Promise<PersonalAshMcp> {
  try {
    if (agentType === "claude") return await ensureClaudeAshMcp(dir, hostHome);
    if (agentType === "codex") return await ensureCodexAshMcp(dir, hostHome, ask);
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

async function ensureClaudeAshMcp(dir: string, hostHome: string): Promise<PersonalAshMcp> {
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
  const why = await publishApproved(read, `${JSON.stringify(doc, null, 2)}\n`, async (candidate) => {
    // 这半边的「真解析器」就在手上:`.claude.json` 的语义全在 JSON 语法里,`JSON.parse`
    // 认了就是 claude 也认(内容还是我们自己 stringify 出来的)。codex 那半边不一样 ——
    // TOML 的判官住在 codex 进程里,所以那边必须问它本人(见 `codexAccepts`)。
    const back = parseJsonObject(candidate);
    if (!back) return `补上那条之后 ${file} 自己都解析不了`;
    return claudeServerName(back) ? null : `补上那条之后 ${file} 里仍读不出 ash MCP 登记`;
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

async function ensureCodexAshMcp(dir: string, hostHome: string, ask: CodexAsk): Promise<PersonalAshMcp> {
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
  const body = current.trim() ? `${current.trimEnd()}\n\n${block}\n` : `${block}\n`;
  // 同一份原文 + 同一段要追加的内容,没通过一次就不再问第二遍:设置页每读一次、每条任务
  // 起跑都会走到这里,而问 codex 本人要起一次进程。任一段变了(用户改了自己的配置、宿主
  // 那条改好了)自然重试。
  const attempt = fingerprint(file, current, block);
  const failedBefore = failedWrites.get(attempt);
  if (failedBefore) return fail(failedBefore);
  const why = await publishApproved(read, body, async (candidate) => {
    // 先过自己这道:便宜,而且说得出具体哪里不对。但它**只是预筛** —— 判官在下一句。
    const back = scanCodexToml(candidate);
    if (back.doubt) return `补上那段之后 ${file} 自己都读不通了（${back.doubt}）`;
    if (!back.servers.get(ASH_MCP_SERVER_NAME)?.enabled) {
      return `补上那段之后仍读不出启用着的 [mcp_servers.${ASH_MCP_SERVER_NAME}]`;
    }
    const verdict = await codexAccepts(candidate, ask);
    return verdict.state === "ok" ? null : `${verdict.why}${byHand(file, block)}`;
  });
  if (why) failedWrites.set(attempt, why);
  return why ? fail(why) : ok(ASH_MCP_SERVER_NAME);
}

/**
 * 没补接成功时给的办法。**必须带上那段内容** —— 问不动 codex 的机器（macOS 上探测层如实
 * 弃权，见 `codexAccepts`）从此一律不自动补接，只剩这条路能让 agent 交得了卷。
 */
const byHand = (file: string, block: string): string =>
  `，所以没有替你写进去（你那份配置一个字节都没动）。要手工接的话，把这段加到 ${file} 末尾：\n${block}`;

/** 问一次 codex 本人:给它一个只放着候选配置的 `CODEX_HOME`。**测试会换成替身**(见 `ensureAshMcp`)。 */
export type CodexAsk = (sandbox: string) => Promise<ProbeOutcome>;

/** 问 codex 本人花多久算问不动。它只是个只读子命令,本机实测几百毫秒。 */
const CODEX_ASK_MS = 10_000;

const askCodexHere: CodexAsk = (sandbox) => probeCli(
  "codex",
  ["mcp", "list", "--json"],
  { ...process.env, CODEX_HOME: sandbox },
  // `cwd` 刻意也设成沙盘:`codex mcp list` 会把**项目级** `.codex/config.toml` 合进来,
  // 在仓库里问的话,别人项目配置里的毛病会算到这份候选头上,项目里的 ash 登记又会给一份
  // 其实不成立的候选背书。
  sandbox,
  CODEX_ASK_MS,
);

/**
 * 把**候选内容**交给 codex 本人解析一遍 —— 「这份 TOML 合不合法」只有它说了算。
 *
 * 为什么不能只拿我们自己的扫描器复核:它是个**结构**扫描器,看得出新表头落进了文件里,
 * 证不了这个表头在这份 TOML 上**合法**。`sealed` 把实测到的那一种挡在写之前了,但那是枚举;
 * 这一问才是真实解析。`scripts/codex-mcp.mjs` 里 setup 那条路也是这么问的,两边对「什么叫
 * 真的读通了」只有一个答案。
 *
 * 本轮审查改了两件事:
 *  ① **问的是沙盘里的一份副本,不是用户那个文件**(F1)。上一版先把候选写进用户的
 *    `config.toml` 再问,验不过才还原 —— 那期间盘上躺着的是一份 codex 整份拒载的配置
 *    (中间崩一次就留在那儿了),而还原本身又是第二次写,会盖掉别人同时存下的设置(N5)。
 *    候选和要发布的内容逐字节相同,而「这份 TOML 读不读得通」只取决于内容,所以沙盘里
 *    问出来的结论照样算。
 *  ② **走探测执行层**(`probeCli`),不自己 spawn(F2)。那是这台机器上唯一保证「起了进程
 *    就收得回来」的路:异步(不堵事件循环)、启动前先拿到内核圈定的归属、每条结束路径都
 *    现读成员集合下刀。上一版用的是 `spawnSync`,Windows 真机实测包装退出之后那个查询还
 *    活着(PID 25544 / 18208),而同步调用期间整个 server 的事件循环被堵满十秒。
 *
 * **「问不出来」不等于「可以发布」**(F1 的本体):超时、起不来、输出看不懂一律答 `unasked`,
 * 调用方据此**不发布**。拿不到安全归属的机器(macOS 弃权)于是一律不自动补接,改走
 * `byHand` 那条 —— 宁可如实说「没接上,这段你手工加」,也不留一份没人证过的配置,
 * 让 codex 连别人的 MCP 一起加载不了。
 */
async function codexAccepts(
  candidate: string,
  ask: CodexAsk,
): Promise<{ state: "ok" | "bad" | "unasked"; why: string }> {
  // 沙盘放 **ash 自己的数据目录**,不放系统临时目录:Windows 真机实测 codex 看见
  // `CODEX_HOME` 落在 `%TEMP%` 下会先喊一句「拒绝在临时目录里建 PATH 别名」(那一句会
  // 原样进到报给用户的那段话里),换个普通目录就没有这层噪音,残留也看得见、扫得掉。
  const asks = join(DATA_DIR, "tmp");
  mkdirSync(asks, { recursive: true });
  const sandbox = mkdtempSync(join(asks, "ash-mcp-ask-"));
  try {
    writeFileSync(join(sandbox, "config.toml"), candidate, "utf8");
    const outcome = await ask(sandbox);
    if (outcome.kind === "not-started") {
      return { state: "unasked", why: `这台机器上没法安全地起一次 codex 来确认这份配置读得通（${outcome.why}）` };
    }
    if (outcome.kind === "unqueryable") return { state: "unasked", why: "问了 codex，但它没给出一份能用的答案" };
    if (outcome.code !== 0) {
      const said = `${outcome.stderr}\n${outcome.stdout}`.split("\n").map((l) => l.trim())
        .filter(Boolean).slice(0, 3).join(" / ");
      return { state: "bad", why: `codex 读不动补上那段之后的配置（退出码 ${outcome.code}）：${said}` };
    }
    let listed: unknown;
    try { listed = JSON.parse(outcome.stdout); } catch { return { state: "unasked", why: "codex mcp list 的输出看不懂" }; }
    if (!Array.isArray(listed)) return { state: "unasked", why: "codex mcp list 的输出不是列表" };
    const hit = listed.find((e) => (e as { name?: unknown } | null)?.name === ASH_MCP_SERVER_NAME) as
      { enabled?: unknown } | undefined;
    if (!hit) return { state: "bad", why: `codex 读完这份配置，仍然没列出 ${ASH_MCP_SERVER_NAME}` };
    if (hit.enabled === false) return { state: "bad", why: `codex 说这份配置里的 ${ASH_MCP_SERVER_NAME} 是关着的` };
    return { state: "ok", why: "" };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/** 写失败过的「原文 + 要追加的那段」指纹 → 当时的原因。见 `ensureCodexAshMcp` 里那段注释。 */
const failedWrites = new Map<string, string>();

const fingerprint = (file: string, current: string, block: string): string =>
  createHash("sha256").update(`${file}\u0000${current}\u0000${block}`).digest("hex");

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
 * **先批准,再替换**:没批准的内容一个字节都不会落到用户那份配置上。
 *
 * 顺序是本轮审查 F1 改的。上一版是「写进去 → 读回来 → 验不过再还原」,两头都踩过:
 *  · 验的那一问本身可能答不出来(没解析到 CLI、超时、输出看不懂),上一版把这些当成
 *    「可以留着」—— 实测:搬来的那段带一个非法转义,`codex mcp list` 成功退出但输出不是
 *    JSON,于是落盘留下一份 codex **整份拒载**的配置,界面上写着「已接好」;
 *  · 还原本身是第二次写:写完到还原之间崩一次,坏文件就留在那儿了;而且它会把别人同时
 *    存下的新设置一起盖掉(本轮 N5)。
 *
 * `approve` 返回 null = 这份内容可以发布;返回一句话 = 哪里不对(文件没被动过,这句话原样
 * 报给用户)。
 */
async function publishApproved(
  read: ConfirmedRead,
  body: string,
  approve: (candidate: string) => Promise<string | null>,
): Promise<string | null> {
  const why = await approve(body);
  if (why) return why;
  writeAtomic(read, body);
  // 落盘之后只确认一件事:盘上现在就是我们批准的那份。不一样说明有别的程序也在写这个
  // 文件 —— 如实报,不去抢着再写一遍。
  const after = readForWrite(read.file);
  if (!after || after.text !== body) {
    return `写完 ${read.file} 读回来跟刚批准的那份不一样（有别的程序也在写它？），请手工检查一遍`;
  }
  return null;
}
