// 独立 app 首次启动时「替本机 CLI 接好 ash MCP」—— 以及把**接是接了、却指向别的 ash** 的那几家
// 如实交回去。
//
// 补接本身不另写一份:逐家走的就是注册执行器那一下用的 `ensureAshMcp`(缺了才写、已有一律不覆盖、
// codex 先问它本人)。这里只多做两件事:
//  · 只问**这台机器上装了**的那几家(PATH 上找得到它的命令),没装的不碰它的配置目录;
//  · 补完再读一次最终生效的那条,看它是不是指向**这一份** ash(这份代码里的 MCP 入口 + 这个端口)。
//    不是的话**不改**:那条可能是用户自己写的、也可能正连着仓库里的开发实例,改不改由用户定 ——
//    交回去的是「现在指向哪、要指向这里该改成什么」,app 原样摆给用户。
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { AGENT_TYPES } from "@ash/shared";
import { ensureAshMcp, hostCliConfigDir, hostCliConfigFile } from "../auth/user-cli-mcp.js";
import { resolveBin } from "../executors/bin-resolve.js";
import { cliSpec } from "../executors/catalog/index.js";
import { currentListeningPort } from "../listening-port.js";
import { ashMcpMechanism } from "./catalog.js";
import { builtinEntry } from "./register.js";
import { ashMcpHostSources, readingFor, resolveAshMcp } from "./sources.js";
import type { AshMcpEntry, AshMcpLaunch } from "./types.js";

export interface HostAshMcp {
  agentType: string;
  /** 这家的用户级配置文件(给用户看「改哪份」)。 */
  file: string | null;
  /** added=这次补上的 / ours=本来就指向这里 / elsewhere=登记在、指向别处 / failed=没补成 */
  state: "added" | "ours" | "elsewhere" | "failed";
  /** elsewhere:现在那条怎么起。 */
  current?: string;
  /** elsewhere:要指向这里,command / args / ASH_URL 该是什么。 */
  wanted?: string;
  /** failed:没补成的原因(原样来自补接那一层)。 */
  detail?: string;
}

/** 逐家补接并归类。幂等:已经接好的机器上只是几次文件读。 */
export async function setUpHostAshMcp(): Promise<HostAshMcp[]> {
  const wanted = builtinEntry();
  const out: HostAshMcp[] = [];
  for (const agentType of AGENT_TYPES) {
    const mechanism = ashMcpMechanism(agentType);
    if (mechanism?.kind !== "file") continue;
    if (!cliSpec(agentType).bins.some((bin) => resolveBin(bin))) continue;
    const dir = hostCliConfigDir(agentType);
    if (!dir) continue;
    const file = hostCliConfigFile(agentType);
    const reading = readingFor(mechanism);
    const effective = () => resolveAshMcp(ashMcpHostSources(agentType), reading);
    const before = effective().state;
    const ensured = await ensureAshMcp(dir, agentType);
    if (!ensured.configured) {
      out.push({ agentType, file, state: "failed", detail: ensured.problem ?? "没补成，原因不明" });
      continue;
    }
    const launch = effective().fact?.launch ?? null;
    if (wanted && pointsAt(launch, wanted)) {
      out.push({ agentType, file, state: before === "present" ? "ours" : "added" });
    } else {
      out.push({
        agentType, file, state: "elsewhere",
        current: launch ? describe(launch.command ?? null, stringArgs(launch.args), launch.ashUrl ?? null) : "认不出它怎么起",
        ...(wanted ? { wanted: describe(wanted.command, wanted.args, wanted.env.ASH_URL ?? null) } : {}),
      });
    }
  }
  return out;
}

/** 这条登记起的是不是这份 ash 的 MCP、连的是不是这个端口。 */
export function pointsAt(launch: AshMcpLaunch | null, wanted: AshMcpEntry): boolean {
  if (!launch?.command) return false;
  const [entry] = wanted.args;
  if (!entry || !stringArgs(launch.args).some((arg) => samePath(arg, entry))) return false;
  // `node` 这种裸命令只跟裸命令比:它跟着 PATH 走,换不换 node 不归这条登记管。
  const commandMatches = wanted.command.includes("/")
    ? samePath(launch.command, wanted.command)
    : launch.command === wanted.command;
  return commandMatches && portOf(launch.ashUrl ?? DEFAULT_MCP_URL) === portOf(wanted.env.ASH_URL ?? localUrl());
}

/** MCP 服务自己没拿到 ASH_URL 时连的地址(mcp/src/runtime.ts)。 */
const DEFAULT_MCP_URL = "http://localhost:4317";
const localUrl = () => `http://127.0.0.1:${currentListeningPort() ?? 4317}`;

function portOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  } catch {
    return "";
  }
}

function samePath(a: string, b: string): boolean {
  const real = (p: string) => (existsSync(p) ? realpathSync(p) : resolve(p));
  return real(a) === real(b);
}

const stringArgs = (args: unknown): string[] =>
  Array.isArray(args) ? args.filter((a): a is string => typeof a === "string") : [];

function describe(command: string | null, args: string[], ashUrl: string | null): string {
  return [
    `command = ${JSON.stringify(command ?? "")}`,
    `args = [${args.map((a) => JSON.stringify(a)).join(", ")}]`,
    `ASH_URL = ${JSON.stringify(ashUrl ?? DEFAULT_MCP_URL)}`,
  ].join("\n");
}
