// 「这一轮起跑之后，agent 手上会不会有 ash MCP」—— 派审前的那道预检。
//
// 2026-10-28 现场：一位用户的 codex 审查者跑满 35 分钟、报告完整落盘，最后一句是
// 「当前未提供 report_stage 工具，无法实际上报 verify_failed」。ash 这边只写了一句
// 「未能正常给出结论，已停止自动链」。真相是那次会话里 ash MCP 整组工具都不在 ——
// codex 的 ash MCP 来自它自己的 `config.toml`，起不来时只往 stderr 写一行、退出码
// 照样 0，ash 这边一无所知，于是 35 分钟和 5.81M token 一起作废。
//
// ── 判据：问 CLI 自己，不读配置文件 ─────────────────────────────────────────
//
// 第 1 版读配置文件，被第 1 轮审查用真实 CLI 打穿（F1/F2）：**一份配置文件里没有，
// 不等于这一轮的 CLI 没有工具**。实测反例三个，每个都会让本来能跑的审查被拒：
//   · `CLAUDE_CONFIG_DIR` 指向别处（`claude mcp get ash` 说 Connected，预检说没有）
//   · claude 的**项目级**登记（`--scope local`，住在 `projects[cwd].mcpServers`）
//   · codex 的 `-c mcp_servers.ash.command=…` 命令行覆盖
// 以及 TOML 不是正则能判的：`[mcp_servers."ash"]`、表头带缩进、**另一个** server 的
// 表头带行尾注释（扫描停不下来，把别人的 `enabled = false` 算到 ash 头上）。
//
// 所以这一版不自己解析配置,而是**用 CLI 自己的子命令去问**,把目录合并、项目级作用域、
// 命令行覆盖、TOML 语义这些全交给它:
//   · claude → `claude mcp get ash`(有登记 rc=0;没有 rc=1 且说 No MCP server named)
//   · codex  → `codex mcp list --json`(直接给 `enabled` 布尔和 `disabled_reason`)
// 两条都带上**这一轮真正要用的** env(含注入的 CLAUDE_CONFIG_DIR / CODEX_HOME)、cwd
// 和 mcp 相关的 `-c` 覆盖参数,与真实起跑同源。
//
// ── 目录:问一组,不猜哪一个 ─────────────────────────────────────────────────
//
// claude 的项目级登记只在特定目录下可见,所以探测得在「这一轮会跑的那个目录」里做。
// 第 2 版去照抄 orchestrator 挑目录的那条 `||` 链,又被第 2 轮审查打穿(F1):那条链跟真货
// 还有三处分歧(诊断会话没过滤、没有显式 `resumeSessionId` 时的 prev 选择、失效目录的
// 回退方式),每一处都够拦掉一轮本来能跑的审查。而真正的解析没法共用 —— 它跟 prev 的
// 选择绑在一起,中途还写库,预检必须只读且排在它前面。
//
// 所以这一版不猜了:**把它可能选中的目录全问一遍,任一有登记就放行**。拦人只发生在
// 「整个超集都说没有」时,那才是个确定的结论,也跟 orchestrator 以后怎么改选法无关。
//
// 判据只有一条硬规矩:**向放行开**。拦错一轮审查,用户得到的是一条根本跑不起来的链;
// 放过一轮,最差也只是回到今天的样子(跑完没结论,由 `review-channel-gap.ts` 如实说明
// 原因)。所以只有 CLI 自己明确说「没有这个 server」「它被禁用了」才拦 —— 命令跑不起来、
// 超时、输出看不懂、执行器带了判不了的覆盖参数,一律放行。
import { existsSync } from "node:fs";
import type { AgentType } from "@ash/shared";
import { ASH_MCP_SERVER_NAME, LEGACY_ASH_MCP_SERVER_NAME } from "@ash/shared/mcp";
import { probeCli } from "./ash-mcp-probe.js";
import { executorOwnerScope } from "./auth/dispatch-gate.js";
import { runEnvForOwner } from "./auth/run-env.js";
import { cliSpec } from "./executors/catalog/index.js";
import { effectiveExecutorContext } from "./executors/index.js";
import { resolveLaunch } from "./executors/bin-resolve.js";

/** 探测是只读子命令（claude 实测 ~0.8s、codex ~0.01s）；超时一律按「问不出来」放行。 */
const PROBE_TIMEOUT_MS = 15_000;

