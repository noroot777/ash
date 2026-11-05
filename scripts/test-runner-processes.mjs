// 并行执行器（test-runner.mjs）收场时怎么看进程、怎么发信号。
//
// 每个观测都带 `complete`：进程清单拿不全（ps 起不来、输出被截断、/proc 读不了）时为 false，
// 调用方据此判「无法确认已收干净」，不能把「没看见」当成「没有了」。
//
// 认得出来的边界：叶子的进程组、还连在进程树上的后代、继承了归属记号的进程。认不出来的：
// 清空环境、又脱离进程组、父进程还先退了的后代 —— macOS 没有 cgroup/Job 这类把整次运行圈住
// 的内核边界，ash 的验收门禁在 macOS 上是同一个限制（server/src/accept-gate-confinement-macos.ts）。
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";

const listProcesses = (columns) => {
  const listed = spawnSync("ps", ["-A", "-ww", ...columns], { encoding: "utf8", maxBuffer: 64 << 20 });
  const complete = !listed.error && listed.status === 0;
  return { lines: complete ? listed.stdout.split("\n") : [], complete };
};

/** roots 底下还连在进程树上的全部后代。 */
export function descendants(roots) {
  const { lines, complete } = listProcesses(["-o", "pid=,ppid="]);
  const children = new Map();
  for (const line of lines) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid > 0 && ppid > 0) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const pids = [];
  const stack = [...roots];
  while (stack.length) {
    for (const child of children.get(stack.pop()) ?? []) {
      pids.push(child);
      stack.push(child);
    }
  }
  return { pids, complete };
}

// 叶子起的每个进程都从环境里继承一个归属记号（`<变量>=<叶子序号>`）。测试 detached 出去、
// 父进程又先退了的子进程会被过继给 init，按父子关系和进程组都再也认不出是谁的；记号跟着
// 进程走，靠它才收得到。
/** 环境里带着 `variable`（给了 leafIndex 就只认这一条叶子的）的进程。 */
export function marked(variable, leafIndex) {
  const wanted = leafIndex === undefined ? `${variable}=` : `${variable}=${leafIndex} `;
  if (process.platform === "linux") return markedOnLinux(wanted);
  // macOS 的 ps -E 把环境接在命令行后面，以空格分隔。
  const { lines, complete } = listProcesses(["-E", "-o", "pid=,command="]);
  const pids = [];
  for (const line of lines) {
    const pid = Number(line.trim().split(/\s/, 1)[0]);
    if (pid > 0 && pid !== process.pid && `${line} `.includes(` ${wanted}`)) pids.push(pid);
  }
  return { pids, complete };
}

function markedOnLinux(wanted) {
  let entries;
  try {
    entries = readdirSync("/proc");
  } catch {
    return { pids: [], complete: false };
  }
  const uid = process.getuid?.();
  const pids = [];
  let complete = true;
  for (const entry of entries) {
    const pid = Number(entry);
    if (!(pid > 0) || pid === process.pid) continue;
    try {
      const environ = `${readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").join(" ")} `;
      if (environ.startsWith(wanted) || environ.includes(` ${wanted}`)) pids.push(pid);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ESRCH") continue; // 已经退了
      // 别的用户的进程读不了是常态，也不可能是我们起的；自己的读不了就是没看全。
      try {
        if (statSync(`/proc/${pid}`).uid === uid) complete = false;
      } catch {
        // 刚好退了。
      }
    }
  }
  return { pids, complete };
}

/** 发信号（负数 = 整个进程组）。返回目标是否还在：已经退了为 false。 */
export const signal = (pid, name) => {
  try {
    process.kill(pid, name);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

export const pause = (ms) => new Promise((wait) => setTimeout(wait, ms));
