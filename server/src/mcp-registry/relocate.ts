// 宿主那条 ash 登记搬进新隔离档时,**只重定位 ash 自己的安装位置**。
//
// 宿主那条照搬是为了保住用户的写法(远程目标、cwd、timeout、工具白名单、额外 env、启动选项……)。
// 但它里面有两样东西描述的不是用户的意思,而是「当初装 ash 的那一份在哪」:
//   · ash 的 MCP 脚本路径 `…/mcp/dist/index.js` —— 从仓库版换到独立 app 之后它还指着旧检出,
//     旧仓库一删就起不来;即使还在,跑的也是旧版本;
//   · 启动它的 node —— 独立 app 所在的机器可能根本没装 node。
// 所以只改这两样,**其余字段原样留着**(第 2 轮审查:按启动形状整条重拼会吞掉用户的定制)。
//
// 认脚本**不解析 argv 语义**(第 3、4 轮审查:按「脚本前只能是 `-` 开头的选项」去找,`--require <文件>`
// 这类带独立取值的选项就漏掉了;node 的选项表也不是这里该维护的东西)。不变量只有两条:
//   ① 改写:命令或任一参数的**整个值**就是一条 ash 脚本路径 → 换成当前这一份(位置、启动器都不限);
//      命令本身就是那个脚本 → 改成「node + 当前入口」。涉及 ash 脚本时,跑不起来的 node 换成能跑的,
//      用户自己挑的能用就不动。
//   ② 收口:改写之后,启动方式里只要还看得见**不是当前这一份**的 ash 脚本路径(嵌在 `--require=…`、
//      `sh -c "node …"` 这类参数里,无法安全改写)→ 登记失败并说清该改成什么。不发布一条已知会失效、
//      还报成功的登记。
import { ASH_MCP_SERVER_NAME } from "@ash/shared/mcp";
import { resolve } from "node:path";
import { scanCodexToml, tomlPairSpans } from "../codex-toml.js";
import { boundaryKey } from "../platform.js";
import type { AshMcpNameFact } from "./types.js";

export interface RelocateTarget {
  /** 当前这份 MCP 入口。 */
  entry: string;
  /** 换 node 时用哪个(`mcpNodeCommand()`)。 */
  node: string;
  /** 这个启动命令在这台机器上跑得起来吗(找得到、是可执行文件)。 */
  runnable: (command: string) => boolean;
}

export type RelocateResult = { fact: AshMcpNameFact | null } | { why: string };

type Launch = { command: string; args: unknown[] };

const ASH_SCRIPT_TAIL = /(^|[\\/])mcp[\\/]dist[\\/]index\.js$/i;
const ABSOLUTE = /^([\\/]|~[\\/]|[a-z]:[\\/])/i;

/**
 * 整个值就是一条 ash 脚本路径——不是「以它结尾」:`--require=/x/mcp/dist/index.js`、
 * `node /x/mcp/dist/index.js` 也以它结尾,整条换掉会把前面那半吞了。判不准的一律不算,交给收口那条报失败。
 * 绝对路径里允许空格(`My Projects`),但空格后面又像一个参数/路径的开头,就是一整条命令行。
 */
