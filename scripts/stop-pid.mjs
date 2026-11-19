// `stop.mjs --pid <n>`:结束一个**没在应答**的服务进程(升级时起得慢、卡在迁移里的那种 —— 端口上问不到它,stop.mjs 的
// 常规那条路停不了),并且**等它真的退出**才算成功。升级打印的退回命令里就是这一行,后面紧跟着退库名、换代码、装旧依赖:
// 只发一个信号就往下走,它要是正卡在同步迁移里,信号得等迁移做完才处理,后面几步就跟一个还活着的服务撞上。
//
// 动手之前先认人:那个 pid 的命令行得是在跑服务入口(server/dist/index.js,或 SERVER_ENTRY 指的那个)—— 退回命令可能隔了很久
// 才被照抄,pid 早被别的程序复用了。认不准就不动。结束方式跟 restart 同一条(killServerProcess:POSIX 发 SIGTERM 让它收摊;
// Windows 整树结束、但保住活得过重启的 agent 壳)。
import { IS_WINDOWS, isPidAlive, killPid, killServerProcess, listProcesses, sleep } from "./platform.mjs";

const norm = (p) => (IS_WINDOWS ? p.replace(/\\/g, "/").toLowerCase() : p);

async function gone(pid, seconds) {
  for (const until = Date.now() + seconds * 1000; Date.now() < until; await sleep(250)) if (!isPidAlive(pid)) return true;
  return !isPidAlive(pid);
}

/** 返回退出码:0 它已经不在了 / 1 等满了还没退 / 2 认不准它是谁、没动它。 */
export async function stopPid({ pid, entry, force, timeoutSec, say }) {
  if (!isPidAlive(pid)) { say(`  · pid ${pid} 已经不在了`); return 0; }
  const row = listProcesses().find((r) => r.pid === pid);
  if (!row || !norm(row.command).includes(norm(entry))) {
    say(`  ✕ pid ${pid} ${row ? `现在跑的是「${row.command.slice(0, 120)}」,不是 Navi 服务(${entry})` : "在进程表里查不出来,认不准它是不是 Navi 服务"},没动它。`);
    say("    它要是早就退了、号被别的程序用了,这一行跳过就行。");
    return 2;
  }
  say(`▶ 结束服务进程 pid ${pid},等它退出(最多 ${timeoutSec}s)…`);
  try { killServerProcess(pid); } catch (error) { say(`  ✕ 没结束成:${error.message}`); return 1; }
  if (await gone(pid, timeoutSec)) { say(`  ✓ pid ${pid} 已退出`); return 0; }
  if (!force) {
    say(`  ✕ 等了 ${timeoutSec}s 它还没退(可能还卡在迁移里)。等一会儿再跑这一行;确定要强行结束就加 --force。别先往下做。`);
    return 1;
  }
  if (IS_WINDOWS) {
    try { killServerProcess(pid, [], { force: true }); } catch { /* 下面按还活着报 */ }
  } else {
    try { process.kill(pid, "SIGKILL"); } catch { killPid(pid); }
  }
  if (await gone(pid, 10)) { say(`  ✓ pid ${pid} 已强行结束`); return 0; }
  say(`  ✕ 强行结束之后 pid ${pid} 还在,手工处理掉它再往下做。`);
  return 1;
}
