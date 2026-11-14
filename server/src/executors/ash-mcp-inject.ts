// ash 自己的 MCP 服务**起跑时由 ash 注入给 CLI**，连没连上以 CLI 启动后自己报出来的为准。
//
// 从前的做法是起跑前去探测用户全局配置里有没有登记 ash、能不能连上（六个文件近两千行），而
// macOS 上探测根本不执行、退回读配置文件 —— 在日常那台机器上并不提供它声称的保证。现在：
//
//  · **注入**：claude 走 `--mcp-config <文件>`，codex 走 `-c mcp_servers.ash={…}`。不依赖
//    用户配置里有没有登记，多人模式下各自的 CLI 配置目录也不用补登记 —— 注入的是这一份 ash
//    自己的入口 + 这个端口，回合身份照旧走环境变量（`turn-identity.ts`）。
//  · **确认**：claude 的 `init` 事件带 `mcp_servers`（name + status + source）和 `tools`，codex
//    app-server 每个回合推 `mcpServer/startupStatus/updated`、ready 之后再问一次
//    `mcpServerStatus/list` 拿工具清单。没连上、连上的不是注入的那条、或者连上了但完成协议的
//    工具不在 agent 手上（用户配置里的 `enabled_tools` / `disabled_tools`、`--disallowedTools`
//    会被深合并保留下来），都推一条红色诊断（落 trace 与 .md，刷新后仍在）—— 完成协议依赖
//    这些工具，缺了的回合不能一声不吭跑完再被判失败。
//  · **只认注入的那个名字**：历史名 `harness` 是用户自己配置里的登记，指着哪个实例、连没连上
//    都不说明这一回合注入的 ash 怎样，拿它的状态替 ash 作证会被到达先后左右结论。
//  · **codex exec 那条路不报启动状态**（2026-11-14 codex 0.153.4 实测：stdout 的 JSON 流和 stderr
//    里都没有 MCP 启动的消息）。那里按本回合自己的记录判：调成过 ash 的工具就是接上了；stderr
//    点名 ash 启动失败就照原话说；都没有就说一句「核实不了」（提示级，不算故障）。
//
// 用户配置里已有同名 `ash` 时（2026-11-14 用 claude 2.1.283 / codex 0.153.4 实测）：
//  · claude：`--mcp-config` 那份**整条生效**（init 里 source=dynamic），不会出现两份同名工具；
//  · codex：`-c` 是**深合并**进用户那张表的 —— 我们写的 command/args/env.ASH_URL/enabled/
//    env_vars 一律以注入为准，用户在那张表里另加的键（`enabled_tools`、`tools.*.approval_mode`、
//    别的 env 变量）保留；用户把 ash 登记成 `url` 型时 codex 整份配置会拒载（回合当场失败、报
//    原话，不静默）。历史名 `harness` 不碰：给不存在的表写 `enabled=false` 会让 codex 拒载整份配置。
//
// 其余执行器不注入，退路就是它们自己配置里的登记（注册执行器时 `mcp-registry/` 会补写），
// ash 不再替它们做任何探测。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent } from "@ash/shared";
import { ASH_MCP_SERVER_NAME } from "@ash/shared/mcp";
import { ashMcpEntry } from "../mcp-registry/register.js";
import type { AshMcpEntry } from "../mcp-registry/types.js";
import { DATA_DIR } from "../paths.js";

/** 起跑时由 ash 注入自己 MCP 的执行器。其余几家走它们自己的配置登记。 */
export const ASH_MCP_INJECTED = ["claude", "codex"] as const;

export const injectsAshMcp = (agentType: string): boolean =>
  (ASH_MCP_INJECTED as readonly string[]).includes(agentType);

/**
 * claude 的 `--mcp-config` 参数。写成文件而不是内联 JSON：Windows 上 claude 是 `.cmd` 垫片，
 * 一段带引号的 JSON 过 cmd.exe 是另一场仗。文件名按内容取哈希 —— 同一个数据目录下可能同时
 * 跑着不同端口的实例（预览、验证实例），各写各的、谁也盖不掉谁，也不需要回收。
 *
 * MCP 产物还没 build 出来也照样注入：那样 CLI 会如实报「ash 没连上」，而不是悄悄退回用户
 * 全局配置里那条 —— 那条可能指着另一个 ash 实例。
 */
