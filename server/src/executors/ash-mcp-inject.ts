// ash 自己的 MCP 服务**起跑时由 ash 注入给 CLI**，连没连上以 CLI 启动后自己报出来的为准。
//
// 从前的做法是起跑前去探测用户全局配置里有没有登记 ash、能不能连上（六个文件近两千行），而
// macOS 上探测根本不执行、退回读配置文件 —— 在日常那台机器上并不提供它声称的保证。现在：
//
//  · **注入**：claude 走 `--mcp-config <文件>`，codex 走 `-c mcp_servers.ash={…}`。不依赖
//    用户配置里有没有登记，多人模式下各自的 CLI 配置目录也不用补登记 —— 注入的是这一份 ash
//    自己的入口 + 这个端口，回合身份照旧走环境变量（`turn-identity.ts`）。
//  · **确认**：claude 的 `init` 事件带 `mcp_servers`（name + status），codex app-server 每个
//    回合推 `mcpServer/startupStatus/updated`。没连上就推一条红色诊断（落 trace 与 .md，刷新
//    后仍在）—— 完成协议依赖这些工具，连不上的回合不能一声不吭跑完再被判失败。
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
import { ASH_MCP_SERVER_NAME, LEGACY_ASH_MCP_SERVER_NAME } from "@ash/shared/mcp";
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
    console.warn(`[ash] 写不出 claude 的 ash MCP 注入文件(${file})：${String(e)}`);
    return [];
  }
  return ["--mcp-config", file];
}

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

const OURS = [ASH_MCP_SERVER_NAME, LEGACY_ASH_MCP_SERVER_NAME];

/** CLI 报告 ash 没连上时推的那一条。不是模型故障，不改本回合成败（成败照旧由交卷判）。 */
function unavailable(detail: string): AgentEvent | null {
  // 宽松完成协议（ASH_LAX_DONE）就是给「agent 够不着 ash MCP」的环境准备的，这句只会是噪音。
  if (process.env.ASH_LAX_DONE) return null;
  const entry = ashMcpEntry().args[0]!;
  const unbuilt = existsSync(entry) ? "" : `。ash 的 MCP 入口 ${entry} 不存在，先在仓库根跑一次 npm run build`;
  return {
    kind: "error",
    affectsTurn: false,
    message: `ash 的工具在这一回合没接上（${detail}${unbuilt}）：complete_task / ask_question / pause_task 都用不了，`
      + "需要确认完成的回合会记未完成；不需要交卷的纯追问不受影响。",
  };
}

/** claude `init` 事件里的 `mcp_servers` → 没连上就给一条诊断，连上了返回 null。 */
export function claudeAshMcpProblem(servers: unknown): AgentEvent | null {
  const list = Array.isArray(servers) ? servers as { name?: unknown; status?: unknown }[] : [];
  const ours = list.filter((s) => OURS.includes(String(s?.name)));
  if (ours.some((s) => s.status === "connected")) return null;
  if (!ours.length) return unavailable("claude 启动时的 MCP 清单里没有 ash");
  return unavailable(`claude 启动时报告 ash MCP 的状态是 ${ours.map((s) => String(s.status)).join("、")}`);
}

/**
 * codex app-server 一个回合里 ash 的启动状态。`update` 收 `mcpServer/startupStatus/updated`，
 * 失败当场给诊断；`settle` 在回合收尾时补一句「从头到尾没报过 / 一直没启动完」。每个回合只说一次。
 */
export class CodexAshMcpStatus {
  private last: string | null = null;
  private told = false;

  update(params: { name?: unknown; status?: unknown; error?: unknown }): AgentEvent | null {
    if (!OURS.includes(String(params.name))) return null;
    if (this.last === "ready") return null;
    this.last = String(params.status);
    if (this.last !== "failed" && this.last !== "cancelled") return null;
    return this.tell(`codex 报告 ash MCP 启动${this.last === "failed" ? "失败" : "被取消"}`
      + (typeof params.error === "string" && params.error.trim() ? `：${params.error.trim()}` : ""));
  }

  settle(): AgentEvent | null {
    if (this.last === "ready") return null;
    return this.tell(this.last === null ? "codex 这一回合没有加载 ash MCP" : "codex 这一回合 ash MCP 一直没启动完成");
  }

  private tell(detail: string): AgentEvent | null {
    if (this.told) return null;
    this.told = true;
    return unavailable(detail);
  }
}
