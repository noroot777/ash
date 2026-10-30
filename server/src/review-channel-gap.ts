// 「审查做完了，结论却上报不了」—— 这一轮判成无结论时，把原因说出来。
//
// 2026-10-28 现场：codex 审查者跑满 35 分钟、报告完整落盘，收尾那句是「当前未提供
// report_stage 工具，无法实际上报 verify_failed」。ash 这边写给用户的只有一句「未能
// 正常给出结论，已停止自动链」—— 一个没有原因的失败。用户看得见的下一个动作是「继续
// 本轮审查」，可通道还是坏的，点一次就再失败一次。
//
// 判据只认 ash 自己的事实：**这一轮 round 落在 error 且没有结论**（跟
// `freeReviewRetryBlocker` 同一个形状）。刻意**不**拿「这一轮调过几次 ash MCP」当判据 ——
// 那要靠 MCP server 的名字去认，而名字是各台机器自己配的（本仓历史名 `harness` 至今仍在
// 用），认不出来就会把一轮正常通过的审查误报成「一次都没调」。
//
// 误报的另外两个口子各堵一道：
//  · **被停掉的回合不说话** —— 用户自己按的停，不是通道的问题。
//  · **没产出过正文的回合不说话** —— CLI 压根没起来是另一回事（那有它自己的诊断），
//    这时说「你没有 report_stage 工具」是误诊。
//
// 证据尽力取，取不到也照说不误：claude 的 init 事件里直接写着每个 MCP server 连上没有，
// 那是最硬的一手；codex 没有等价事件，只能从 stderr 里把跟 MCP 有关的报错行挑出来。
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentType } from "@ash/shared";
import { eq } from "drizzle-orm";
import { ASH_MCP_SERVER_NAME, LEGACY_ASH_MCP_SERVER_NAME } from "@ash/shared/mcp";
import { db } from "./db/index.js";
import { sessions } from "./db/schema.js";
import { detachedPathsFor } from "./executors/detached.js";
import { RUNS_DIR } from "./paths.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { turnProducedWork } from "./transcript.js";
import type { TurnReview } from "./turn-lock.js";

/**
 * 日志**限量读**，不整读。
 *
 * 这条路径恰好只在「审查跑了很久、最后没给出结论」时触发 —— 也就是日志最可能很大的
 * 那一刻，而整读 + `split("\n")` 是在服务主线程上同步做的（第 2 位审查者 N3）。
 * 两边要的东西都在边上：claude 的 init 是**第一条**事件，codex 的诊断取**最后两行**。
 */
const BUDGET = 256 * 1024;

const readEdge = (path: string, edge: "head" | "tail"): string => {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    if (size <= BUDGET) return readFileSync(path, "utf8");
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(BUDGET);
    const position = edge === "head" ? 0 : size - BUDGET;
    const got = readSync(fd, buf, 0, BUDGET, position);
    // 截断处可能切在一个多字节字符或半行中间：按行边界再裁一次，别把半行喂给解析。
    const text = buf.subarray(0, got).toString("utf8");
    const cut = edge === "head" ? text.lastIndexOf("\n") : text.indexOf("\n");
    if (cut < 0) return text;
    return edge === "head" ? text.slice(0, cut) : text.slice(cut + 1);
  } catch {
    return "";
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* 关不上就算了 */ }
  }
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * 这一轮通道到底怎么了。null = 没查出来，只能给通用提示。
 *
 * `definite` = 这份证据**点名 ash 且是确定的坏**，只许由**结构上的位置**给出，不许由「整行里
 * 出现过这个词」给出：
 *  · claude：init 清单（JSON）里没有 ash，或者 ash 的状态是**白名单里**的终局失败
 *    （`CLAUDE_FAILED_STATUSES`）。`pending`、`connecting` 这类没列举的状态一律不算 —— 未知即不确定；
 *  · codex：报错里 server 名出现在 codex 自己给 server 名加引号的那个位置（实测形状
 *    ``MCP client for `ash` failed to start``）。上一版拿 `\b(ash|harness)\b` 在整行上找，
 *    而本仓目录就叫 harness、`~/.ash/…` 这类路径也带 ash，于是任何一行顺带打了 cwd 的别家报错
 *    都成了「ash 自己坏了」的确定证据（第 1 轮审查第 1 条）。
 * 普通回合那句说明只认这一种（见 `noteTurnChannelGap`），审查回合两种都用。
 */
