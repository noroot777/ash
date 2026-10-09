// 「哨兵活得过 server 重启」那一条用的子进程。两个角色，由 argv[0] 选：
//   v1 = 扮演重启前那个 server：起哨兵、等它推出几批、硬退出（不给收尾的机会）
//   v2 = 扮演重启后那个 server：reattachMonitors() 接回来，等它自己跑完
// 它必须住在仓库里（而不是像别的夹具那样临时写进 tmp 目录）：这份代码要 import
// drizzle-orm，而 tmp 目录下的模块解析不到仓库的 node_modules。
import { writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { monitors } from "../src/db/schema.js";
import { reattachMonitors, startMonitor } from "../src/monitors.js";

const [mode, taskId, stateFile, command] = process.argv.slice(2);
// 保活：monitors.ts 里的定时器全 unref 了（真 server 由 HTTP 监听撑着事件循环，
// 不该让一个 tail 定时器挡住关服）。独立进程里没人撑，得自己来。
const keepAlive = setInterval(() => {}, 500);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (mode === "v1") {
  const started = await startMonitor({ taskId: taskId!, command: command!, description: "重启也要活着" });
  if (!started.ok) { console.error(started.error); process.exit(3); }
  for (let i = 0; i < 100; i++) {
    const row = (await db.select().from(monitors).where(eq(monitors.id, started.monitor.id))).at(0);
    if ((row?.events ?? 0) >= 2) break;
    await sleep(100);
  }
  writeFileSync(stateFile!, JSON.stringify({ monitorId: started.monitor.id, pid: started.monitor.pid }));
  process.exit(0); // ← 模拟 `npm run restart` 那句 kill：连 finally 都不跑
}

if (mode === "v2") {
  const result = await reattachMonitors();
  for (let i = 0; i < 300; i++) {
    const row = (await db.select().from(monitors).where(eq(monitors.taskId, taskId!))).at(0);
    if (row?.status === "exited") break;
    await sleep(100);
  }
  writeFileSync(stateFile!, JSON.stringify(result));
  process.exit(0);
}

clearInterval(keepAlive);
console.error(`未知模式：${mode}`);
process.exit(2);
