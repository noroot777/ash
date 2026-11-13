// 宿主那条 ash 登记搬进新隔离档时,**只重定位 ash 自己的安装位置**。
//
// 宿主那条照搬是为了保住用户的写法(远程目标、cwd、timeout、工具白名单、额外 env……)。但它里面
// 有两个字段描述的不是用户的意思,而是「当初装 ash 的那一份在哪」:
//   · MCP 脚本入口 `…/mcp/dist/index.js` —— 从仓库版换到独立 app 之后它还指着旧检出,旧仓库一删
//     就起不来;即使还在,跑的也是旧版本的 MCP;
//   · 启动它的 node —— 独立 app 所在的机器可能根本没装 node。
// 所以只改这两处,**其余字段原样留着**。更早一版(第 2 轮审查)按启动形状判「这是默认登记」就整条
// 丢掉重拼,把用户配的 cwd/timeout/env/工具白名单一起吞了 —— 形状相同不等于没有定制。
//
// node 只在**跑不起来**时才换(找不到、或者不是可执行文件):用户自己挑的那个 node 能用就不动。
// 脚本入口只要不是当前这一份就换成当前这一份。
//
// **改不动就如实说改不动**(第 3 轮审查):认出了这是 ash 自己的脚本、也知道它该换,却因为写法
// 改写不了而原样搬过去,发布出来的是一条已知会失效的登记,还报成功。那种情况回 `why`,登记失败,
// 由用户手工改。
import { ASH_MCP_SERVER_NAME } from "@ash/shared/mcp";
import { resolve } from "node:path";
import { scanCodexToml, tomlPairSpans } from "../codex-toml.js";
import { boundaryKey } from "../platform.js";
import type { AshMcpLaunch, AshMcpNameFact } from "./types.js";

export interface RelocateTarget {
  /** 当前这份 MCP 入口。 */
  entry: string;
  /** 换 node 时用哪个(`mcpNodeCommand()`)。 */
  node: string;
  /** 这个启动命令在这台机器上跑得起来吗(找得到、是可执行文件)。 */
  runnable: (command: string) => boolean;
}

export type RelocateResult = { fact: AshMcpNameFact | null } | { why: string };

const ASH_SCRIPT = /(^|[\\/])mcp[\\/]dist[\\/]index\.js$/i;

/**
 * ash 自己的 MCP 脚本在 args 里的位置:`<node> [node 选项…] <…/mcp/dist/index.js> …`。
 * 不是这种写法(启动器不是 node、脚本前夹着非选项参数)回 -1 —— 那是用户自己的启动方式,不碰。
 */
export function ashScriptIndex(command: unknown, args: unknown): number {
  if (typeof command !== "string" || !Array.isArray(args)) return -1;
  const runner = (command.split(/[\\/]/).pop() ?? "").replace(/\.exe$/i, "");
  if (!/^(node|nodejs)$/i.test(runner)) return -1;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (typeof arg !== "string") return -1;
    if (ASH_SCRIPT.test(arg)) return i;
    if (!arg.startsWith("-")) return -1;
  }
  return -1;
}

export const launchesAshMcp = (command: unknown, args: unknown): boolean => ashScriptIndex(command, args) >= 0;

/** 重定位之后的 command 与 args;两处都不用改就回 null。调用方保证 `ashScriptIndex >= 0`。 */
function relocatedLaunch(command: string, args: unknown[], to: RelocateTarget): { command: string; args: unknown[] } | null {
  const at = ashScriptIndex(command, args);
  const sameEntry = boundaryKey(resolve(args[at] as string)) === boundaryKey(resolve(to.entry));
  const nextCommand = to.runnable(command) ? command : to.node;
  if (sameEntry && nextCommand === command) return null;
  return { command: nextCommand, args: args.map((arg, i) => (i === at ? to.entry : arg)) };
}

export function relocateHostFact(fact: AshMcpNameFact | null, to: RelocateTarget): RelocateResult {
  if (!fact) return { fact };
  if (fact.raw) return { fact: { ...fact, raw: relocateRaw(fact.raw, to) } };
  if (fact.block && fact.launch) {
    const block = relocateTomlBlock(fact.block, fact.launch, to);
    return typeof block === "string" ? { fact: { ...fact, block } } : block;
  }
  return { fact };
}

/** JSON 两族:`{command, args}`(mcpServers 族)或 `command: [node, …]`(opencode)。键序不动。 */
function relocateRaw(raw: Record<string, unknown>, to: RelocateTarget): Record<string, unknown> {
  if (Array.isArray(raw.command)) {
    const [command, ...args] = raw.command;
    if (!launchesAshMcp(command, args)) return raw;
    const next = relocatedLaunch(command as string, args, to);
    return next ? { ...raw, command: [next.command, ...next.args] } : raw;
  }
  if (!launchesAshMcp(raw.command, raw.args)) return raw;
  const next = relocatedLaunch(raw.command as string, raw.args as unknown[], to);
  return next ? { ...raw, command: next.command, args: next.args } : raw;
}

/**
 * TOML 族:按结构扫描器给出的**语句范围**只替换主表里 `command` / `args` 那两条(跨行的数组、
 * 加了引号的键都认),别的字节一个不动;改完用同一个扫描器读回来核对。
 * 不是 ash 自己的脚本 → 原文;是、但改不了 → `{ why }`。
 */
function relocateTomlBlock(block: string, launch: AshMcpLaunch, to: RelocateTarget): string | { why: string } {
  const { command, args } = launch;
  if (!command || !launchesAshMcp(command, args)) return block;
  const next = relocatedLaunch(command, args as unknown[], to);
  if (!next) return block;
  const refuse = { why: unmovable(next) };
  const spans = tomlPairSpans(block);
  if (!spans) return refuse;
  const main = ["mcp_servers", ASH_MCP_SERVER_NAME];
  const inMain = (key: string) => spans.filter((s) => s.table.length === 2 && s.table.every((seg, i) => seg === main[i])
    && s.path.length === 1 && s.path[0] === key);
  const commandSpan = inMain("command");
  const argsSpan = inMain("args");
  if (commandSpan.length !== 1 || argsSpan.length !== 1) return refuse;
  const lines = block.split("\n");
  // 从后往前换,前面那条的行号才不会被挪动。
  const edits = [
    { span: commandSpan[0]!, text: `command = ${JSON.stringify(next.command)}` },
    { span: argsSpan[0]!, text: `args = [${next.args.map((a) => JSON.stringify(a)).join(", ")}]` },
  ].sort((a, b) => b.span.first - a.span.first);
  for (const { span, text } of edits) {
    const indent = /^\s*/.exec(lines[span.first]!)![0];
    lines.splice(span.first, span.last - span.first + 1, `${indent}${text}`);
  }
  const out = lines.join("\n");
  const back = scanCodexToml(out).servers.get(ASH_MCP_SERVER_NAME)?.spec;
  const ok = back?.command === next.command && Array.isArray(back.args)
    && back.args.length === next.args.length && back.args.every((a, i) => a === next.args[i]);
  return ok ? out : refuse;
}

function unmovable(next: { command: string; args: unknown[] }): string {
  return "宿主机上那条 ash MCP 登记还指着旧的安装位置，但它的写法 ash 没法安全改写，所以没有把它搬进来"
    + `（照搬过来是一条起不来的登记）。请把宿主那条的 command 改成 ${JSON.stringify(next.command)}、`
    + `args 改成 ${JSON.stringify(next.args)} 再重试`;
}