type Evidence = { connected: boolean; detail: string; definite: boolean } | null;

/** claude init 里 server 状态的终局失败词。白名单：没列举的状态（含将来新增的瞬时态）都不算确定。 */
const CLAUDE_FAILED_STATUSES = new Set(["failed", "needs-auth", "disabled"]);

/**
 * codex 自己报 MCP server 出错时点名的那个位置：``MCP client for `ash` ``、``MCP server `ash` ``
 * （引号种类放宽到 `'"`）。只认这一个位置 —— 别家 server 的报错里顺带引到 `'ash'` 也不算。
 */
const CODEX_QUOTED_ASH = new RegExp(
  `\\bMCP (?:client|server)(?: for)? [\`'"](?:${ASH_MCP_SERVER_NAME}|${LEGACY_ASH_MCP_SERVER_NAME})[\`'"]`, "i");

/**
 * claude：`{"type":"system","subtype":"init",…,"mcp_servers":[{"name":"ash","status":"connected"}]}`
 * 是会话启动时的第一条事件，权威地写着每个 server 连上没有。
 *
 * 两个名字都认：读的是**盘上的历史日志**，里面写的是那台机器当时配的名字，而历史名
 * `harness` 的装机至今还在跑。这里认两个只影响一句提示文案的措辞，跟「补捞该不该兼容
 * 历史名」是两回事。
 */
export function claudeMcpEvidence(text: string): Evidence {
  const wanted = new Set<string>([ASH_MCP_SERVER_NAME, LEGACY_ASH_MCP_SERVER_NAME]);
  for (const line of text.split("\n")) {
    if (!line.includes('"init"')) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    const root = asRecord(parsed);
    if (root.type !== "system" || root.subtype !== "init") continue;
    const servers = root.mcp_servers;
    if (!Array.isArray(servers)) continue;
    const rows = servers.map(asRecord);
    const names = rows.map((s) => s.name).filter((n): n is string => typeof n === "string");
    // **集合判据，不是第一项**：两个名字是同一个东西的新旧叫法，一条会话里可能同时
    // 登记着两份。只看排在前面那一份，就会在「新名那份没连上、旧名那份连着」时给出
    // 偏掉的诊断 —— 跟派审门禁上那条是同一类（第 3 轮审查 B2）。
    const mine = rows.filter((s) => typeof s.name === "string" && wanted.has(s.name));
    if (!mine.length) {
      return { connected: false, definite: true, detail: `这条会话启动时 claude 报告的 MCP server 是「${names.join("、") || "一个都没有"}」，里面没有 ash。` };
    }
    const ash = mine.find((s) => s.status === "connected") ?? mine[0]!;
    const status = typeof ash.status === "string" ? ash.status : "";
    const others = mine.length > 1
      ? `（这条会话里有 ${mine.length} 份兼容登记：${mine.map((s) => `${String(s.name)}=${typeof s.status === "string" ? s.status : "未知"}`).join("、")}）`
      : "";
    return status === "connected"
      // **只说连上了，别替它断言工具在手**：init 事件写的是「server 连上没有」，不是
      // 「report_stage 暴露了没有」—— 执行器的工具白/黑名单能把具体工具挡掉，那时说
      // 「多半是它自己漏了上报」就是把限制归咎于审查者（第 2 位审查者 N2）。
      ? { connected: true, definite: false, detail: `这条会话启动时 ash MCP 是连上的${others}。至于 report_stage 当时在不在它手里，init 事件没说（执行器若限制过工具清单，这里看不出来）。` }
      : {
          connected: false,
          definite: CLAUDE_FAILED_STATUSES.has(status),
          detail: `这条会话启动时 ash MCP（${String(ash.name)}）的状态是「${status || "未知"}」，不是 connected${others}。`,
        };
  }
  return null;
}

