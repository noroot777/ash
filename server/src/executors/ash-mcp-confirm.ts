// ash 的工具这一回合到底在不在 agent 手上 —— 以 CLI 启动后自己报的为准（注入那一半在
// `ash-mcp-inject.ts`）。三件事都要成立才算接上：
//
//  1. **连上的是注入的那一份**。只认本名 `ash`：历史名 `harness` 是用户自己配置里的登记，指着
//     哪个实例、连没连上都不说明这一回合注入的 ash 怎样，拿它作证会被到达先后左右结论。claude
//     再认 `source`：注入的那份是 `dynamic`，连上的若是 `user` / `project` 那条，就是注入没生效；
//     注入文件写失败的原因由**这一回合自己的**注入结果带进来（`ClaudeAshMcpInjection`）。
//  2. **ash 的工具一样不少**。用户配置里的工具名单（codex 的 `enabled_tools` / `disabled_tools`
//     被 `-c` 深合并保留，claude 的 `--disallowedTools`）能把其中几样挡掉。比的是 ash 注册的
//     **全部**工具（`ASH_MCP_TOOLS`），不替回合挑「这回合要哪几样」—— 那份挑法写在各处提示词里，
//     在这里再枚举一遍迟早漏一样（第 2 轮审查发现 2 漏的就是辩论要的 `debate_reply`）。缺的里有
//     收尾出口（`ASH_MCP_TURN_EXITS`）就是红色诊断、逐样说缺了会怎样；只缺别的是提示。
//  3. **核实不了就说核实不了**，不折回「没问题」：codex 的工具清单要另问一次（异步、可能超时、
//     分页），回合收尾时还没问到就留一句提示；codex exec 那条路根本不报启动状态（2026-11-14
//     codex 0.153.4 实测：stdout 的 JSON 流和 stderr 里都没有），按本回合自己的记录判 ——
//     调成过 ash 的工具就是接上了，stderr 点名 ash 启动失败就照原话说，都没有就说核实不了。
//
// 诊断都落 trace 与 .md（刷新后仍在），`affectsTurn: false`：不改本回合成败，成败照旧由交卷判。
import { existsSync } from "node:fs";
import type { AgentEvent } from "@ash/shared";
import { ASH_MCP_SERVER_NAME, ASH_MCP_TOOLS, ASH_MCP_TURN_EXITS } from "@ash/shared/mcp";
import { ashMcpEntry } from "../mcp-registry/register.js";
import type { ClaudeAshMcpInjection } from "./ash-mcp-inject.js";

type Problem = AgentEvent | null;

/** 宽松完成协议（ASH_LAX_DONE）就是给「agent 够不着 ash MCP」的环境准备的，这些话只会是噪音。 */
const lax = () => !!process.env.ASH_LAX_DONE;

function unbuiltHint(): string {
  const entry = ashMcpEntry().args[0]!;
  return existsSync(entry) ? "" : `。ash 的 MCP 入口 ${entry} 不存在，先在仓库根跑一次 npm run build`;
}

/** 整条 ash 没接上（没连上 / 连上的不是注入那份）。 */
function unavailable(detail: string): Problem {
  if (lax()) return null;
  return {
    kind: "error",
    affectsTurn: false,
    message: `ash 的工具在这一回合没接上（${detail}${unbuiltHint()}）：ash 的工具都用不了，`
      + "需要交卷的回合会记未完成；不需要交卷的纯追问不受影响。",
  };
}

/** 连上了，`exposed` 是 CLI 报的 ash 工具名（不带前缀）；缺了哪几样就说哪几样。 */
function missingTools(exposed: readonly string[], who: string): Problem {
  if (lax()) return null;
  const missing = ASH_MCP_TOOLS.filter((t) => !exposed.includes(t));
  if (!missing.length) return null;
  const exits = missing.filter((t) => t in ASH_MCP_TURN_EXITS);
  const head = `${who}连上了 ash，但 ${missing.join("、")} 不在 agent 手上 —— 执行器配置限制了 ash 的工具清单`;
  if (!exits.length) {
    return { kind: "error", level: "notice", affectsTurn: false, message: `${head}；用到它们的那一步做不了，回合收尾不受影响。` };
  }
  return {
    kind: "error",
    affectsTurn: false,
    message: `ash 的工具在这一回合没接上（${head}）：${exits.map((t) => `${t} 缺了，${ASH_MCP_TURN_EXITS[t]}`).join("；")}。`,
  };
}

