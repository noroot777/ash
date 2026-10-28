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
// 判据只有一条硬规矩:**向放行开**。拦错一轮审查,用户得到的是一条根本跑不起来的链;
// 放过一轮,最差也只是回到今天的样子(跑完没结论,由 `review-channel-gap.ts` 如实说明
// 原因)。所以只有 CLI 自己明确说「没有这个 server」「它被禁用了」才拦 —— 命令跑不起来、
// 超时、输出看不懂、执行器带了判不了的覆盖参数,一律放行。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { ASH_MCP_SERVER_NAME, LEGACY_ASH_MCP_SERVER_NAME } from "@ash/shared/mcp";
import { runEnvForOwner } from "./auth/run-env.js";
import { db } from "./db/index.js";
import { agents } from "./db/schema.js";
import { cliSpec } from "./executors/catalog/index.js";
import { resolveBin } from "./executors/bin-resolve.js";

const exec = promisify(execFile);

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
  /** 这一轮的工作目录 —— claude 的**项目级**登记只在它下面看得见。 */
  cwd?: string;
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
 * 这个 profile 的 extraArgs。**解析不了就回 null**（= 判不了，放行）—— 这里拿它只为
 * 回答「有没有东西会改写 MCP 登记」，猜错的代价是拦掉一轮本来能跑的审查。
 */
async function profileExtraArgs(executorId: string | null | undefined): Promise<string[] | null> {
  if (!executorId) return [];
  try {
    const row = (await db.select({ extraArgs: agents.extraArgs }).from(agents).where(eq(agents.id, executorId))).at(0);
    if (!row) return [];                             // 悬空 id：按 agentType 默认执行器降级，没有额外参数
    const parsed: unknown = JSON.parse(row.extraArgs);
    return Array.isArray(parsed) && parsed.every((a) => typeof a === "string") ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

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

async function probe(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
): Promise<{ code: number; out: string } | null> {
  try {
    const { stdout, stderr } = await exec(bin, args, {
      env,
      cwd,
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    return { code: 0, out: `${stdout}\n${stderr}` };
  } catch (error) {
    const e = error as { code?: unknown; stdout?: string; stderr?: string; killed?: boolean };
    // 超时被杀 / 压根起不来：没有答案可用。
    if (e.killed || typeof e.code !== "number") return null;
    return { code: e.code, out: `${e.stdout ?? ""}\n${e.stderr ?? ""}` };
  }
}

/**
 * claude：`mcp get <name>` 有登记 rc=0、没有 rc=1 并写明 `No MCP server named`。
 * 刻意不用 `mcp list` —— 它会**真的去连每一个** server（实测含远程 HTTP 的那种），
 * 一次预检不该有这种副作用。
 */
async function askClaude(bin: string, env: NodeJS.ProcessEnv, cwd: string | undefined): Promise<Verdict> {
  let sawNoSuchServer = false;
  for (const name of WANTED) {
    const res = await probe(bin, ["mcp", "get", name], env, cwd);
    if (!res) return { state: "unknown" };
    if (res.code === 0) return { state: "present" };
    if (/No MCP server named/i.test(res.out)) { sawNoSuchServer = true; continue; }
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
  const res = await probe(bin, [...overrides, "mcp", "list", "--json"], env, cwd);
  if (!res || res.code !== 0) return { state: "unknown" };
  let parsed: unknown;
  try { parsed = JSON.parse(res.out.trim()); } catch { return { state: "unknown" }; }
  if (!Array.isArray(parsed)) return { state: "unknown" };
  const rows = parsed.filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
  const found = rows.find((r) => typeof r.name === "string" && WANTED.includes(r.name));
  if (!found) return { state: "absent" };
  if (found.enabled === false) {
    const why = typeof found.disabled_reason === "string" && found.disabled_reason.trim()
      ? found.disabled_reason.trim()
      : "enabled = false";
    return { state: "disabled", detail: `codex 自己报告 [mcp_servers.${String(found.name)}] 没启用（${why}）` };
  }
  return { state: "present" };
}

/**
 * 这条任务下一轮起跑时，它的 agent 够不够得着 ash MCP。
 *
 * 只认 claude / codex：别的执行器的 MCP 登记不经 ash 的手（`scripts/setup.mjs` 也只管
 * 这两个加 kimi），对它们一律放行 —— 「ash 不知道」不等于「它没有」。
 */
export async function ashMcpReachability(q: AshMcpReachQuery): Promise<AshMcpReach> {
  const { agentType } = q;
  if (agentType !== "claude" && agentType !== "codex") return ok();

  const extraArgs = await profileExtraArgs(q.executorId);
  if (!extraArgs) return ok();                       // profile 读不出来 = 判不了
  if (agentType === "claude" && extraArgs.some((a) => CLAUDE_MCP_OVERRIDE.test(a))) return ok();

  let bin: string | null = null;
  let env: NodeJS.ProcessEnv;
  try {
    for (const candidate of cliSpec(agentType).bins) {
      bin = resolveBin(candidate);
      if (bin) break;
    }
    // 起跑要用的那一份 env（隔离档下带 CLAUDE_CONFIG_DIR / CODEX_HOME）。宿主机自己
    // 设的那两个变量由 process.env 原样继承 —— 真实 spawn 也是这么继承的。
    env = { ...process.env, ...(await runEnvForOwner(q.ownerUserId ?? null, agentType)) };
  } catch {
    return ok();
  }
  if (!bin) return ok();                             // CLI 都不在这台机器上，派审会以别的方式失败

  const verdict = agentType === "claude"
    ? await askClaude(bin, env, q.cwd)
    : await askCodex(bin, codexMcpOverrides(extraArgs), env, q.cwd);

  if (verdict.state === "absent") {
    return {
      reachable: false,
      problem: `${agentType} 自己报告没有 ash MCP 登记，这一轮跑完也上报不了结论`
        + `（自查：${HOW_TO_CHECK[agentType]}；接法见 docs/install.md，或在仓库根跑一次 npm run setup）`,
    };
  }
  if (verdict.state === "disabled") {
    return {
      reachable: false,
      problem: `${verdict.detail}，这一轮跑完也上报不了结论（自查：${HOW_TO_CHECK.codex}）`,
    };
  }
  return ok();
}
