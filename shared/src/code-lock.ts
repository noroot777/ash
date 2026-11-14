// 「这份 ash 代码正被这个进程用着」—— mac app 换包与进程启动共用的那把锁
// （desktop/macos/scripts/install-app.sh，第 4 轮审查 F2）。
//
// 上一版是进程启动时往 /tmp 写一条登记、安装器去扫登记。查登记和换包之间没有互斥：最后一次检查
// 之后起来的进程照样被换掉脚下的代码，包改名之后登记里的路径也对不上了；登记写失败还会悄悄变成
// 「没人用」。改成一把锁：
//   · bundle 的代码根里自带一个空文件 `.in-use`（bundle-runtime.mjs 放进去）。跑包里代码的服务和 MCP
//     在读任何业务模块之前，以共享锁打开它（O_SHLOCK，flock 语义），一直拿到进程结束。进程死了
//     内核自动放锁，不会留下死登记；锁在文件本身上，包改名、经软链或相对路径拉起都不影响。
//   · 安装器换包时对同一个文件拿排他锁（lockf -t 0），从最后一次检查一直拿到换完：拿不到 = 有人在用，
//     不装；换包期间新起的进程在这把锁上等，等到时包已经换好，接着读到的是一整份新代码。
//   · 等到锁之后核对锁着的还是不是路径上那个文件（换完包旧文件已经删了），不是就换上新的那个再锁。
//   · 锁拿不到（文件缺了、打不开）不照跑：说清原因退出，否则安装器会把它当成没人用。
// 所以入口只做这一件事，业务模块一律在拿到锁之后动态加载（server/src/index.ts、mcp/src/index.ts）。
// 仓库检出不换包，不锁。
import { closeSync, constants, fstatSync, openSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 代码根里那个锁文件的名字（bundle-runtime.mjs、bundle-users.sh、install-app.sh 用同一个名字）。 */
export const CODE_LOCK_NAME = ".in-use";
// macOS <fcntl.h> 的 O_SHLOCK：open 的同时拿 flock 共享锁。node 的 fs.constants 里没有这一项。
const O_SHLOCK = 0x10;

function pause(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function refuse(file: string, why: string): never {
  process.stderr.write(`[ash] 拿不到代码锁 ${file}（${why}），不启动：不拿锁就跑，换包时会被当成没人在用。\n`);
  process.exit(78);
}

export function holdCodeLock(): void {
  if (process.platform !== "darwin") return;
  // node 加载模块时已经按真实路径解析过，这里不再 realpath：换包的那一下路径暂时不存在，realpath 会失败。
  const root = fileURLToPath(new URL("../..", import.meta.url));
  if (!root.includes(".app/Contents/")) return;
  const file = join(root, CODE_LOCK_NAME);
  const deadline = Date.now() + 30_000;
  for (;;) {
    let fd: number;
    try {
      try {
        fd = openSync(file, constants.O_RDONLY | O_SHLOCK | constants.O_NONBLOCK);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EAGAIN" && code !== "EWOULDBLOCK") throw error;
        // 安装器正拿着排他锁换包：等它换完（只有最后检查 + 两次改名那几秒）。
        fd = openSync(file, constants.O_RDONLY | O_SHLOCK);
      }
    } catch (error) {
      // 两次改名之间路径暂时不在：稍等再来。一直不在就是包不完整。
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && Date.now() < deadline) { pause(200); continue; }
      refuse(file, String((error as Error).message ?? error));
    }
    const held = fstatSync(fd);
    let current: ReturnType<typeof statSync> | null = null;
    try { current = statSync(file); } catch {}
    if (current && current.ino === held.ino && current.dev === held.dev) return;
    // 锁着的是换下去的旧文件：放掉，锁路径上现在那一个。
    closeSync(fd);
    if (Date.now() >= deadline) refuse(file, "换包后路径上的锁文件一直对不上");
  }
}