export interface AshMcpReach {
  /** false 只在**确定拿不到**时出现；任何不确定都是 true */
  reachable: boolean;
  /** reachable=false 时写给用户的一句话（已含自查办法） */
  problem: string | null;
}

export interface AshMcpReachQuery {
  ownerUserId?: string | null;
  agentType: string;
  /** 这一轮要用的执行器 profile（`agents.id`）。它的 extraArgs 可能改写 MCP 登记。 */
  executorId?: string | null;
  /**
   * 这一轮**可能**跑在哪些目录里 —— 要的是**超集**，不是「哪一个」。每个都会被问一遍,
   * 任一说有登记就放行(见 `probeDirs` 那段)。调用方怎么凑出这个超集见
   * `free-review-round.ts` 的 `reviewCwdCandidates`。
   *
   * 为什么要给目录:claude 的**项目级**登记(`--scope local`)只在那个目录下看得见。
   * 第 1 版压根没传,`execFile` 继承了 **server 进程**的目录,在任务目录里接好的 claude
   * 被判成「没有登记」,派审当场失败(第 2 位审查者 F1)。
   */
  cwdCandidates?: string[];
}

const ok = (): AshMcpReach => ({ reachable: true, problem: null });

const HOW_TO_CHECK: Record<string, string> = {
  claude: "claude mcp get ash",
  codex: "codex mcp list --json（看 ash 在不在、enabled 是不是 true）",
};

const WANTED = [ASH_MCP_SERVER_NAME, LEGACY_ASH_MCP_SERVER_NAME];

/** CLI 自己给的答案。`unknown` = 问不出来，调用方必须放行。 */
type Verdict =
  | { state: "present" | "unknown" }
  | { state: "absent" }
  | { state: "disabled"; detail: string };

/**
 * extraArgs 里跟 mcp 登记有关的 `-c` / `--config` 覆盖，原样带给探测命令。
 * codex 的 `mcp list` 吃同一批 `-c`（实测：`-c mcp_servers.ash.command="node"` 之后
 * `mcp list --json` 就列出 ash），所以带上它们，探测结果才跟真实起跑一致。
 */
function codexMcpOverrides(extraArgs: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < extraArgs.length; i++) {
    const arg = extraArgs[i]!;
    const inline = /^(?:-c|--config)=(.*)$/.exec(arg);
    if (inline) {
      if (inline[1]!.startsWith("mcp_servers")) out.push(arg);
      continue;
    }
    if (arg !== "-c" && arg !== "--config") continue;
    const value = extraArgs[i + 1];
    if (value === undefined) continue;
    i++;
    if (value.startsWith("mcp_servers")) out.push(arg, value);
  }
  return out;
}

/** claude 这边没有「把覆盖参数也带上去问」的办法，只能认出来然后放行。 */
const CLAUDE_MCP_OVERRIDE = /^--(?:mcp-config|strict-mcp-config)(?:=|$)/;

/**
 * claude：`mcp get <name>` 有登记 rc=0、没有 rc=1 并写明 `No MCP server named`。
 * 刻意不用 `mcp list` —— 它会**真的去连每一个** server（实测含远程 HTTP 的那种），
 * 一次预检不该有这种副作用。
 */
async function askClaude(bin: string, env: NodeJS.ProcessEnv, cwd: string | undefined): Promise<Verdict> {
  let sawNoSuchServer = false;
  for (const name of WANTED) {
    const res = await probeCli(bin, ["mcp", "get", name], env, cwd, PROBE_TIMEOUT_MS);
    if (!res) return { state: "unknown" };
    if (res.code === 0) return { state: "present" };
    // 文本判定两个通道都看：这句话落在哪一路由 CLI 版本决定，而它只是「有没有这个
    // server」的证词，不像 JSON 那样会被别的输出带坏。
    if (/No MCP server named/i.test(`${res.stdout}\n${res.stderr}`)) { sawNoSuchServer = true; continue; }
    return { state: "unknown" };                     // rc≠0 但不是「没有这个 server」：另有问题，不归这里答
  }
  return sawNoSuchServer ? { state: "absent" } : { state: "unknown" };
}

