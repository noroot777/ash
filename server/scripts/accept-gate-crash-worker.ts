import { dbClient } from "../src/db/index.js";
import { acceptTask } from "../src/task-accept.js";

const [taskId, phase] = process.argv.slice(2);
const execute = dbClient.execute.bind(dbClient);
Object.defineProperty(dbClient, "execute", { value: async (...args: Parameters<typeof execute>) => {
  const statement = args[0];
  const sql = typeof statement === "string" ? statement : (statement as { sql?: string }).sql ?? "";
  const pidUpdate = /^update "accept_gate_runs" set "pid"/i.test(sql);
  if (pidUpdate && phase === "before-pid") process.kill(process.pid, "SIGKILL");
  const result = await execute(...args);
  if (pidUpdate && phase === "after-pid") process.kill(process.pid, "SIGKILL");
  return result;
} });
await acceptTask(taskId);
// 命令已经放行、正在跑的时候 ash 整个死掉（test-accept-gate-takeover.ts 的四条分流都从这里起）。
if (phase === "armed") process.kill(process.pid, "SIGKILL");
setInterval(() => {}, 1_000);
