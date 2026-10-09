// 哨兵那一组工具：把一条长跑命令挂在任务上，它每吐一行就把任务唤醒一次。
//
// 这几段 description 是**注入给 agent 的判据**，不是字段文档。三件事全靠措辞立住：
// ① 什么时候该用它（而不是 sleep + 反复 cat 日志）；② 命令本身就是过滤器，别让它吐
// 流水账；③ 起了哨兵的那一轮必须用 pause_task 收尾，用 complete_task 收尾哨兵会被
// 一起收走 —— 这条是系统行为，agent 看不到别处。
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  MONITOR_MAX_EVENTS,
  MONITOR_MAX_PER_TASK,
  MONITOR_MAX_TIMEOUT_MS,
  MONITOR_MIN_TIMEOUT_MS,
} from "@ash/shared/monitor";
import { call, fail, ok } from "../runtime.js";

const hours = (ms: number) => `${Math.round(ms / 3_600_000)} 小时`;

export function registerMonitorTools(server: McpServer): void {
server.registerTool(
  "start_monitor",
  {
    title: "起一个哨兵盯住长跑命令",
    description:
      "把一条长跑命令挂在任务上，由 **ash** 起进程（不在你的进程树里），它的 stdout **每输出一行就是一条事件**：ash 会把这些行攒成一条消息送回这个任务、把你唤醒。你不必轮询。\n\n" +
      "**什么时候用它**：你要等的事情以「分钟~小时」计，而且过程中会往某处写进展——跑批、训练、长构建、爬取、转码、轮询一个外部状态。典型手法是让命令自己做过滤：`tail -F build.log | grep --line-buffered -E '^\\[DONE\\]|ERROR'`。**什么时候不用**：几秒内就能出结果的命令（直接跑完它）；需要你立刻看全文的（直接读文件）。\n\n" +
      "**命令就是过滤器，这是最重要的一条**：每一行事件都会唤醒任务跑一个真实回合，花的是真钱。所以别 `tail -F` 整份日志，要 grep 到「你真会据此做事」的那几行。管道每一级都得逐行冲刷（`grep --line-buffered`、`awk` 里 `fflush()`；`head` 做不到，别用）。同时**别只匹配成功**：只 grep 成功标记的哨兵在崩溃、卡死、异常退出时一声不吭，而「安静」和「还在跑」长得一模一样——把失败特征（`Traceback|ERROR|FAILED|Killed`）一起写进交替分支里。\n\n" +
      "**起了哨兵的那一轮，用 pause_task 收尾，不要用 complete_task**：任务一落 done/failed/canceled，它名下的哨兵会被系统一并停掉（哨兵唯一的出口就是唤醒这个任务，任务都结束了再留着只会白烧回合）。pause_task 的 resumePrompt 写清「被哨兵叫醒后该干什么」。\n\n" +
      `**上限**：一个任务同时最多 ${MONITOR_MAX_PER_TASK} 个哨兵；单个哨兵推够 ${MONITOR_MAX_EVENTS} 条事件自动停（到顶会明确告诉你）；timeoutMs 在 ${MONITOR_MIN_TIMEOUT_MS / 1000} 秒到 ${hours(MONITOR_MAX_TIMEOUT_MS)} 之间，缺省 2 小时，到点进程被杀掉并推一条收尾事件。\n\n` +
      "**它活得比你这一轮久**：进程由 ash 起、输出落文件，你的回合结束、会话结束、ash 重启都不会把它带走。所以不需要自己 `fork + setsid` 或 `nohup` —— 那样起的进程 ash 看不见也停不掉，留下的是没人认领的僵尸。",
    inputSchema: {
      taskId: z.string().describe("要挂哨兵的任务 id（通常就是你自己，任务 prompt 前言里有）"),
      command: z.string().min(1).describe("交给 shell 跑的长跑命令。它自己负责过滤：只吐你真会据此做事的行，成功与失败特征都要覆盖"),
      description: z.string().optional().describe("一句话说明你在盯什么（会出现在每条事件的抬头和界面上）。省略则用命令本身"),
      cwd: z.string().optional().describe("工作目录。缺省＝这个任务自己的工作目录"),
      timeoutMs: z.number().optional().describe(`盯多久（毫秒），缺省 2 小时，上限 ${hours(MONITOR_MAX_TIMEOUT_MS)}。到点杀掉进程并推一条收尾事件`),
    },
  },
  async ({ taskId, command, description, cwd, timeoutMs }) => {
    try { return ok(await call("POST", `/tasks/${taskId}/monitors`, { command, description, cwd, timeoutMs })); }
    catch (e) { return fail(e); }
  },
);

server.registerTool(
  "stop_monitor",
  {
    title: "停掉一个哨兵",
    description:
      "杀掉哨兵的进程并停止推送。等到的事情已经发生、或者发现过滤写得太松在刷屏时用它。停掉是终态，不能再续——要继续盯就用改好的命令重起一个。任务自己落终态或被归档时，它名下的哨兵会被系统自动停掉，那种情况不用你管。",
    inputSchema: {
      monitorId: z.string().describe("哨兵 id（start_monitor 的返回值里，也写在每条事件的抬头上）"),
      reason: z.string().optional().describe("为什么停，会记进任务时间线"),
    },
  },
  async ({ monitorId, reason }) => {
    try { return ok(await call("POST", `/monitors/${monitorId}/stop`, { reason })); }
    catch (e) { return fail(e); }
  },
);

server.registerTool(
  "list_monitors",
  {
    title: "看这个任务挂了哪些哨兵",
    description:
      "列出一个任务名下全部哨兵（含已结束的）及各自状态：running=还在盯；exited=命令自己跑完了；expired=盯满了时长；stopped=被停掉或推满了事件上限；lost=ash 重启后那个进程已经不在了。被唤醒后想确认「是谁叫的我、它还在不在」时用它。",
    inputSchema: { taskId: z.string().describe("任务 id") },
  },
  async ({ taskId }) => {
    try { return ok(await call("GET", `/tasks/${taskId}/monitors`)); }
    catch (e) { return fail(e); }
  },
);
}