/** codex：`mcp list --json` 的 `enabled` / `disabled_reason` 就是它自己的结论。 */
async function askCodex(
  bin: string,
  overrides: string[],
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
): Promise<Verdict> {
  const res = await probeCli(bin, [...overrides, "mcp", "list", "--json"], env, cwd, PROBE_TIMEOUT_MS);
  if (!res || res.code !== 0) return { state: "unknown" };
  // **只解析 stdout**：stderr 的警告不是答案的一部分（第 2 位审查者 F3）。
  let parsed: unknown;
  try { parsed = JSON.parse(res.stdout.trim()); } catch { return { state: "unknown" }; }
  if (!Array.isArray(parsed)) return { state: "unknown" };
  const rows = parsed.filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
  const mine = rows.filter((r) => typeof r.name === "string" && WANTED.includes(r.name));
  if (!mine.length) return { state: "absent" };
  // **任一兼容登记能用，就不算拿不到**。两个名字是同一个东西的新旧叫法，codex 会把两份
  // 都列出来、都接起来。上一版只看排在前面的那一份，于是「新名那份被关掉、旧名那份还
  // 连着」会被整轮拒掉 —— 第 3 轮审查在真机上让 codex app-server 列出了 harness 的
  // report_stage，派审仍然 409。所以结论必须下在**集合**上，不是第一项上。
  if (mine.some((r) => r.enabled !== false)) return { state: "present" };
  const detail = mine.map((r) => {
    const why = typeof r.disabled_reason === "string" && r.disabled_reason.trim()
      ? r.disabled_reason.trim()
      : "enabled = false";
    return `[mcp_servers.${String(r.name)}]（${why}）`;
  }).join("、");
  return { state: "disabled", detail: `codex 自己报告这些 ash MCP 登记都没启用：${detail}` };
}

/** 一次预检最多问几个目录。见 `probeDirs` 里为什么截断是安全的。 */
const MAX_PROBE_DIRS = 8;

/**
 * 把候选超集收成「真要去问的那几个目录」。
 *
 * **滤掉不存在的目录不会漏掉真实运行目录**，这点要能论证：orchestrator 的 `recorded`
 * 取第一个**非空**候选（不是第一个存在的），紧接着 `if (!existsSync(cwd))` 就回退
 * `taskWorkspace()`，而 `launchReviewRound` 在预检之前已经 `await taskWorkspace(...)`
 * 把工作区 materialize 出来、把它的 path 放进了候选 —— 所以它一定活着、一定在这张表里。
 * 换句话说：真实运行目录 ∈ {存在的候选}，不存在的那些 orchestrator 自己也不会用。
 *
 * `complete=false` 表示这张表没问全（目录多到被截断）。那时「全都说没有」不再是确定
 * 的结论，调用方必须放行 —— 宁可回到「跑完没结论、由 review-channel-gap 说明原因」。
 *
 * 一个都不剩时问一次「不指定目录」（execFile 继承 server 的目录，只看得见用户级登记）：
 * 启动自检 `hostAshMcpMissing` 走的就是这条，它问的本来就是宿主默认配置。
 */
function probeDirs(candidates: string[]): { dirs: (string | undefined)[]; complete: boolean } {
  const alive: string[] = [];
  for (const dir of candidates) {
    if (!alive.includes(dir) && existsSync(dir)) alive.push(dir);
  }
  if (!alive.length) return { dirs: [undefined], complete: true };
  return { dirs: alive.slice(0, MAX_PROBE_DIRS), complete: alive.length <= MAX_PROBE_DIRS };
}

/**
 * 这条任务下一轮起跑时，它的 agent 够不够得着 ash MCP。
 *
 * 只认 claude / codex：别的执行器的 MCP 登记不经 ash 的手（`scripts/setup.mjs` 也只管
 * 这两个加 kimi），对它们一律放行 —— 「ash 不知道」不等于「它没有」。
 */
/**
 * 判据本体：给定**一份已经确定下来的**执行上下文（类型 + 归一后的 extraArgs + 可能的
 * 目录），问 CLI 自己够不够得着 ash MCP。
 *
 * 上下文从哪来由调用方决定，而那正是两种语义的分界：派审门禁给的是**这条任务的有效
 * 执行器**（走 `effectiveExecutorContext`），启动诊断给的是**宿主默认上下文**（什么都
 * 不带）。第 3 轮审查特别要求别把后者偷偷改成前者 —— 启动日志说的是「这台机器默认
 * 配置下」，它不该因为某个默认 profile 带了 `-c mcp_servers.…` 就改口。
 */
