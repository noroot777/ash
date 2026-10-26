// 哨兵那一组工具：把一条长跑命令挂在任务上，它每吐一行就把任务唤醒一次。
//
// 这几段 description 是**注入给 agent 的判据**，不是字段文档。三件事全靠措辞立住：
// ① 什么时候该用它（而不是 sleep + 反复 cat 日志）；② 命令本身就是过滤器，别让它吐
// 流水账；③ 起了哨兵的那一轮必须用 pause_task 收尾 —— complete_task 会被服务端
// 拒掉（task-complete-monitors.ts），这里要把那条 409 的出路提前说清，省得它撞上才知道。
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  MONITOR_DEFAULT_TIMEOUT_MS,
  MONITOR_MAX_EVENTS,
  MONITOR_MAX_PER_TASK,
  MONITOR_MAX_TIMEOUT_MS,
  MONITOR_MIN_TIMEOUT_MS,
  MONITOR_WAKE_TARGETS,
} from "@ash/shared/monitor";
import { END_CONDITION_SYNTAX } from "@ash/shared/monitor-end-condition";
import { call, fail, ok } from "../runtime.js";

const minutes = (ms: number) => `${Math.round(ms / 60_000)} 分钟`;

export function registerMonitorTools(server: McpServer): void {
server.registerTool(
  "start_monitor",
  {
    title: "起一个哨兵盯住长跑命令",
    description:
      "把一条长跑命令挂在任务上，由 **ash** 起进程（不在你的进程树里），它的 stdout **每输出一行就是一条事件**：ash 会把这些行攒成一条消息送回这个任务、把你唤醒。你不必轮询。跑测试传 regression=true 时例外：传未过滤的原始测试命令，系统自动保存完整输出并只发送结束摘要。\n\n" +
      "**什么时候用它**：你要等的事情以「分钟~小时」计，而且过程中会往某处写进展——跑批、训练、长构建、爬取、转码、轮询一个外部状态。典型手法是让命令自己做过滤：`tail -F build.log | grep --line-buffered -E '^\\[DONE\\]|ERROR'`。**什么时候不用**：几秒内就能出结果的命令（直接跑完它）；需要你立刻看全文的（直接读文件）。\n\n" +
      "**命令就是过滤器，这是最重要的一条**：每一行事件都会唤醒任务跑一个真实回合，花的是真钱。所以别 `tail -F` 整份日志，要 grep 到「你真会据此做事」的那几行。管道每一级都得逐行冲刷（`grep --line-buffered`、`awk` 里 `fflush()`；`head` 做不到，别用）。同时**别只匹配成功**：只 grep 成功标记的哨兵在崩溃、卡死、异常退出时一声不吭，而「安静」和「还在跑」长得一模一样——把失败特征（`Traceback|ERROR|FAILED|Killed`）一起写进交替分支里。\n\n" +
      "**起了哨兵的那一轮，用 pause_task 收尾** —— `complete_task` 会被当场拒掉（名下还有没了结的哨兵时一律 409，**包括已经退出但结果还排在待发送、没送到你手上的那些**）。理由是任务一落 done/failed/canceled，它名下的哨兵会被系统一并停掉、排着的事件会被作废（哨兵唯一的出口就是唤醒这个任务，任务都结束了再留着只会白烧回合），于是它在等的那个结果你再也拿不到。pause_task 的 resumePrompt 写清「被哨兵叫醒后该干什么」；确实不要那个结果了，就先对它调 stop_monitor（reason 写清为什么）、它排着的结果一并按「明确放弃」算，再确认完成。\n\n**顺序反过来也不行**：已经调过 `complete_task` 再挂哨兵，那份确认会被当场撤掉（这次创建的返回里会明说），本回合改落检查点暂停——哨兵醒来会把这条会话重新叫起来。\n\n" +
      `**上限**：一个任务同时最多 ${MONITOR_MAX_PER_TASK} 个哨兵；单个哨兵推够 ${MONITOR_MAX_EVENTS} 条事件自动停（到顶会明确告诉你）；timeoutMs 在 ${MONITOR_MIN_TIMEOUT_MS / 1000} 秒到 ${minutes(MONITOR_MAX_TIMEOUT_MS)} 之间，缺省 ${minutes(MONITOR_DEFAULT_TIMEOUT_MS)}，到点进程被杀掉并推一条收尾事件。要盯更久就在到期事件里重挂一个。\n\n` +
      "**它活得比你这一轮久**：进程由 ash 起、输出落文件，你的回合结束、会话结束、ash 重启都不会把它带走。所以不需要自己 `fork + setsid` 或 `nohup` —— 那样起的进程 ash 看不见也停不掉，留下的是没人认领的僵尸。\n\n" +
      "**唤醒有两个条件:命令结束、以及盯满时长 —— 前者优先。** 所以「活一跑完就叫我」本来就成立,前提是**这条命令自己会结束**。`tail -F`、`while true`、`watch` 这一类永远不会结束,于是那一条形同虚设,只剩干等到期(2026-10-21 实测:被盯的活早跑完了,任务还白等了 30 分钟、0 条事件)。这类命令**创建时会被当场拒掉**,按你要的那一种改:① 把要等的那件事本身放进命令里(`<跑那件事>; code=$?; <摘要几行>; echo \"EXIT=$code\"`),它跑完哨兵就结束 —— 最省事也最准;② 活已经在别处跑着、只能跟着看,就原样保留命令并传 `stopWhen`(出现就收工的字样,不是正则);③ 本来就是要「每出现一次叫我一次、盯到到期」,传 `untilExpiry: true` 明说一声。",
    inputSchema: {
      taskId: z.string().describe("要挂哨兵的任务 id（通常就是你自己，任务 prompt 前言里有）"),
      command: z.string().min(1).describe("交给 shell 跑的长跑命令。它自己负责过滤：只吐你真会据此做事的行，成功与失败特征都要覆盖"),
      regression: z.boolean().optional().describe("执行者跑测试时传 true，并传未过滤的原始测试命令。整套回归统一在验收时由项目的验收前置命令执行，执行回合要跑、也必须登记的只有一种：**本轮自己新写或改动的测试文件**（交付一个红着的测试文件等于没做完）。系统自动保存完整日志、真实退出码与执行者身份，只发送结束摘要；记录供审查者核对，不批准自动复用，前后 Git 树相等也不例外。未指定 timeoutMs 时默认跑到哨兵上限 60 分钟，显式时限仍生效，到期终止测试。不能与 stopWhen/untilExpiry 同用；挂完照常 pause_task 等结果。审查/验证旁路回合不能登记为执行者回归——那一轮一条测试都不该跑。"),
      description: z.string().optional().describe("一句话说明你在盯什么（会出现在每条事件的抬头和界面上）。省略则用命令本身"),
      cwd: z.string().optional().describe("工作目录。缺省＝这个任务自己的工作目录"),
      timeoutMs: z.number().optional().describe(`盯多久（毫秒），普通哨兵缺省 ${minutes(MONITOR_DEFAULT_TIMEOUT_MS)}，regression=true 缺省为上限 ${minutes(MONITOR_MAX_TIMEOUT_MS)}。到点杀掉进程并推一条收尾事件`),
      // 给自己挂哨兵时**不用管这个**：你在哪一轮里挂的，醒来就叫哪一轮（服务端按运行时事实判，
      // 这个字段那时一律忽略）。它只为「往**别的**任务上挂」那一路留着 —— 那个任务上同时有一次
      // 审查在进行时，服务端判不出该叫实现者还是那次审查，会带着「指定一个再挂」拒掉；没有这个
      // 字段，那句出路就是一条死路（第 9 轮审查 N1）。
      wake: z.enum(MONITOR_WAKE_TARGETS as unknown as [string, ...string[]]).optional()
        .describe("往别的任务上挂、而那个任务上有审查在进行时，说清醒来叫谁：single=叫实现者 / reviewer=叫那次审查。给自己挂时不必传（按你当下这一轮判）"),
      stopWhen: z.string().optional()
        // 语法那半句**引 shared 那一份**,不在这儿复述:两处各写一遍就会漂（第 2 轮审查 N1,
        // 上一版这里写着「其余字符一律当它本身」，而元字符其实是当场 400 拒掉）。
        .describe(
          "结束条件:哪一行出现这个字样,那一行照常推给你、这条哨兵随即收工,不必等到期。"
          + `${END_CONDITION_SYNTAX}`
          + "命令自己不会结束时(tail -F / while true)必须给它或给 untilExpiry。",
        ),
      untilExpiry: z.boolean().optional()
        .describe("「我本来就是要盯到到期」:每出现一次叫我一次那种(盯错误日志、盯外部状态变化)。只在命令自己不会结束时需要明说一声;**别拿它绕过那道闸** —— 要等一件事干完就按上面①②两条改,不然任务只能干等到期"),
    },
  },
  async ({ taskId, command, description, cwd, timeoutMs, wake, stopWhen, untilExpiry, regression }) => {
    try {
      return ok(await call("POST", `/tasks/${taskId}/monitors`, {
        command, description, cwd, timeoutMs, wake, stopWhen, untilExpiry, regression,
      }));
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "stop_monitor",
  {
    title: "停掉一个哨兵",
    description:
      "杀掉哨兵的进程并停止推送。等到的事情已经发生、或者发现过滤写得太松在刷屏时用它。停掉是终态，不能再续——要继续盯就用改好的命令重起一个。任务自己落终态或被归档时，它名下的哨兵会被系统自动停掉，那种情况不用你管。\n\n**它同时是「这个结果我不要了」的正式说法**：主动停掉之后，这条哨兵已经排在待发送里、还没送到你手上的那几条事件按「明确放弃」算，不再拦着 `complete_task`（撤的理由和它推过几条会一起记进任务时间线）。所以 reason 要写清为什么不要了。**已经跑完的那种照样对它调**——进程早就没了，这一次放弃的不是进程，是「必须先收下它的结果」这条放行条件。",
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
      "列出一个任务名下全部哨兵（含已结束的）及各自状态：running=还在盯；exited=命令自己跑完了；matched=等到了约定的那一行就收工了；expired=盯满了时长；stopped=被停掉或推满了事件上限；lost=ash 重启后那个进程已经不在了。被唤醒后想确认「是谁叫的我、它还在不在」时用它。",
    inputSchema: { taskId: z.string().describe("任务 id") },
  },
  async ({ taskId }) => {
    try { return ok(await call("GET", `/tasks/${taskId}/monitors`)); }
    catch (e) { return fail(e); }
  },
);
}
