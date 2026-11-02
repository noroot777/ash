import { bus } from "../src/bus.js";
import { dbClient } from "../src/db/index.js";
import { acceptTask } from "../src/task-accept.js";

const [taskId, phase] = process.argv.slice(2);
const execute = dbClient.execute.bind(dbClient);
Object.defineProperty(dbClient, "execute", { value: async (...args: Parameters<typeof execute>) => {
  const statement = args[0];
  const sql = typeof statement === "string" ? statement : (statement as { sql?: string }).sql ?? "";
  const pidUpdate = /^update "accept_gate_runs" set "pid"/i.test(sql);
  // 结算的终态那一句（accept-gate-settle.ts）：之前死 = 结论已认领、进程已收、还没落终态；
  // 之后死 = 终态落了、续验收 / 交修还没办。
  const finalUpdate = /^update "accept_gate_runs" set "status"/i.test(sql);
  // 红了的交接先记 handoff_at 再投递（accept-gate-handoff.ts）：之后死 = 记了「发起过」、一个字没送出去。
  const handoffMark = /^update "accept_gate_runs" set "handoff_at"/i.test(sql);
  const values = (statement as { args?: unknown[] }).args ?? [];
  const settlementWrite = /^update "accept_gate_runs" set "settlement"/i.test(sql);
  // 交接落定时销账（settlement=null）：之前死 = 原话已经落盘、回执已到，记号还没清。
  const deliveredClear = settlementWrite && values[0] === null;
  // 拿到回合、起跑之前把「开始投递了」记进欠账：之后死 = 可能送到了也可能没有。
  const deliveryClaim = settlementWrite && typeof values[0] === "string" && values[0].includes("\"delivering\":\"");
  // 尾段（「点头之后」那几站）的 durable 进度置位：之后死 = accepted 已落、发布命令还没跑。
  const tailMark = /^update "tasks" set .*"accepted_tail_pending"/i.test(sql) && values.some(value => value === 1 || value === true);
  // 会话文件是异步写流：等它刷进盘里再死，钉的是「原话已经落盘、记号还没清」那一刻。
  if (deliveredClear && phase === "before-delivered-clear") await new Promise(resolve => setTimeout(resolve, 500));
  if ((pidUpdate && phase === "before-pid") || (finalUpdate && phase === "before-final")
    || (deliveredClear && phase === "before-delivered-clear")) process.kill(process.pid, "SIGKILL");
  const result = await execute(...args);
  if ((pidUpdate && phase === "after-pid") || (finalUpdate && phase === "after-final")
    || (handoffMark && phase === "after-handoff-mark") || (deliveryClaim && phase === "after-delivery-claim")
    || (tailMark && phase === "after-tail-mark")) process.kill(process.pid, "SIGKILL");
  return result;
} });
// 续验收合并已经提交（stage=merged 的事务落了，广播紧跟其后）、清理和最终验收还没做。
const publish = bus.publish.bind(bus);
bus.publish = (event) => {
  publish(event);
  if (phase === "after-merged" && event.type === "task.stage" && event.stage === "merged") process.kill(process.pid, "SIGKILL");
};
await acceptTask(taskId);
// 命令已经放行、正在跑的时候 ash 整个死掉（test-accept-gate-takeover.ts 的四条分流都从这里起）。
if (phase === "armed") process.kill(process.pid, "SIGKILL");
setInterval(() => {}, 1_000);
