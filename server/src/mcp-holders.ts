// 「现在刷新 MCP，会掐断谁手里的通道」——给 `scripts/restart.mjs` 第 3 步的预警。
//
// 背景（2026-08-06 事故）：harness MCP 不是常驻端口，而是**每个 agent 会话各自
// spawn 的 stdio 子进程**（`node <repo>/mcp/dist/index.js`）。restart 的第 3 步会
// `pkill` 掉它们好让下次调用用上新代码——对闲着的会话这没代价，对**正在干活的**
// agent 就是当场掐断它的交卷：那次 codex 跑完 12 分钟验证，`report_stage(verified)`
// 连撞两次 `Transport closed`，结论没写回，验证白跑。
//
// 注意这跟「重启打断任务」是两码事，别混在一起看：agent 输出走文件之后，重启
// :4317 对单飞任务是无感的（`reattach.ts` 的 survives），**能伤到它们的恰恰只剩
// 第 3 步这一刀**。所以闸得单独数这一类。
//
// 兜底不是替代：`mcp-handoff.ts` 会在回合结算时把「确定没送达」的交卷调用补录回
// 来，但白名单只有三个工具，其余（dispatch/ask_question…）丢了就是丢了。能不掐
// 断当然更好。
import { join } from "node:path";
import { REPO_DIR } from "./paths.js";
import { boundaryKey, listProcesses } from "./platform.js";

/** 本仓库那份 MCP 的入口路径。 */
const MCP_ENTRY = join(REPO_DIR, "mcp", "dist", "index.js");

export type PsRow = { pid: number; ppid: number; command: string };

/**
 * 把一条命令行切成 token。**必须认双引号**:Windows 上 node 的常驻位置是
 * `C:\Program Files\nodejs\node.exe`,命令行里带引号且**路径含空格** —— 按空白
 * 硬切会把它切成 `"C:\Program` 和 `Files\nodejs\node.exe"` 两段,下面的形状判据
 * 直接全盘失效(一个 MCP 都认不出来,预警永远说「没人受影响」)。
 * POSIX 上带引号的命令行少见,但认了也不会错。
 */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of command.trim()) {
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      if (cur) tokens.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

/**
 * 这一行是不是一个 harness MCP 子进程。
 *
 * 判据比 restart 脚本的 `pkill -f "$REPO/mcp/dist/index.js\$"` 再紧一格：**必须是
 * `<node> <…/mcp/dist/index.js>` 这个形状**（脚本路径正好是第一个参数）。光靠
 * 「命令行里含这个路径」会连 claude/codex 本体一起算进去——它们把同一个路径写在
 * `--mcp-config` 之类的参数里；光靠末尾锚定也不够，`claude … --mcp-config <路径>`
 * 同样是以它结尾的。
 *
 * 路径本身放宽到「任意 `…/mcp/dist/index.js`」而不是死磕本仓库：worktree、软链、
 * 用户手动配到别处的副本都还是同一份 MCP，而误判的代价只是多提示一句。
 *
 * Windows 三处差异,都在这里收口:解释器名带 `.exe`、分隔符是 `\`、NTFS 不分大小写。
 */
function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? "";
}

export function isMcpProcess(command: string): boolean {
  const tokens = tokenize(command);
  const script = tokens.at(1);
  if (!script) return false;
  const runner = baseName(tokens[0]!).replace(/\.exe$/i, "");
  if (!/^(node|nodejs|bun|deno)$/i.test(runner)) return false;
  if (boundaryKey(script) === boundaryKey(MCP_ENTRY)) return true;
  return /(^|[\\/])mcp[\\/]dist[\\/]index\.js$/i.test(script);
}

/**
 * 哪些 agent 进程的后代里有 harness MCP。纯函数，ps 表怎么来的不关它的事（单测
 * `npm -w server run test:mcp-handoff`）。
 *
 * 从每个 MCP 进程**往上**走 ppid，比从 agent 往下遍历便宜得多：MCP 进程个位数，
 * agent 的后代动辄上百。
 */
export function holdersOf(rows: PsRow[], agentPids: number[]): number[] {
  const wanted = new Set(agentPids.filter((pid) => Number.isInteger(pid) && pid > 0));
  if (!wanted.size) return [];
  const parent = new Map<number, number>();
  const mcpPids: number[] = [];
  for (const row of rows) {
    parent.set(row.pid, row.ppid);
    if (isMcpProcess(row.command)) mcpPids.push(row.pid);
  }
  const hit = new Set<number>();
  for (const start of mcpPids) {
    let cur = parent.get(start);
    // 深度上限只是防环（ps 快照理论上不会有环，但这条路不值得为它挂掉）。
    for (let depth = 0; cur !== undefined && cur > 1 && depth < 64; depth += 1) {
      if (wanted.has(cur)) {
        hit.add(cur);
        break;
      }
      cur = parent.get(cur);
    }
  }
  return [...hit];
}

export function parsePsTable(text: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! });
  }
  return rows;
}

const PS_TIMEOUT_MS = 3000;

/**
 * 实际去问一遍系统。进程表拿不到/超时一律返回空——预警拿不到不该拖垮重启这条路。
 *
 * 走 platform.listProcesses 而不是自己 `execFile("ps", …)`:Windows 上压根没有
 * `ps`,那条路会静默返回空集,于是预警**永远说「没人受影响」** —— 一个报平安的
 * 假阳性，比报错还难发现。
 */
export async function findMcpChannelHolders(agentPids: number[]): Promise<Set<number>> {
  if (!agentPids.length) return new Set();
  return new Set(holdersOf(await listProcesses(PS_TIMEOUT_MS), agentPids));
}