export function claudeAshMcpArgs(dir: string = join(DATA_DIR, "ash-mcp"), entry: AshMcpEntry = ashMcpEntry()): string[] {
  const body = `${JSON.stringify({ mcpServers: { [ASH_MCP_SERVER_NAME]: { type: "stdio", ...entry } } }, null, 2)}\n`;
  const file = join(dir, `claude-${createHash("sha256").update(body).digest("hex").slice(0, 12)}.json`);
  try {
    if (!existsSync(file) || readFileSync(file, "utf8") !== body) {
      mkdirSync(dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, body, "utf8");
      renameSync(tmp, file);
    }
  } catch (e) {
    // 写不出来就只能不注入：claude 会退回它自己配置里那条（可能指着别的实例）。init 那一步
    // 据此把这一回合判成「没注入上」并带上原因（`claudeAshMcpProblem`），不让那条连接冒充注入。
    claudeInjectFailure = `写不出注入文件 ${file}：${(e as Error).message}`;
    console.warn(`[ash] ${claudeInjectFailure}`);
    return [];
  }
  claudeInjectFailure = null;
  return ["--mcp-config", file];
}

/** 最近一次写 claude 注入文件失败的原因；写成了就清掉。同一个实例写的是同一份内容，环境性故障对每个回合都一样。 */
let claudeInjectFailure: string | null = null;

/**
 * codex 的 `-c` 覆盖：整条 ash 登记写成一张内联表。`identityVars` 是这一回合要从父进程
 * 按名字透传给 MCP 子进程的身份变量（codex 默认过滤 MCP 子进程环境，见 `turn-identity.ts`）；
 * 只写名字，令牌值不进 argv。TOML 基本字符串与 JSON 字符串的转义规则在这里用得到的部分一致
 * （`\\`、`\"`、`\uXXXX`），Windows 路径里的反斜杠因此成对。
 */
export function codexAshMcpArgs(identityVars: readonly string[], entry: AshMcpEntry = ashMcpEntry()): string[] {
  const str = (s: string) => JSON.stringify(s);
  const env = Object.entries(entry.env).map(([k, v]) => `${k}=${str(v)}`).join(",");
  const fields = [
    `command=${str(entry.command)}`,
    `args=[${entry.args.map(str).join(",")}]`,
    `env={${env}}`,
    "enabled=true",
    ...(identityVars.length ? [`env_vars=[${identityVars.map(str).join(",")}]`] : []),
  ];
  return ["-c", `mcp_servers.${ASH_MCP_SERVER_NAME}={${fields.join(",")}}`];
}

/**
 * 完成协议靠的那几样工具。哪一回合要哪一样由回合类型决定（审查回合要 report_stage，普通回合要
 * complete_task …），这里不替它挑：缺了哪样就如实说哪样。
 */
const PROTOCOL_TOOLS = ["complete_task", "pause_task", "ask_question", "report_stage"] as const;

/** CLI 报告 ash 没接上时推的那一条。不是模型故障，不改本回合成败（成败照旧由交卷判）。 */
function unavailable(detail: string, missing: readonly string[] = PROTOCOL_TOOLS): AgentEvent | null {
  // 宽松完成协议（ASH_LAX_DONE）就是给「agent 够不着 ash MCP」的环境准备的，这句只会是噪音。
  if (process.env.ASH_LAX_DONE) return null;
  const entry = ashMcpEntry().args[0]!;
  const unbuilt = existsSync(entry) ? "" : `。ash 的 MCP 入口 ${entry} 不存在，先在仓库根跑一次 npm run build`;
  const effect = missing.includes("complete_task")
    ? "需要确认完成的回合会记未完成；不需要交卷的纯追问不受影响。"
    : missing.includes("report_stage") ? "审查回合报不上结论。" : "要提问或暂停的回合做不到。";
  return {
    kind: "error",
    affectsTurn: false,
    message: `ash 的工具在这一回合没接上（${detail}${unbuilt}）：${missing.join(" / ")} 都用不了，${effect}`,
  };
}

/** 连上了，但哪几样协议工具不在清单里。`names` 是 CLI 报的 ash 工具名（不带前缀）。 */
function missingTools(names: readonly string[], who: string): AgentEvent | null {
  const missing = PROTOCOL_TOOLS.filter((t) => !names.includes(t));
  if (!missing.length) return null;
  return unavailable(`${who}连上了 ash，但 ${missing.join("、")} 不在 agent 手上 —— 执行器配置限制了 ash 的工具清单`, missing);
}

/**
 * claude `init` 事件 → 没注入上 / 没连上 / 协议工具不全就给一条诊断，都好返回 null。
 *
 * `source` 是 claude 报的来源：注入的那条是 `dynamic`，用户配置里的是 `user` / `project` …。
 * 连上的若不是 `dynamic`，就是注入没生效、claude 退回了它自己配置里那条 —— 那条指着哪个实例
 * 这里说不准，不能拿它的 connected 冒充这一回合接上了。老版本不报 `source` 时只能按连没连上判。
 */
