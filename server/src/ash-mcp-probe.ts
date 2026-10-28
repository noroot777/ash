// ash MCP 预检的**探测执行层**：起一条只读 CLI 子命令，把两个输出通道原样带回来，
// 并保证**自己起的进程不会留在机器上**。
//
// 单独一层是因为这里只有一个职责：进程的生死。判据（谁算有登记、哪些目录要问）在
// `ash-mcp-reachability.ts`，那边一次预检会调这里很多遍。
//
// ── 为什么不能用 execFile 的 timeout ────────────────────────────────────────
//
// 第 3 轮审查在 Windows 真机上实测：15 秒超时到点后，预检确实返回了「问不出来」并放行，
// 但自己起的那个 node 查询进程还活着（`hungPid=6024, childStillAlive=true`），25 秒兜底
// 也没来，最后靠审查脚本 taskkill 才收回。原因是 npm 装的 CLI 是 `.cmd` 垫片，真实启动
// 形如 `cmd.exe /c codex.cmd …`——`execFile` 的 timeout 只向 **cmd.exe 这层包装**发信号，
// 底下真正干活的那个进程没人管。而这个进程不在任何任务的 RunHandle 里，停止任务也找不回
// 它，重复超时就重复累积。
//
// 所以超时自己管：`killTree` 打的是整棵树（Windows `taskkill /T /F`，POSIX 打进程组，
// 所以 spawn 时要 `detached` 让它自成一组），**并且等到确认回收之后**才返回「问不出来」。
// 真回收不掉就如实喊一声，不假装干净。
import { spawn, type ChildProcess } from "node:child_process";
import { IS_WINDOWS, killTree } from "./platform.js";
import { resolveLaunch } from "./executors/bin-resolve.js";

export interface ProbeResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 单次探测最多收这么多输出。只读子命令的正常输出远小于此，超了说明问错了东西。 */
const MAX_OUTPUT = 8 * 1024 * 1024;
/** 下刀之后给它多久咽气。两轮都没咽就如实上报，不再干等。 */
const REAP_GRACE_MS = 3_000;

const delay = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms).unref?.(); });

/**
 * 杀掉整棵树并**确认它真的没了**。
 *
 * 两轮同样的刀：Windows 的 `taskkill` 是异步发出去的，第一轮返回时它可能还没落地；
 * POSIX 这边第一轮通常就够。两轮都没等到 close 事件才喊 —— 到这一步机器上确实还留着
 * 东西，瞒下来只会让下一个人从头查一遍。
 */
async function reapTree(child: ChildProcess, closed: Promise<unknown>): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  const settled = (): Promise<boolean> =>
    Promise.race([closed.then(() => true), delay(REAP_GRACE_MS).then(() => false)]);
  killTree(pid, "SIGKILL");
  if (await settled()) return;
  killTree(pid, "SIGKILL");
  if (await settled()) return;
  console.warn(
    `[ash] ash MCP 预检的探测进程 pid=${pid} 超时后两轮 killTree 都没能回收，`
    + "它可能还留在机器上（这条探测不属于任何任务，停止任务找不回它）",
  );
}

/**
 * 跑一条只读 CLI 子命令。返回 null = **问不出来**（起不来、超时、被杀），调用方一律放行。
 *
 * 两件事是踩过的：
 *  ① **必须走 `resolveLaunch`**，不能把 `resolveBin` 的结果直接交给 spawn。
 *     `bin-resolve.ts` 的文件头写得很清楚：那个函数「只回答在不在，不回答怎么起」——
 *     Windows 上 npm 装的 CLI 是 `.cmd` 垫片，直接起它拿到的是 `EINVAL`
 *     （第 2 位审查者 F2，真机实测 `…\codex.cmd` → EINVAL → 被当成「问不出来」放行）。
 *  ② **两个输出通道分开回**。codex 成功退出、stdout 是完整 JSON，stderr 却可能同时有
 *     一句无关警告（实测：创建 PATH 别名失败）。拼在一起再 `JSON.parse` 就把一份有效
 *     答案解析成了「看不懂」（第 2 位审查者 F3）。
 */
export async function probeCli(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
  timeoutMs: number,
): Promise<ProbeResult | null> {
  const plan = resolveLaunch(bin, args);
  if (!plan) return null;

  let child: ChildProcess;
  try {
    child = spawn(plan.file, plan.args, {
      env,
      cwd,
      windowsHide: true,
      // POSIX：自成进程组，killTree 的 `process.kill(-pid)` 才打得到整组（垫片脚本
      // 起的孙进程正是靠这条收得回来）。Windows 没有进程组这回事，taskkill /T 按
      // 父子树走，不需要也不能用 detached。
      detached: !IS_WINDOWS,
      stdio: ["ignore", "pipe", "pipe"],
      ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
  } catch {
    return null;                                     // cwd 不存在之类的同步失败
  }

  let stdout = "";
  let stderr = "";
  const take = (soFar: string, chunk: unknown): string =>
    soFar.length >= MAX_OUTPUT ? soFar : (soFar + String(chunk)).slice(0, MAX_OUTPUT);
  child.stdout?.on("data", (c) => { stdout = take(stdout, c); });
  child.stderr?.on("data", (c) => { stderr = take(stderr, c); });

  let spawnFailed = false;
  const closed = new Promise<number | null>((resolve) => {
    child.once("error", () => { spawnFailed = true; resolve(null); });
    child.once("close", (code) => { resolve(code); });
  });

  const raced = await Promise.race([
    closed.then((code) => ({ timedOut: false, code })),
    delay(timeoutMs).then(() => ({ timedOut: true, code: null as number | null })),
  ]);

  if (raced.timedOut) {
    await reapTree(child, closed);                   // 确认回收之后才说「问不出来」
    return null;
  }
  if (spawnFailed) return null;
  return { code: raced.code ?? 0, stdout, stderr };
}