function isAshScript(value: unknown): value is string {
  if (typeof value !== "string" || !ASH_SCRIPT_TAIL.test(value) || /^-|["'`;|&$<>]/.test(value)) return false;
  if (!ABSOLUTE.test(value)) return !/[\s=]/.test(value);
  return !/\s([-~\\/]|[a-z]:[\\/])/i.test(value);
}

/** 值里**提到了** ash 脚本路径(可能嵌在别的写法里)。 */
const MENTIONS_ASH_SCRIPT = /mcp[\\/]dist[\\/]index\.js/i;

const isNodeRunner = (command: string): boolean =>
  /^(node|nodejs)$/i.test((command.split(/[\\/]/).pop() ?? "").replace(/\.exe$/i, ""));

export function relocateHostFact(fact: AshMcpNameFact | null, to: RelocateTarget): RelocateResult {
  if (!fact) return { fact };
  if (fact.raw) {
    const raw = relocateRaw(fact.raw, to);
    return typeof raw === "string" ? { why: raw } : { fact: { ...fact, raw } };
  }
  if (fact.block) {
    // 截出来的那段跟扫整份文件得到的启动方式对不上(启动字段写在表头之外),而后者提到了旧的 ash
    // 脚本:照搬这一段等于丢掉那半,同样是一条起不来的登记。
    const own = scanCodexToml(fact.block).servers.get(ASH_MCP_SERVER_NAME)?.spec;
    const launch = fact.launch;
    if (launch && !sameLaunch(own, launch) && staleMention({ command: launch.command ?? "",
      args: Array.isArray(launch.args) ? launch.args : [] }, to)) {
      return { why: unmovable("宿主那条的启动字段不全在 [mcp_servers.ash] 表里", null, to) };
    }
    const block = relocateTomlBlock(fact.block, to);
    return "why" in block ? { why: block.why } : { fact: { ...fact, block: block.text } };
  }
  return { fact };
}

/**
 * 不变量 ①:返回改写后的启动方式;不涉及 ash 脚本、或者已经全是当前这一份 → null(原样)。
 * 不变量 ②:改写不了的提及 → 字符串(给用户看的原因)。
 */
export function relocateLaunch(launch: Launch, to: RelocateTarget): Launch | null | string {
  const current = (value: string) => boundaryKey(resolve(value)) === boundaryKey(resolve(to.entry));
  const stale = (value: unknown): value is string => isAshScript(value) && !current(value);
  let { command, args } = launch;
  let touched = false;
  if (stale(command)) {
    command = to.node;
    args = [to.entry, ...args];
    touched = true;
  }
  args = args.map((arg) => (stale(arg) ? ((touched = true), to.entry) : arg));
  const involved = touched || [command, ...args].some(isAshScript);
  if (involved && command !== to.node && isNodeRunner(command) && !to.runnable(command)) {
    command = to.node;
    touched = true;
  }
  const next = { command, args };
  const leftover = staleMention(next, to);
  if (leftover) return unmovable(`参数 ${JSON.stringify(leftover)} 里嵌着旧的 ash 脚本路径`, null, to);
  return touched ? next : null;
}

const sameLaunch = (a: { command?: string | null; args?: unknown } | undefined, b: { command?: string | null; args?: unknown }) =>
  a?.command === b.command && JSON.stringify(a?.args ?? null) === JSON.stringify(b.args ?? null);

/** 改写之后还看得见的、不是当前这一份的 ash 脚本提及。 */
function staleMention(launch: Launch, to: RelocateTarget): string | null {
  for (const value of [launch.command, ...launch.args]) {
    if (typeof value === "string" && MENTIONS_ASH_SCRIPT.test(value) && !value.includes(to.entry)) return value;
  }
  return null;
}

/** JSON 两族:`{command, args}`(mcpServers 族)或 `command: [node, …]`(opencode)。键序不动。 */
function relocateRaw(raw: Record<string, unknown>, to: RelocateTarget): Record<string, unknown> | string {
  const array = Array.isArray(raw.command);
  const parts = array ? (raw.command as unknown[]) : [raw.command, ...(Array.isArray(raw.args) ? raw.args : [])];
  const [command, ...args] = parts;
  if (typeof command !== "string") return raw;
  const next = relocateLaunch({ command, args }, to);
  if (typeof next === "string") return next;
  if (!next) return raw;
  return array ? { ...raw, command: [next.command, ...next.args] } : { ...raw, command: next.command, args: next.args };
}

/**
 * TOML 族:按结构扫描器给出的**语句范围**只替换主表里 `command` / `args` 那两条(跨行的数组、
 * 加了引号的键都认;没有 args 就在 command 后面补一条),别的字节一个不动;改完用同一个扫描器读回核对。
 */
function relocateTomlBlock(block: string, to: RelocateTarget): { text: string } | { why: string } {
  const spec = scanCodexToml(block).servers.get(ASH_MCP_SERVER_NAME)?.spec;
  const spans = tomlPairSpans(block);
  const inMain = (key: string) => (spans ?? []).filter((s) => s.table.length === 2 && s.table[0] === "mcp_servers"
    && s.table[1] === ASH_MCP_SERVER_NAME && s.path.length === 1 && s.path[0] === key);
  const commandSpan = inMain("command");
  const argsSpan = inMain("args");
  const command = spec?.command;
  // 读不全启动方式(没有 command、或者 args 写着却不是字符串数组):不知道该怎么改。提到了旧的
  // ash 脚本就不能照搬;没提到的跟 ash 的安装位置无关,原样留着。
  if (!command || !spans || (argsSpan.length && !Array.isArray(spec.args))) {
    const mention = MENTIONS_ASH_SCRIPT.test(block) && !block.includes(to.entry);
    return mention ? { why: unmovable("宿主那段 TOML 的启动方式读不全", null, to) } : { text: block };
  }
  const next = relocateLaunch({ command, args: (spec.args as string[] | null | undefined) ?? [] }, to);
  if (typeof next === "string") return { why: next };
  if (!next) return { text: block };
  const refuse = { why: unmovable("宿主那段 TOML 的写法没法安全改写", next, to) };
  if (commandSpan.length !== 1 || argsSpan.length > 1) return refuse;
  const lines = block.split("\n");
  const argsText = `args = [${next.args.map((a) => JSON.stringify(a)).join(", ")}]`;
  const commandText = `command = ${JSON.stringify(next.command)}`;
  // 从后往前换,前面那条的行号才不会被挪动。
  const edits = [
    { first: commandSpan[0]!.first, last: commandSpan[0]!.last, text: argsSpan.length ? [commandText] : [commandText, argsText] },
    ...argsSpan.map((s) => ({ first: s.first, last: s.last, text: [argsText] })),
  ].sort((a, b) => b.first - a.first);
  for (const edit of edits) {
    const indent = /^\s*/.exec(lines[edit.first]!)![0];
    lines.splice(edit.first, edit.last - edit.first + 1, ...edit.text.map((t) => `${indent}${t}`));
  }
  const out = lines.join("\n");
  const back = scanCodexToml(out).servers.get(ASH_MCP_SERVER_NAME)?.spec;
  const ok = back?.command === next.command && Array.isArray(back.args)
    && back.args.length === next.args.length && back.args.every((a, i) => a === next.args[i]);
  return ok ? { text: out } : refuse;
}

function unmovable(what: string, next: Launch | null, to: RelocateTarget): string {
  const target = next
    ? `command 改成 ${JSON.stringify(next.command)}、args 改成 ${JSON.stringify(next.args)}`
    : `ash 的 MCP 脚本换成 ${JSON.stringify(to.entry)}`;
  return `宿主机上那条 ash MCP 登记还指着旧的安装位置（${what}），ash 没法安全改写它，所以没有把它搬进来`
    + `（照搬过来是一条起不来的登记）。请在宿主那条里把 ${target} 再重试`;
}