export function claudeAshMcpProblem(servers: unknown, tools?: unknown): AgentEvent | null {
  const list = Array.isArray(servers) ? servers as { name?: unknown; status?: unknown; source?: unknown }[] : [];
  const ash = list.find((s) => s?.name === ASH_MCP_SERVER_NAME);
  const failure = claudeInjectFailure ? `；${claudeInjectFailure}` : "";
  if (!ash) return unavailable(`claude 启动时的 MCP 清单里没有 ash${failure}`);
  if (ash.status !== "connected") return unavailable(`claude 启动时报告 ash MCP 的状态是 ${String(ash.status)}${failure}`);
  if ((ash.source !== undefined && ash.source !== "dynamic") || claudeInjectFailure) {
    return unavailable(`ash 的注入没生效，claude 连上的是它自己配置里那条（来源 ${String(ash.source ?? "未知")}），未必指着这个 ash${failure}`);
  }
  if (!Array.isArray(tools)) return null;
  const prefix = `mcp__${ASH_MCP_SERVER_NAME}__`;
  return missingTools(tools.filter((t): t is string => typeof t === "string" && t.startsWith(prefix)).map((t) => t.slice(prefix.length)), "claude ");
}

/**
 * codex app-server 一个回合里 ash 的启动状态。`update` 收 `mcpServer/startupStatus/updated`，
 * 失败当场给诊断；ash 第一次 ready 时 `wantsToolList` 答一次 true，调用方据此问
 * `mcpServerStatus/list`、把结果交给 `tools`；`settle` 在回合收尾时补一句「从头到尾没报过 /
 * 一直没启动完」。只看注入的那个名字，每个回合只说一次。
 */
export class CodexAshMcpStatus {
  private last: string | null = null;
  private told = false;
  private asked = false;

  update(params: { name?: unknown; status?: unknown; error?: unknown }): AgentEvent | null {
    if (params.name !== ASH_MCP_SERVER_NAME) return null;
    if (this.last === "ready") return null;
    this.last = String(params.status);
    if (this.last !== "failed" && this.last !== "cancelled") return null;
    return this.tell(`codex 报告 ash MCP 启动${this.last === "failed" ? "失败" : "被取消"}`
      + (typeof params.error === "string" && params.error.trim() ? `：${params.error.trim()}` : ""));
  }

  wantsToolList(): boolean {
    if (this.last !== "ready" || this.asked) return false;
    this.asked = true;
    return true;
  }

  /** `mcpServerStatus/list` 的应答：`data[].tools` 以工具名为键。认不出形状就不下结论。 */
  tools(result: unknown): AgentEvent | null {
    const data = (result as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) return null;
    const ash = data.find((s) => (s as { name?: unknown } | null)?.name === ASH_MCP_SERVER_NAME) as { tools?: unknown } | undefined;
    if (!ash || !ash.tools || typeof ash.tools !== "object") return null;
    const problem = missingTools(Object.keys(ash.tools), "codex ");
    return problem ? this.tell(problem) : null;
  }

  settle(): AgentEvent | null {
    if (this.last === "ready") return null;
    return this.tell(this.last === null ? "codex 这一回合没有加载 ash MCP" : "codex 这一回合 ash MCP 一直没启动完成");
  }

  private tell(detail: string | AgentEvent): AgentEvent | null {
    if (this.told) return null;
    this.told = true;
    return typeof detail === "string" ? unavailable(detail) : detail;
  }
}

const CODEX_ASH_START_FAILED = new RegExp(`MCP (?:client|server)(?: for)? [\`'"]${ASH_MCP_SERVER_NAME}[\`'"].*failed to (?:start|initialize)`, "i");

/**
 * codex exec 一个回合里的 ash：那条路上 codex 不推启动状态，只能按本回合自己的记录判 ——
 * `item` 收 `mcp_tool_call`（调成过一次 ash 的工具就是接上了），`stderr` 收原始输出（点名 ash
 * 启动失败的那一行），`settle` 在回合收尾时给结论。
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
    const text = this.tail + chunk;
    const lines = text.split("\n");
    this.tail = lines.pop()!.slice(-4096);
    const hit = lines.find((l) => CODEX_ASH_START_FAILED.test(l));
    if (hit) this.failedLine = hit.replace(/\u001b\[[0-9;]*m/g, "").trim().slice(0, 300);
  }

  settle(): AgentEvent | null {
    if (this.worked || process.env.ASH_LAX_DONE) return null;
    if (!this.failedLine && CODEX_ASH_START_FAILED.test(this.tail)) this.failedLine = this.tail.trim().slice(0, 300);
    if (this.failedLine) return unavailable(`codex 报告 ash MCP 启动失败：${this.failedLine}`);
    return {
      kind: "error",
      level: "notice",
      message: "这一回合走的是 codex exec，这条路上 codex 不报 ash MCP 连没连上，这一回合也没调成过 ash 的工具："
        + "要是它没交卷，核实不了是 ash 没接上还是它自己漏了（让这个执行器走 app-server 就能看到 codex 报的启动状态）。",
    };
  }
}