/** codex：没有 init 那样的清单，只能从 stderr 里挑跟 MCP 有关的报错行。 */
export function codexMcpEvidence(text: string): Evidence {
  const hits = text.split("\n")
    .filter((line) => /mcp/i.test(line) && /(error|warn|failed|unknown)/i.test(line))
    // stderr 带 ANSI 着色，原样贴进时间线是一串乱码
    .map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").trim())
    .filter(Boolean);
  if (!hits.length) return null;
  // 同一份 stderr 里往往混着别的 server 的报错（实测最多的是 linear 的 OAuth）。
  // 点名 ash 的那几行才是这里要的，没有再退回最后两行。「点名」认的是引号里的 server 名，
  // 不是整行里出现过这个词（见 Evidence 上面那段）。
  const named = hits.filter((line) => CODEX_QUOTED_ASH.test(line));
  const picked = (named.length ? named : hits).slice(-2);
  return {
    connected: false,
    definite: named.length > 0,
    detail: `codex 的 stderr 里有这些跟 MCP 有关的报错：\n${picked.map((line) => line.slice(0, 300)).join("\n")}`,
  };
}

const HOW_TO_CHECK: Record<string, string> = {
  claude: "claude mcp get ash",
  codex: "codex mcp list --json（看 ash 在不在、enabled 是不是 true）",
};

/** 这一回合留在盘上的通道证据：claude 的 init 是第一条事件，codex 的诊断取 stderr 末尾。 */
function turnEvidence(a: { taskId: string; sessId: string; turnStart: string; agentType: AgentType }): Evidence {
  const paths = detachedPathsFor(join(RUNS_DIR, a.taskId), a.sessId, a.turnStart);
  return a.agentType === "claude"
    ? claudeMcpEvidence(readEdge(paths.out, "head"))
    : a.agentType === "codex" ? codexMcpEvidence(readEdge(paths.err, "tail")) : null;
}

/**
 * 刚刚那一轮审查是不是**判成了无结论**（round 落 error、conclusion 为空）。
 *
 * **按这一回合自己绑定的那一轮去查**，不按「这条任务最新的那次审查」：结算到这里之前，
 * 用户可能已经开出了下一轮（或者别的入口新建了一次审查），那时 `latestRun` 指的是新的
 * 那一次，它还没落 error，这句说明就悄悄不出现了（新链第 1 轮审查）。绑定拿不到的回合
 * （接回的老会话等）才退回 `latestRun`。
 */
async function concludedNothing(taskId: string, review: TurnReview | null): Promise<boolean> {
  const { latestRun, roundOf } = await import("./free-review-round.js");
  if (review) {
    const { db } = await import("./db/index.js");
    const { freeReviewRounds } = await import("./db/schema.js");
    const { and, eq } = await import("drizzle-orm");
    const round = (await db.select().from(freeReviewRounds).where(and(
      eq(freeReviewRounds.runId, review.run),
      eq(freeReviewRounds.round, review.round),
    ))).at(0);
    return !!round && round.status === "error" && !round.conclusion;
  }
  const run = await latestRun(taskId);
  if (!run) return false;
  const round = await roundOf(run);
  return !!round && round.status === "error" && !round.conclusion;
}

/**
 * 审查旁路回合收尾后补的那句说明。返回「说没说」，调用方不必据此做任何事。
 *
 * **排在 `afterSettlement` 之后调**：那一步里自由工作流才写下「未能正常给出结论，已停止
 * 自动链」，也是在那里把 round 落成 error —— 判据和那句话都得等它写完才成立。
 */