/** 核实不了：提示级，不算故障，也不冒充「没问题」。 */
function unverified(detail: string): Problem {
  if (lax()) return null;
  return { kind: "error", level: "notice", affectsTurn: false, message: `ash 的工具这一回合在不在 agent 手上核实不了：${detail}。要是它没交卷，先怀疑这一条。` };
}

/**
 * claude `init` 事件 → 没注入上 / 没连上 / 工具不全就给一条诊断，都好返回 null。老版本不报
 * `source` 时只能按连没连上判。
 */
export function claudeAshMcpProblem(injection: ClaudeAshMcpInjection, servers: unknown, tools?: unknown): Problem {
  const list = Array.isArray(servers) ? servers as { name?: unknown; status?: unknown; source?: unknown }[] : [];
  const ash = list.find((s) => s?.name === ASH_MCP_SERVER_NAME);
  const failure = injection.failure ? `；${injection.failure}` : "";
  if (!ash) return unavailable(`claude 启动时的 MCP 清单里没有 ash${failure}`);
  if (ash.status !== "connected") return unavailable(`claude 启动时报告 ash MCP 的状态是 ${String(ash.status)}${failure}`);
  if (injection.failure || (ash.source !== undefined && ash.source !== "dynamic")) {
    return unavailable(`ash 的注入没生效，claude 连上的是它自己配置里那条（来源 ${String(ash.source ?? "未知")}），未必指着这个 ash${failure}`);
  }
  if (!Array.isArray(tools)) return unverified("claude 的 init 事件里没有工具清单");
  const prefix = `mcp__${ASH_MCP_SERVER_NAME}__`;
  return missingTools(tools.filter((t): t is string => typeof t === "string" && t.startsWith(prefix)).map((t) => t.slice(prefix.length)), "claude ");
}

/** codex app-server 的 JSON-RPC 请求（`codex-app-server.ts` 那个 `request`）。 */
type CodexRequest = (method: string, params: unknown, timeoutMs?: number) => Promise<unknown>;

/** 回合收尾时工具清单还没问到，最多再等这么久。正常情况下清单在 thread/start 那一刻就问完了。 */
const SETTLE_WAIT_MS = 3_000;

/**
 * codex app-server 一个回合里的 ash。`update` 收 `mcpServer/startupStatus/updated`（失败当场给
 * 诊断）；ash 一 ready 就 `checkTools` 去问 `mcpServerStatus/list`（跟着 `nextCursor` 翻完），
 * 问到就当场说；`settle` 在回合收尾时有界地等那一问，再按 未加载 / 没启动完 / 清单核实不了 收口。
 * 每个回合只说一次。
 */
export class CodexAshMcpStatus {
  private last: string | null = null;
  private told = false;
  private tools: { state: "unasked" } | { state: "pending"; done: Promise<void> } | { state: "verified" } | { state: "unknown"; why: string } = { state: "unasked" };

  update(params: { name?: unknown; status?: unknown; error?: unknown }): Problem {
    if (params.name !== ASH_MCP_SERVER_NAME || this.last === "ready") return null;
    this.last = String(params.status);
    if (this.last !== "failed" && this.last !== "cancelled") return null;
    return this.tell(unavailable(`codex 报告 ash MCP 启动${this.last === "failed" ? "失败" : "被取消"}`
      + (typeof params.error === "string" && params.error.trim() ? `：${params.error.trim()}` : "")));
  }

