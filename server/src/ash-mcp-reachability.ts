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
// 两条都带上**这一轮真正要用的** env(含注入的 CLAUDE_CONFIG_DIR / CODEX_HOME)和 cwd;
// codex 还把归一后的 extraArgs **整份**带上去(为什么不是挑一个子集,见 askCodex 上面那段)。
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
//
// ── 问不了 CLI 时:退到配置文件,而不是整条放行 ───────────────────────────────
//
// 问 CLI 要起进程,起进程之前必须拿到一台内核圈定(`ash-mcp-probe.ts`)。macOS、从 ssh 会话
// 起的 Linux、只读 cgroup 的容器都拿不到 —— 上一版在这些机器上一条查询都不起、整条放行,
// 新链第 1 轮审查在这台 Mac 上实测:配置里确实没有登记,预检 `reachable:true`。那等于判据
// 在报事故的那类机器上整个不工作。所以弃权时换成读配置文件那一档(`ash-mcp-file.ts`,
// 不起任何进程),它只在「确定没有」时说没有,文案里写明证据来源和问不了 CLI 的原因。
//
// ── 总预算 ──────────────────────────────────────────────────────────────────
//
// 一次预检最多问 8 个目录 × 2 个名字,每一问在 Windows 上还要读几次 Job 成员。单问 15 秒的
// 上限乘上去是几分钟,而派审请求和启动自检都在等它。所以整次预检有一个总预算,用完了剩下的
// 一律按「问不出来」放行(新链第 1 轮审查第 4、5 条)。
import { existsSync } from "node:fs";
import type { AgentType } from "@ash/shared";
import { fileAshMcpVerdict, launchHint } from "./ash-mcp-file.js";
import { confineAbstention } from "./executors/kernel-confine.js";
import { ASH_MCP_SERVER_NAME, LEGACY_ASH_MCP_SERVER_NAME } from "@ash/shared/mcp";
import { probeCli } from "./ash-mcp-probe.js";
import { executorOwnerScope } from "./auth/dispatch-gate.js";
import { runEnvForOwner } from "./auth/run-env.js";
import { cliSpec } from "./executors/catalog/index.js";
import { effectiveExecutorContext } from "./executors/index.js";
import { resolveLaunch } from "./executors/bin-resolve.js";

/** 探测是只读子命令（claude 实测 ~0.8s、codex ~0.01s）；超时一律按「问不出来」放行。 */
const PROBE_TIMEOUT_MS = 15_000;

/** 派审预检的总预算。见文件头「总预算」。 */
export const REVIEW_REACH_BUDGET_MS = 20_000;
/** 剩下的预算不够起一问时就不起了 —— 一问连 CLI 带收尾至少要这么久。 */
const MIN_PROBE_MS = 1_500;

/** 整次预检的截止时刻。每一问的超时取「单问上限」和「剩下的预算」里小的那个。 */
type Budget = { deadline: number };
const probeTimeout = (b: Budget): number | null => {
  const left = b.deadline - Date.now();
  return left < MIN_PROBE_MS ? null : Math.min(PROBE_TIMEOUT_MS, left);
};