export async function noteReviewerChannelGap(a: {
  taskId: string;
  sessId: string;
  turnStart: string;
  agentType: AgentType;
  stopped: boolean;
  /** 这一回合为哪一次审查的哪一轮而起（回合身份里那份）。拿不到给 null。 */
  review: TurnReview | null;
}): Promise<boolean> {
  if (a.stopped) return false;
  if (!(await concludedNothing(a.taskId, a.review))) return false;
  // 干过活才算数：CLI 没起来、起来就崩的那种另有诊断，这里插一句只会误导。
  if (!(await turnProducedWork(a.taskId, a.sessId, a.turnStart))) return false;
  const evidence = turnEvidence(a);
  const check = HOW_TO_CHECK[a.agentType] ?? "检查该执行器的 ash MCP 登记";
  const why = evidence
    ? evidence.detail
    // 没有证据时只能推断，措辞就得是推断：「最可能」而不是陈述一个原因。
    : `这一轮没查到直接证据；最可能的原因是审查者手上根本没有 report_stage 这个工具（自查：${check}）：报告照样写得完整，只有最后一步上报做不到。`;
  const next = evidence?.connected
    ? "可以先点「继续本轮审查」让它接着上一次的上下文补上报（不用重跑这一轮）；要是它说仍然没有这个工具，就去查执行器有没有限制工具清单。"
    : `修好之后点「继续本轮审查」，它会接着上一次的上下文只补上报，不用重跑这一轮。`;
  // **显式绑定刚结束那条审查会话**：缺省会按 `sessions.startedAt` 挑最新建的那条，而一条
  // 任务上常有比它更新的别的会话（「继续本轮审查」复用的是**较早**那条审查会话），于是这句
  // 说明会落到另一位智能体名下 —— 看记录的人在审查者那边什么也看不到（第 1 轮审查 N3）。
  await appendTaskTimeline(
    a.taskId,
    `这一轮的审查报告可能已经写完了，只是结论没能上报到 ash。${why}${next}`,
    { sessionId: a.sessId },
  );
  return true;
}

/**
 * 普通回合「没交卷」时的同一句说明（原任务第 1 轮审查第 3 条：普通任务只留下一句没有原因的
 * 「失败」）。返回「说没说」。
 *
 * 跟审查那条的差别在判据上：审查回合「没给出结论」是 ash 自己的事实，没有证据也敢推断一句
 * 「最可能是没有 report_stage」；普通回合没交卷的头号原因是 agent 漏调了 complete_task，没有
 * 直接证据就说「通道坏了」是误诊。所以这里**只认点名 ash 的确定证据**（`Evidence.definite`），
 * 拿不到就不说话 —— 结算说明里那句通用的「常见原因」已经在了。
 *
 * 调用方只在「exit 0 却没交卷、落了 failed」那一支调，且排除了原生命令回合（`/compact`）：被停的、
 * 交过卷的、以提问/检查点暂停的回合都走不到这里（后两种本身就证明 ash MCP 是通的）。旁路回合
 * 的原状态是 failed 时也会落在这一支，由下面按会话行的 `side_turn` 挡掉。
 */
export async function noteTurnChannelGap(a: {
  taskId: string;
  sessId: string;
  turnStart: string;
  agentType: AgentType;
}): Promise<boolean> {
  // 旁路回合（就地验证、辩论里执行者那一段、计划模式）不靠 complete_task 交卷，这句话说的
  // 不是它们。认的是会话行上那一列（起跑时落库，重启接管后也在），不靠内存里的回合身份。
  const row = (await db.select({ sideTurn: sessions.sideTurn }).from(sessions).where(eq(sessions.id, a.sessId))).at(0);
  if (!row || row.sideTurn) return false;
  if (!(await turnProducedWork(a.taskId, a.sessId, a.turnStart))) return false;
  const evidence = turnEvidence(a);
  if (!evidence?.definite) return false;
  const check = HOW_TO_CHECK[a.agentType] ?? "检查该执行器的 ash MCP 登记";
  await appendTaskTimeline(
    a.taskId,
    "这一轮没交卷多半不是 agent 漏了，而是它手上没有 ash 的工具：complete_task、ask_question、pause_task 都是 ash MCP 提供的，"
      + `通道不在，这一轮干得再好也交不上（自查：${check}）。修好之后点重试，它会从中断处接着做、只补交卷。`
      + `证据：${evidence.detail}`,
    { sessionId: a.sessId },
  );
  return true;
}