  checkTools(request: CodexRequest, threadId: unknown, push: (event: AgentEvent) => void): void {
    if (this.last !== "ready" || this.tools.state !== "unasked") return;
    const done = (async () => {
      const exposed: string[] = [];
      let found = false;
      let cursor: unknown = null;
      do {
        const page = await request("mcpServerStatus/list", { threadId, cursor, limit: 100 }, 10_000) as { data?: unknown; nextCursor?: unknown } | null;
        if (!Array.isArray(page?.data)) throw new Error("应答里没有 data 列表");
        for (const server of page.data as { name?: unknown; tools?: unknown }[]) {
          if (server?.name !== ASH_MCP_SERVER_NAME) continue;
          if (!server.tools || typeof server.tools !== "object") throw new Error("ash 那一项没带工具清单");
          found = true;
          exposed.push(...Object.keys(server.tools));
        }
        cursor = page.nextCursor ?? null;
      } while (cursor);
      if (!found) throw new Error("清单里没有 ash");
      this.tools = { state: "verified" };
      const problem = this.tell(missingTools(exposed, "codex "));
      if (problem) push(problem);
    })().catch((e: unknown) => { this.tools = { state: "unknown", why: (e as Error).message ?? String(e) }; });
    this.tools = { state: "pending", done };
  }

  async settle(waitMs = SETTLE_WAIT_MS): Promise<Problem> {
    if (this.last !== "ready") {
      return this.tell(unavailable(this.last === null ? "codex 这一回合没有加载 ash MCP" : "codex 这一回合 ash MCP 一直没启动完成"));
    }
    if (this.tools.state === "pending") {
      const pending = this.tools.done;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([pending, new Promise<void>((r) => { timer = setTimeout(r, waitMs); })]);
      clearTimeout(timer);
    }
    const tools = this.tools;
    if (tools.state === "verified") return null;
    const why = tools.state === "unknown" ? tools.why : tools.state === "pending" ? "到回合收尾还没问到" : "ash 就绪之后没有问到";
    return this.tell(unverified(`codex 报 ash 已就绪，但它这一回合的工具清单没拿到（${why}），收尾要的那几样在不在说不准`));
  }

  private tell(problem: Problem): Problem {
    if (!problem || this.told) return null;
    this.told = true;
    return problem;
  }
}

const CODEX_ASH_START_FAILED = new RegExp(`MCP (?:client|server)(?: for)? [\`'"]${ASH_MCP_SERVER_NAME}[\`'"].*failed to (?:start|initialize)`, "i");

/**
 * codex exec 一个回合里的 ash：那条路上 codex 不推启动状态、也没有工具清单可问 —— `item` 收
 * `mcp_tool_call`（调成过一次 ash 的工具就是接上了），`stderr` 收原始输出（点名 ash 启动失败的
 * 那一行），`settle` 在回合收尾时给结论。
 */
export class CodexExecAshMcp {
  private worked = false;
  private failedLine: string | null = null;
  private tail = "";

  item(it: { type?: unknown; server?: unknown; status?: unknown }): void {
    if (it.type === "mcp_tool_call" && it.server === ASH_MCP_SERVER_NAME && it.status !== "failed") this.worked = true;
  }

  stderr(chunk: string): void {
    if (this.failedLine) return;
    const lines = (this.tail + chunk).split("\n");
    this.tail = lines.pop()!.slice(-4096);
    const hit = lines.find((l) => CODEX_ASH_START_FAILED.test(l));
    if (hit) this.failedLine = clean(hit);
  }

  settle(): Problem {
    if (this.worked) return null;
    if (!this.failedLine && CODEX_ASH_START_FAILED.test(this.tail)) this.failedLine = clean(this.tail);
    if (this.failedLine) return unavailable(`codex 报告 ash MCP 启动失败：${this.failedLine}`);
    return unverified("这一回合走的是 codex exec，这条路上 codex 不报 ash MCP 连没连上，这一回合也没调成过 ash 的工具"
      + "（让这个执行器走 app-server 就能看到 codex 报的启动状态和工具清单）");
  }
}

const clean = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, "").trim().slice(0, 300);
