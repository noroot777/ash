// `stop.mjs --pid <n> --born <出生时刻>`:结束一个**没在应答**的服务进程(升级时起得慢、卡在迁移里的那种 —— 端口上问不到它,
// stop.mjs 的常规那条路停不了),并且**等它真的退出**才算成功。升级打印的退回命令里就是这一行,后面紧跟着退库名、换代码、装旧依赖:
// 只发一个信号就往下走,它要是正卡在同步迁移里,信号得等迁移做完才处理,后面几步就跟一个还活着的服务撞上。
//
// 动手之前先认人,三条都得过(退回命令可能隔了很久才被照抄,号码早被别的程序复用了):
//   · 出生时刻跟升级起它那一刻记下的严格相等(process-birth.mjs)—— 这才是「还是当初那一个」,命令行里出现某个路径片段证明不了;
//     读不出来按认不准处理;
//   · 命令行里有一个参数**就是**服务入口(server/dist/index.js,或 SERVER_ENTRY 指的那个),不是某个参数里含着这段字;
//   · 它要是已经在端口上应答了(慢服务后来起来了、可能已经在干活),这里不管:交给 stop.mjs 的常规那条路,先问有没有任务在跑。
// 强杀(--force)之前再认一遍。结束方式跟 restart 同一条(killServerProcess:POSIX 发 SIGTERM 让它收摊;Windows 整树结束、
// 但保住活得过重启的 agent 壳)。
import { IS_WINDOWS, isPidAlive, killServerProcess, listProcesses, localJson, sleep } from "./platform.mjs";
import { processBirth } from "./process-birth.mjs";

const norm = (p) => (IS_WINDOWS ? p.replace(/\\/g, "/").toLowerCase() : p);

/** 命令行里有没有一个参数正好是 entry(引号包着的也算;是某个参数的一部分不算)。 */
function runsEntry(command, entry) {
  const want = norm(entry).replace(/^\.\//, "");
  const args = norm(command).match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return args.some((a) => {
    const arg = a.replace(/^["']|["']$/g, "").replace(/^\.\//, "");
    return arg === want || arg.endsWith(`/${want}`);
  });
}

async function gone(pid, seconds) {
  for (const until = Date.now() + seconds * 1000; Date.now() < until; await sleep(250)) if (!isPidAlive(pid)) return true;
  return !isPidAlive(pid);
}

/** 还是不是当初那一个服务进程:null = 是;否则是没动它的原因。 */
function notOurs(pid, born, entry) {
  const now = processBirth(pid);
  if (now === "gone") return "gone";
  if (now === null) return `读不出 pid ${pid} 的出生时刻,认不准它还是不是升级起的那个服务`;
  if (now !== born) return `pid ${pid} 现在是另一个进程(出生时刻 ${now},升级起的那个是 ${born}),号码被复用了`;
  const row = listProcesses().find((r) => r.pid === pid);
  if (!row) return `pid ${pid} 在进程表里查不出来,认不准它是不是 Navi 服务`;
  if (!runsEntry(row.command, entry)) return `pid ${pid} 跑的是「${row.command.slice(0, 120)}」,不是 Navi 服务(${entry})`;
  return null;
}

/** 返回退出码:0 它已经不在了 / 1 等满了还没退 / 2 认不准它是谁、或它已经在应答,没动它。 */
export async function stopPid({ pid, born, entry, port, force, timeoutSec, say }) {
  const why = notOurs(pid, born, entry);
  if (why === "gone") { say(`  · pid ${pid} 已经不在了`); return 0; }
  if (why) {
    say(`  ✕ ${why},没动它。`);
    say("    它要是早就退了、号被别的程序用了,这一行跳过就行。");
    return 2;
  }
  const health = await localJson(port, "/api/health");
  if (health?.pid === pid) {
    say(`  ✕ pid ${pid} 已经在 :${port} 上应答了(后来起来了,可能已经在干活),这里不按号码结束它。`);
    say("    改用 node scripts/stop.mjs(先问有没有任务在跑),再接着往下做。");
    return 2;
  }
  say(`▶ 结束服务进程 pid ${pid},等它退出(最多 ${timeoutSec}s)…`);
  try { killServerProcess(pid); } catch (error) { say(`  ✕ 没结束成:${error.message}`); return 1; }
  if (await gone(pid, timeoutSec)) { say(`  ✓ pid ${pid} 已退出`); return 0; }
  if (!force) {
    say(`  ✕ 等了 ${timeoutSec}s 它还没退(可能还卡在迁移里)。等一会儿再跑这一行;确定要强行结束就加 --force。别先往下做。`);
    return 1;
  }
  const again = notOurs(pid, born, entry);
  if (again === "gone") { say(`  ✓ pid ${pid} 已退出`); return 0; }
  if (again) { say(`  ✕ 要强行结束之前再认了一遍:${again},没动它。`); return 2; }
  if (IS_WINDOWS) {
    try { killServerProcess(pid, [], { force: true }); } catch { /* 下面按还活着报 */ }
  } else {
    try { process.kill(pid, "SIGKILL"); } catch { /* 已经没了 */ }
  }
  if (await gone(pid, 10)) { say(`  ✓ pid ${pid} 已强行结束`); return 0; }
  say(`  ✕ 强行结束之后 pid ${pid} 还在,手工处理掉它再往下做。`);
  return 1;
}
