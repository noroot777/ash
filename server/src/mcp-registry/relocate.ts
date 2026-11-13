// 宿主那条 ash 登记搬进新隔离档时,**只重定位 ash 自己的安装位置**。
//
// 宿主那条照搬是为了保住用户的写法(远程目标、cwd、timeout、工具白名单、额外 env……)。但它里面
// 有两个字段描述的不是用户的意思,而是「当初装 ash 的那一份在哪」:
//   · MCP 脚本入口 `…/mcp/dist/index.js` —— 从仓库版换到独立 app 之后它还指着旧检出,旧仓库一删
//     就起不来;即使还在,跑的也是旧版本的 MCP;
//   · 启动它的 node —— 独立 app 所在的机器可能根本没装 node。
// 所以只改这两处,**其余字段原样留着**。上一版(第 2 轮审查)按启动形状判「这是默认登记」就整条
// 丢掉重拼,把用户配的 cwd/timeout/env/工具白名单一起吞了,只写 `HARNESS_URL` 的远端目标也被
// 改成了本机 —— 形状相同不等于没有定制。
//
// node 只在**跑不起来**时才换(裸名在 PATH 上找不到 / 绝对路径不存在):用户自己挑的那个 node 能用
// 就不动。脚本入口只要不是当前这一份就换成当前这一份。改不动(TOML 的写法超出能安全改写的范围)
// 就原样搬:宁可留一条可能要手工改的登记,也不丢用户的设置。
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { ASH_MCP_SERVER_NAME } from "@ash/shared/mcp";
import { scanCodexToml } from "../codex-toml.js";
import { boundaryKey } from "../platform.js";
import type { AshMcpLaunch, AshMcpNameFact } from "./types.js";

export interface RelocateTarget {
  /** 当前这份 MCP 入口。 */
  entry: string;
  /** 换 node 时用哪个(`mcpNodeCommand()`)。 */
  node: string;
  /** 这个启动命令在这台机器上跑得起来吗。 */
  runnable: (command: string) => boolean;
}

/** `<node> <…/mcp/dist/index.js> …` —— 启动的是 ash 自己的 MCP 脚本。 */
export function launchesAshMcp(command: unknown, args: unknown): boolean {
  if (typeof command !== "string" || !Array.isArray(args)) return false;
  const runner = (command.split(/[\\/]/).pop() ?? "").replace(/\.exe$/i, "");
  if (!/^(node|nodejs)$/i.test(runner)) return false;
  const script = args[0];
  return typeof script === "string" && /(^|[\\/])mcp[\\/]dist[\\/]index\.js$/i.test(script);
}

/** 重定位之后的 command 与 args;两处都不用改就回 null。 */
function relocatedLaunch(command: string, args: string[], to: RelocateTarget): { command: string; args: string[] } | null {
  const script = args[0]!;
  const sameEntry = boundaryKey(resolve(script)) === boundaryKey(resolve(to.entry));
  const nextCommand = to.runnable(command) ? command : to.node;
  if (sameEntry && nextCommand === command) return null;
  return { command: nextCommand, args: [to.entry, ...args.slice(1)] };
}

export function relocateHostFact(fact: AshMcpNameFact | null, to: RelocateTarget): AshMcpNameFact | null {
  if (!fact) return fact;
  if (fact.raw) {
    const raw = relocateRaw(fact.raw, to);
    return raw ? { ...fact, raw } : fact;
  }
  if (fact.block && fact.launch) {
    const block = relocateTomlBlock(fact.block, fact.launch, to);
    return block ? { ...fact, block } : fact;
  }
  return fact;
}

/** JSON 两族:`{command, args}`(mcpServers 族)或 `command: [node, script, …]`(opencode)。键序不动。 */
function relocateRaw(raw: Record<string, unknown>, to: RelocateTarget): Record<string, unknown> | null {
  if (Array.isArray(raw.command)) {
    const [command, ...args] = raw.command;
    if (!launchesAshMcp(command, args) || !args.every((a) => typeof a === "string")) return null;
    const next = relocatedLaunch(command as string, args as string[], to);
    return next ? { ...raw, command: [next.command, ...next.args] } : null;
  }
  if (!launchesAshMcp(raw.command, raw.args) || !(raw.args as unknown[]).every((a) => typeof a === "string")) return null;
  const next = relocatedLaunch(raw.command as string, raw.args as string[], to);
  return next ? { ...raw, command: next.command, args: next.args } : null;
}

/**
 * TOML 族:只改主表里**单行**的 `command = "…"` 和 `args = [ … ]` 两行,别的字节一个不动;改完用
 * 同一个扫描器读回来核对,对不上就放弃(回 null,调用方原样搬)。
 */
function relocateTomlBlock(block: string, launch: AshMcpLaunch, to: RelocateTarget): string | null {
  const { command, args } = launch;
  if (!command || !launchesAshMcp(command, args) || !(args as unknown[]).every((a) => typeof a === "string")) return null;
  const next = relocatedLaunch(command, args as string[], to);
  if (!next) return null;
  const lines = block.split("\n");
  const end = lines.findIndex((line, i) => i > 0 && /^\s*\[/.test(line));
  const main = end === -1 ? lines.length : end;
  let hits = 0;
  for (let i = 1; i < main; i += 1) {
    const commandLine = /^(\s*command\s*=\s*)("(?:[^"\\]|\\.)*"|'[^']*')(\s*(?:#.*)?)$/.exec(lines[i]!);
    if (commandLine) {
      lines[i] = `${commandLine[1]}${JSON.stringify(next.command)}${commandLine[3]}`;
      hits += 1;
      continue;
    }
    const argsLine = /^(\s*args\s*=\s*)\[[^\]]*\](\s*(?:#.*)?)$/.exec(lines[i]!);
    if (argsLine) {
      lines[i] = `${argsLine[1]}[${next.args.map((a) => JSON.stringify(a)).join(", ")}]${argsLine[2]}`;
      hits += 1;
    }
  }
  if (hits !== 2) return null;
  const out = lines.join("\n");
  const back = scanCodexToml(out).servers.get(ASH_MCP_SERVER_NAME)?.spec;
  const ok = back?.command === next.command && Array.isArray(back.args)
    && back.args.length === next.args.length && back.args.every((a, i) => a === next.args[i]);
  return ok ? out : null;
}

/** 启动命令在这台机器上找得到吗:绝对路径看文件在不在,裸名按 PATH 找。 */
export function commandRunnable(command: string, onPath: (bin: string) => boolean): boolean {
  return isAbsolute(command) ? existsSync(command) : onPath(command);
}