async function reachWith(
  agentType: string,
  extraArgs: string[],
  cwdCandidates: string[],
  ownerUserId: string | null,
): Promise<AshMcpReach> {
  if (agentType !== "claude" && agentType !== "codex") return ok();
  if (agentType === "claude" && extraArgs.some((a) => CLAUDE_MCP_OVERRIDE.test(a))) return ok();

  let bin: string | null = null;
  let env: NodeJS.ProcessEnv;
  try {
    // 命令名交给 resolveLaunch 去解析（它内部走 resolveBin，再决定怎么起）——
    // 这里只负责挑出「这台机器上有的那个候选名」。
    for (const candidate of cliSpec(agentType).bins) {
      if (resolveLaunch(candidate, [])) { bin = candidate; break; }
    }
    // 起跑要用的那一份 env（隔离档下带 CLAUDE_CONFIG_DIR / CODEX_HOME）。宿主机自己
    // 设的那两个变量由 process.env 原样继承 —— 真实 spawn 也是这么继承的。
    env = { ...process.env, ...(await runEnvForOwner(ownerUserId, agentType)) };
  } catch {
    return ok();
  }
  if (!bin) return ok();                             // CLI 都不在这台机器上，派审会以别的方式失败

  const { dirs, complete } = probeDirs(cwdCandidates);

  // 逐个问:present / unknown 任一出现就放行,只有**全都**说拿不到才往下走。
  const overrides = agentType === "codex" ? codexMcpOverrides(extraArgs) : [];
  let worst: Verdict = { state: "absent" };
  for (const dir of dirs) {
    const v = agentType === "claude" ? await askClaude(bin, env, dir) : await askCodex(bin, overrides, env, dir);
    if (v.state === "present" || v.state === "unknown") return ok();
    if (v.state === "disabled") worst = v;            // 比 absent 更具体,留它来说话
  }
  // 超集没问全(目录太多被截断)时,「全都说没有」不再是个确定的结论 —— 放行。
  if (!complete) return ok();

  if (worst.state === "disabled") {
    return {
      reachable: false,
      problem: `${worst.detail}，这一轮跑完也上报不了结论（自查：${HOW_TO_CHECK.codex}）`,
    };
  }
  return {
    reachable: false,
    problem: `${agentType} 自己报告没有 ash MCP 登记，这一轮跑完也上报不了结论`
      + `（自查：${HOW_TO_CHECK[agentType]}；接法见 docs/install.md，或在仓库根跑一次 npm run setup）`,
  };
}

export async function ashMcpReachability(q: AshMcpReachQuery): Promise<AshMcpReach> {
  // 这一轮**真正会用**的执行器和参数。默认 profile 的选择、悬空 id 的降级、归属收窄、
  // 整段参数的拆词,全在 executors 那一层,这里只消费结果 —— 上一版自己读 `agents.extraArgs`,
  // 第 3 轮审查用真实 HTTP 打穿:接好的**默认**执行器(extraArgs 里带着
  // `-c mcp_servers.ash.command=node`)被判成没有登记,派审 409(B1)。
  let ctx: Awaited<ReturnType<typeof effectiveExecutorContext>>;
  try {
    ctx = await effectiveExecutorContext({
      executorId: q.executorId ?? null,
      type: q.agentType as AgentType,
      ...(await executorOwnerScope(q.ownerUserId ?? null)),
    });
  } catch {
    return ok();                                     // 解析不了 = 判不了
  }
  if (!ctx) return ok();                             // profile 的 extraArgs 坏了,真起跑也会炸
  return await reachWith(ctx.type, ctx.extraArgs, q.cwdCandidates ?? [], q.ownerUserId ?? null);
}

/**
 * 宿主默认配置下，这个 CLI **自己**说没有 ash MCP 吗。启动自检（`user-cli.ts` 的
 * `warnHostAshMcp`）用：它没有 profile、没有 cwd，问的就是「这台机器的用户级配置」。
 *
 * 返回 true 只在 CLI 明确说没有时 —— 跟派审那道门禁同一条规矩。软告警也走这里，是因为
 * 第 2 位审查者 N1：用正则判 TOML 会把合法的 `[mcp_servers."ash"]`、缩进表头判成缺失，
 * 于是启动时刷一行假告警。判据只留一份，漂不了。
 */
export async function hostAshMcpMissing(agentType: string): Promise<boolean> {
  // 刻意**不**走 `effectiveExecutorContext`：这里问的是宿主默认上下文，不带任何
  // profile 参数、不指定目录。跟派审门禁是两种语义，混了启动日志就会开始说一件
  // 它其实没查过的事（第 3 轮审查 B1 末尾那条边界）。
  const reach = await reachWith(agentType, [], [], null);
  return !reach.reachable;
}