export interface AshMcpReach {
  /** false 只在**确定拿不到**时出现；任何不确定都是 true */
  reachable: boolean;
  /** reachable=false 时写给用户的一句话（已含自查办法） */
  problem: string | null;
  /**
   * 放行了、但登记里写的启动方式看着起不来时的一句提示（新链第 1 轮审查第 3 条）。
   * **只是提示**：「登记在」和「能连上」是两件事，后者是推断，不拿它拦人。
   */
  warning: string | null;
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

const ok = (warning: string | null = null): AshMcpReach => ({ reachable: true, problem: null, warning });

const HOW_TO_CHECK: Record<string, string> = {
  claude: "claude mcp get ash",
  codex: "codex mcp list --json（看 ash 在不在、enabled 是不是 true）",
};

const WANTED = [ASH_MCP_SERVER_NAME, LEGACY_ASH_MCP_SERVER_NAME];

/** CLI 自己给的答案。`unknown` = 问不出来，调用方必须放行。 */
type Verdict =
  | { state: "present"; hint?: string | null }
  | { state: "unknown" }
  | { state: "absent" }
  | { state: "disabled"; detail: string };

/**
 * 探测命令**原样带上这一轮的 extraArgs**，不再自己挑「哪些跟 MCP 有关」。
 *
 * 上一版挑了一份子集（只认 `-c VALUE`、`--config VALUE` 和带等号的形式），第 4 轮审查
 * 用真实 CLI 打穿：codex 接受紧贴写法 `-cmcp_servers.ash.command=node`，被这份子集直接
 * 丢掉，于是探测问的是**另一份配置**，再拿那份配置的「没有」去拒真实执行器（B1）。
 * 病根不是漏了哪一种拼法，是「投影」这件事本身——补一条正则只会等下一种写法。
 *
 * 所以 codex 这边把归一后的 argv 整份传过去：认得的照常生效（实测紧贴/分开/等号三种
 * 写法 `mcp list --json` 都吃），认不得的会让它非零退出，而那正好落进「问不出来 →
 * 放行」。两头都不需要我们理解参数的含义。
 *
 * claude 这边做不到：实测 `claude --mcp-config x.json mcp get ash` 里 `--mcp-config`
 * 是 variadic，会把 `mcp`、`get`、`ash` 当成它自己的值吃掉，子命令就没了。既然没法保证
 * 「探测用的配置 = 运行时的配置」，就不下硬结论 —— 带了额外参数一律放行（见 reachWith）。
 */
/**
 * claude：`mcp get <name>` 有登记 rc=0、没有 rc=1 并写明 `No MCP server named`。
 * 刻意不用 `mcp list` —— 它会**真的去连每一个** server（实测含远程 HTTP 的那种），
 * 一次预检不该有这种副作用。
 */
async function askClaude(
  bin: string,
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
  budget: Budget,
): Promise<Verdict> {
  let sawNoSuchServer = false;
  for (const name of WANTED) {
    const timeout = probeTimeout(budget);
    if (timeout === null) return { state: "unknown" };
    const res = await probeCli(bin, ["mcp", "get", name], env, cwd, timeout);
    if (!res) return { state: "unknown" };
    if (res.code === 0) return { state: "present", hint: claudeStatusHint(res.stdout) };
    // 文本判定两个通道都看：这句话落在哪一路由 CLI 版本决定，而它只是「有没有这个
    // server」的证词，不像 JSON 那样会被别的输出带坏。
    if (/No MCP server named/i.test(`${res.stdout}\n${res.stderr}`)) { sawNoSuchServer = true; continue; }
    return { state: "unknown" };                     // rc≠0 但不是「没有这个 server」：另有问题，不归这里答
  }
  return sawNoSuchServer ? { state: "absent" } : { state: "unknown" };
}

/**
 * `claude mcp get` 会真的连一次那个 server，结果写在 `Status:` 那一行（实测
 * `Status: ✔ Connected`）。rc 只说「登记在」，连不上的那种（`command` 不在 PATH 上、脚本
 * 被挪走、`ASH_URL` 指错端口）以前一律放行 —— 现在至少说一句。只是提示，不拦。
 */
export function claudeStatusHint(stdout: string): string | null {
  const status = /^\s*Status:\s*(.+)$/m.exec(stdout)?.[1]?.trim();
  if (!status) return null;
  if (/\bconnected\b/i.test(status) && !/fail|not connected|disconnected|✘|✗/i.test(status)) return null;
  return `claude 自己说这条 ash MCP 登记连不上（Status: ${status}；自查：claude mcp get ash）`
    + "（只是提示，这一轮没拦）";
}

/** codex：`mcp list --json` 的 `enabled` / `disabled_reason` 就是它自己的结论。 */
async function askCodex(
  bin: string,
  extraArgs: string[],
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
  budget: Budget,
): Promise<Verdict> {
  const timeout = probeTimeout(budget);
  if (timeout === null) return { state: "unknown" };
  const res = await probeCli(bin, [...extraArgs, "mcp", "list", "--json"], env, cwd, timeout);
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
  const live = mine.find((r) => r.enabled !== false);
  if (live) return { state: "present", hint: codexLaunchHint(live) };
  const detail = mine.map((r) => {
    const why = typeof r.disabled_reason === "string" && r.disabled_reason.trim()
      ? r.disabled_reason.trim()
      : "enabled = false";
    return `[mcp_servers.${String(r.name)}]（${why}）`;
  }).join("、");
  return { state: "disabled", detail: `codex 自己报告这些 ash MCP 登记都没启用：${detail}` };
}

/**
 * codex 的 `mcp list --json` 只读配置、不启动那个 server（`enabled` 是配置里的开关），所以
 * 「起不起得来」得自己看一眼 `transport` 里写的命令和地址。只是提示，见 `launchHint`。
 */
function codexLaunchHint(row: Record<string, unknown>): string | null {
  const t = row.transport && typeof row.transport === "object" ? row.transport as Record<string, unknown> : {};
  const env = t.env && typeof t.env === "object" ? t.env as Record<string, unknown> : {};
  return launchHint({
    command: typeof t.command === "string" ? t.command : null,
    args: t.args,
    ashUrl: typeof env.ASH_URL === "string" ? env.ASH_URL : null,
  });
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
 * 启动自检 `hostAshMcpGap` 走的就是这条，它问的本来就是宿主默认配置。
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
  budgetMs: number,
): Promise<AshMcpReach> {
  const budget: Budget = { deadline: Date.now() + budgetMs };
  if (agentType !== "claude" && agentType !== "codex") return ok();
  // claude 的子命令带不动这些参数（上面那段说明：`--mcp-config` 是 variadic，会把子命令
  // 本身吃掉）。保证不了「探测用的配置 = 运行时的配置」，就不下硬结论。
  if (agentType === "claude" && extraArgs.length) return ok();

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

  // 问不了 CLI 本人(这台机器拿不到能核销那次查询的内核圈定)⇒ 退到配置文件那一档。
  const abstained = confineAbstention();
  if (abstained) return fromFiles(agentType, extraArgs, env, dirs, complete, abstained);

  // 逐个问:present / unknown 任一出现就放行,只有**全都**说拿不到才往下走。
  let worst: Verdict = { state: "absent" };
  for (const dir of dirs) {
    const v = agentType === "claude"
      ? await askClaude(bin, env, dir, budget)
      : await askCodex(bin, extraArgs, env, dir, budget);
    if (v.state === "present") return ok(v.hint ?? null);
    if (v.state === "unknown") return ok();
    if (v.state === "disabled") worst = v;            // 比 absent 更具体,留它来说话
  }
  // 超集没问全(目录太多被截断)时,「全都说没有」不再是个确定的结论 —— 放行。
  if (!complete) return ok();

  if (worst.state === "disabled") {
    return {
      reachable: false,
      problem: `${worst.detail}，这一轮跑完也上报不了结论（自查：${HOW_TO_CHECK.codex}）`,
      warning: null,
    };
  }
  return {
    reachable: false,
    problem: `${agentType} 自己报告没有 ash MCP 登记，这一轮跑完也上报不了结论`
      + `（自查：${HOW_TO_CHECK[agentType]}；接法见 docs/install.md，或在仓库根跑一次 npm run setup）`,
    warning: null,
  };
}

/**
 * 配置文件那一档(见文件头「问不了 CLI 时」)。拦人的规矩跟 CLI 那一档一样只有「确定没有」:
 *
 *  · 带了 extraArgs 一律放行 —— 文件里看不到命令行覆盖(`-c mcp_servers.…`),跟 claude 那条
 *    「带了参数就不下硬结论」同一个理由,不去挑哪些参数跟 MCP 有关(第 4 轮审查 B1 那个病根);
 *  · 目录没问全(截断)放行;读不出、写法判不了放行(`fileAshMcpVerdict` 里那几种 unknown)。
 *
 * 说「没有」时文案里写明**这是读配置得出的、没经 CLI 确认**,以及为什么问不了 CLI ——
 * 用户拿到 409 的时候至少知道这一次的证据是什么。
 */
function fromFiles(
  agentType: string,
  extraArgs: string[],
  env: NodeJS.ProcessEnv,
  dirs: (string | undefined)[],
  complete: boolean,
  abstained: string,
): AshMcpReach {
  if (extraArgs.length) return ok();
  const v = fileAshMcpVerdict(agentType, env, dirs);
  if (v.state === "present") return ok(v.hint);
  if (v.state === "unknown" || !complete) return ok();
  const basis = `（这是读配置文件得出的，没经 ${agentType} 本人确认 —— 这台机器问不了它：${abstained}）`;
  return {
    reachable: false,
    problem: `${v.detail}，看配置这一轮跑完也上报不了结论${basis}`
      + `（自查：${HOW_TO_CHECK[agentType]}；接法见 docs/install.md，或在仓库根跑一次 npm run setup）`,
    warning: null,
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
  return await reachWith(
    ctx.type, ctx.extraArgs, q.cwdCandidates ?? [], q.ownerUserId ?? null, REVIEW_REACH_BUDGET_MS,
  );
}

/** 启动自检的总预算。它不挡监听（见 index.ts），但也不该在后台挂上半分钟。 */
const HOST_REACH_BUDGET_MS = 10_000;

/**
 * 宿主默认配置下，这个 CLI 是不是**确定**拿不到 ash MCP。启动自检（`user-cli.ts` 的
 * `warnHostAshMcp`）用：它没有 profile、没有 cwd，问的就是「这台机器的用户级配置」。
 *
 * 返回 null = 没有确定的缺口（含问不出来）；否则给出那句话和**证据来源** —— 问不了 CLI 的
 * 机器上结论来自配置文件，启动日志的措辞要跟着降一档（新链第 1 轮审查第 1 条）。判据跟
 * 派审那道门禁是同一份，漂不了。
 */
export async function hostAshMcpGap(
  agentType: string,
): Promise<{ basis: "cli" | "file"; problem: string } | null> {
  // 刻意**不**走 `effectiveExecutorContext`：这里问的是宿主默认上下文，不带任何
  // profile 参数、不指定目录。跟派审门禁是两种语义，混了启动日志就会开始说一件
  // 它其实没查过的事（第 3 轮审查 B1 末尾那条边界）。
  const reach = await reachWith(agentType, [], [], null, HOST_REACH_BUDGET_MS);
  if (reach.reachable) return null;
  return { basis: confineAbstention() ? "file" : "cli", problem: reach.problem ?? "" };
}
