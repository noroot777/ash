// 「一条任务在自己回合里对 ash 说的话」那一组工具：阶段上报、驳回审查意见（含把越界
// 的那几条提出来转独立任务）、辩论发言、验收、确认完成、到检查点暂停、停止、提问与答复。
//
// 这几段 description 是**注入给 agent 的规则本体**，不是文档：完成协议（exit 0 ≠ done）、
// 驳回的三条出路、辩论只许说话不许改代码，全靠这里的措辞立住。所以它们单独成文件——
// 混在建任务/队列那堆工具中间时，改别的工具顺手碰坏一句，没人看得出来。
//
// **体积也是规则的一部分**：工具清单随每个回合常驻上下文，这里多写一句，执行者每一轮
// 都付一次。所以只写「做什么」，「为什么有这条规则 / 哪次事故引出的」一律留在代码注释
// 和 `docs/incidents.md`。`server/scripts/test-prompt-budget.ts` 盯着每个工具的渲染字节数，
// 想写长就得先显式改那张预算表。
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MAX_QUESTION_ITEMS, MAX_QUESTION_OPTIONS, MAX_QUESTION_OPTION_LEN, STAGE_ORDER } from "@ash/shared";
// 越界转出的判据只有一份源,而且**只挂这一个运行时表面**:修复交接消息
// (server/src/free-review-prompts.ts 的 disputeOption)那边现在只留一句指针。两边都写
// 全文时漂过一次 —— server 那侧已经改成三种形态,这里仍要求「为什么越界(是哪一轮的哪次
// 改动引入的)」,而执行者两边都读得到,拿到的是互相打架的指引。防漂移靠「只有一处有全文」,
// 不靠「两处同文 + 回归钉死」:`test-prompt-budget.ts` 断言每条判据在全部渲染样本里只出现一次。
//
// 对应地,`CLASS_PROBLEM_BOUNDARY` 的唯一表面是修复交接里的 `CLASS_REPAIR_NOTE`(预设/旧验证
// 那条线共用它),所以这里**不再复述**类问题那一段,只留一句「它不自动等于界内」。
import {
  DEFER_BOUNDARY_CRITERION, DEFER_REASON_FIELD_GUIDE,
  PLAIN_SUMMARY_EXAMPLE, PLAIN_SUMMARY_GUIDE, REVIEW_VALIDATION_REQUIREMENT,
} from "@ash/shared/free-workflow";
import { call, fail, ok } from "../runtime.js";
import { TASK_STAGE } from "../schemas.js";

export function registerTaskTurnTools(server: McpServer): void {
server.registerTool(
  "report_stage",
  {
    title: "上报验证结论",
    description:
      "在验证回合里上报验证结论（与 TaskStatus 正交，不改队列也不改任务结算）。验证轮开始时后端自动置 verifying，得出结论后报 verified 或 verify_failed。" +
      REVIEW_VALIDATION_REQUIREMENT +
      "截图按需：改动看得见就必须截，看不见的（服务端逻辑、CLI、脚本）不用截，技术明细里贴命令与输出即可。taskId 填**被验任务**的 id——旁路验证时那就是你当前这个任务，历史独立审查任务则填被审任务 id。implemented/awaiting_acceptance/merged/accepted 只留给兼容与验收链路；团队调度台(mode=team)不适用，普通执行回合不自我上报。",
    inputSchema: {
      taskId: z.string().describe("被验任务 id（就地验证时即当前任务；历史独立审查任务填被审任务 id）"),
      stage: TASK_STAGE.describe(`阶段：${STAGE_ORDER.join(" | ")}`),
      verificationBasis: z.object({
        kind: z.literal("independent"),
        generation: z.string().min(1),
        monitorIds: z.array(z.string().min(1)).min(1),
      }).optional().describe("正常情况不要传。两种例外——① 上报被拒、说这是「口径切换前开的旧审查轮次」:按它说的交 monitorIds,**要的是一次本轮真实执行**(构建、冒烟、浏览器点检都算),不要为此去跑回归;② 重放旧回合那条没投递成功的 report_stage 时原样带回当时的值"),
      directionToken: z.string().min(1).describe("最新用户方向附带的 directionToken；必须原样传入，不能省略或沿用更早消息里的值"),
    },
  },
  async ({ taskId, stage, directionToken, verificationBasis }) => {
    try { return ok(await call("POST", `/tasks/${taskId}/stage`, { stage, verificationBasis }, directionToken)); }
    catch (e) { return fail(e); }
  },
);

server.registerTool(
  "dispute_review",
  {
    title: "驳回审查意见(不认这条结论/越界建议转独立任务)",
    description:
      "自由工作流的审查意见被打回来修复时,**你不必 100% 认可那份报告**。调用本工具把驳回落下来,然后结束回合——链停在「等用户裁定」,不自动复审,也不算完成。\n\n"
      + "两段理由判据不同,别混在一起:\n"
      + "- **reason(它不对)**:这条读错了代码、依据不可复现,或那处是知情且有意为之、这次不该动。逐条写清哪一条、依据是什么(指到文件/行/可复现步骤)。\n"
      + "- **deferReason(它不属于本任务)**:这条技术上成立、依据也可复现,但与本任务要做的那件事无关。"
      + DEFER_BOUNDARY_CRITERION
      + "\n照改会让这条链没有终点(改→引入→再被打回,或者一路改进别人的模块),谎称「依据不可复现」一拆就穿。报告写着「这是类问题」也**不自动等于界内**——边界由本任务目标定,判据见本回合交接里那一段。\n\n"
      + "两段可以同时给,只提转出时 reason 可以不填。部分成立时先把成立的那几条改掉并验证,再只驳剩下的,在 reason 里写明已经改了什么;默认仍然是照报告修复,拿不出具体依据就不要驳回。**你只负责提出,转不转、改不改由用户裁定**,本工具不建任何任务。\n\n"
      + "只能在**执行回合**里调用(审查回合不能驳回自己的结论),一轮意见只能驳一次;驳回之后不要调用 complete_task。用户看到驳回后可以让你和审查者辩论一轮(那时你会收到辩论提示并用 debate_reply 发言),也可以直接采纳你的说法、维持原意见让你照改,或者把越界的那几条转成独立任务。",
    inputSchema: {
      taskId: z.string().describe("当前正在执行的任务 id(任务 prompt 前言里有)"),
      // 「那一句人话」的**示范只挂这一处**:它是执行者真要动手填这个格子时离得最近的
      // 一句,而示范比规范本体还长、只在「第一次写」那一刻有用(见 PLAIN_SUMMARY_EXAMPLE)。
      summary: z.string().min(1).describe(
        `写给**用户**的一句话:他靠它决定点「让你接着改」/「这一轮不用改了」/「转成独立任务」。${PLAIN_SUMMARY_GUIDE}${PLAIN_SUMMARY_EXAMPLE}`,
      ),
      reason: z.string().default("").describe("逐条写清哪一条意见不成立、依据是什么;部分成立时写明你已经改了哪几条。只提 deferReason 时可以留空"),
      deferReason: z.string().optional().describe(`哪几条你认可、但与本任务要做的那件事无关,建议转独立任务。${DEFER_REASON_FIELD_GUIDE}`),
      directionToken: z.string().min(1).describe("最新用户方向附带的 directionToken；必须原样传入，不能省略或沿用更早消息里的值"),
    },
  },
  async ({ taskId, summary, reason, deferReason, directionToken }) => {
    try {
      return ok(await call(
        "POST",
        `/tasks/${taskId}/free-workflow/review/dispute`,
        { summary, reason, deferReason },
        directionToken,
      ));
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "debate_reply",
  {
    title: "辩论发言(审查意见之争)",
    description:
      "执行者驳回审查意见后,用户可以让双方各说几段。你收到【审查意见辩论】提示时,说完自己这一段就调用本工具交卷,然后结束回合——**发言只认这次调用**,写在输出文本里的内容不算数,没交卷这场辩论会按「没说话」中止。\n\n"
      + "**summary 必填**(写法见该字段说明):用户会逐段只读这一句来判断辩到哪了。\n\n"
      + "这一段只辩论:不要改动任何文件、不要提交、不要跑会改变状态的命令。收尾那一段(提示里会写明)必须同时给 verdict:upheld=维持原意见 / withdrawn=撤回原意见 / partial=部分成立;那只是你自己的立场,**最终由用户裁定**,不改变任何结论。非收尾段传 verdict 会被忽略。本回合不要调用 report_stage / complete_task / accept_task。",
    inputSchema: {
      taskId: z.string().describe("正在辩论的任务 id(提示里有)"),
      summary: z.string().min(1).describe(`这一段发言的一句话,写给**用户**看。${PLAIN_SUMMARY_GUIDE}`),
      statement: z.string().min(1).describe("你这一段的完整发言:逐条说清坚持什么、接受什么、依据是什么"),
      verdict: z
        .enum(["upheld", "withdrawn", "partial"])
        .optional()
        .describe("仅收尾那一段需要:upheld=维持原意见 / withdrawn=撤回原意见 / partial=部分成立"),
      directionToken: z.string().min(1).describe("最新用户方向附带的 directionToken；必须原样传入，不能省略或沿用更早消息里的值"),
    },
  },
  async ({ taskId, summary, statement, verdict, directionToken }) => {
    try {
      return ok(await call(
        "POST", `/tasks/${taskId}/free-workflow/review/debate/reply`,
        { summary, statement, verdict }, directionToken,
      ));
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "accept_task",
  {
    title: "确认验收通过并合并清理",
    description:
      "仅在用户明确表示「验收通过」「可以合并」时调用。服务端确定性执行：查父成果依赖 → 把任务分支合并到 mergeTargetBranch → 删 worktree → `git branch -d` 删任务分支 → stage 标为 accepted（status 不变）。冲突、目标工作区脏或清理失败会返回结构化原因，绝不强制合并。**不要自行跑 git merge / worktree remove / branch -d**，统一调本工具。\n\n项目设了「验收前置命令」时，这一按会先在任务工作区跑一遍那条命令（可能十几分钟）：返回 accept_gate_running = 已开跑，rc=0 就会自动做完，**不用再调一次**；返回 accept_gate_failed = 它红了，没合并也没清理，日志已交回那个任务去修。\n\nparentId 指向团队且 useWorktree=false 的共享执行者不适用本工具（单独调会 409）：验收团队整体，团队级成功会联动把全部共享执行者标为 accepted。",
    inputSchema: {
      taskId: z.string().describe("用户明确验收通过的任务 id"),
      confirmUnverified: z.boolean().optional().describe("返回 verify_not_run 时，只有用户知晓「独立验证尚未执行」且明确确认继续验收后才传 true；中途 human 关口会继续推进后续 verify，无需此参数"),
      gate: z.enum(["skip", "rerun"]).optional().describe("对「验收前置命令」的额外指令。不传 = 照常（跑过就沿用结果）；rerun = 这一按重跑；skip = 这次不跑直接合并。**只有用户明确要求才传**：跳过等于绕开他自己设的那道闸"),
      commit: z.boolean().optional().describe("这次合并落不落提交。不传 = 按项目设置（默认落）；false = 只把改动合进目标分支工作区并暂存、提交历史不动（要求目标分支正检出在项目目录且工作区干净，任务分支一律保留）。只有用户明确说「先别提交」才传"),
    },
  },
  async ({ taskId, confirmUnverified, commit, gate }) => {
    try { return ok(await call("POST", `/tasks/${taskId}/accept`, { confirmUnverified, commit, gate })); }
    catch (e) { return fail(e); }
  },
);

server.registerTool(
  "complete_task",
  {
    title: "确认任务完成(严格 done 协议)",
    description:
      "在执行中调用,告诉 ash:「本任务的目标我确定已经达成了」。回合结算时读到这个确认才会落 done;**没有确认的正常退出(exit 0)一律按未完成记 failed**——退出码不代表目标达成,报错后退出也是 exit 0。\n\n"
      + "用法:核实目标已达成(产物在、校验过)后,在结束回合前调一次,然后正常结束输出。**只能在任务正在跑时调用**。没完成就不要调:要等外部条件用 pause_task;做不下去就说明原因退出(记 failed,用户可重试续跑)。\n\n"
      + "**名下还有没了结的哨兵时这个确认会被拒(409)**,两类都算:还在盯的,以及已经出了结果、还排在待发送里没送到你手上的(落 done 会把它们一并停掉/作废)。拒绝那句话里会列出是哪几个。出路:还要那个结果 → 改用 pause_task 收尾,等它叫醒你再确认;不要了 → 对那条哨兵调 stop_monitor(reason 写清为什么),它排着的结果一并按「明确放弃」算(**已经跑完的也一样要调**,放弃的是「必须先收下结果」这条条件,不是进程)。\n\n"
      + "**确认之后不要再挂哨兵**:那一刻这份确认会被当场撤掉(创建的返回里会明说),本回合改落检查点暂停。",
    inputSchema: {
      taskId: z.string().describe("当前正在执行的任务 id(任务 prompt 前言里有)"),
      directionToken: z.string().min(1).describe("最新用户方向附带的 directionToken；必须原样传入，不能省略或沿用更早消息里的值"),
    },
  },
  async ({ taskId, directionToken }) => {
    try { return ok(await call("POST", `/tasks/${taskId}/complete`, {}, directionToken)); }
    catch (e) { return fail(e); }
  },
);

server.registerTool(
  "pause_task",
  {
    title: "在检查点暂停(等续跑)",
    description:
      "在执行中调用,告诉 ash:「我跑到一个检查点了,下次该继续时给我喂这段 prompt」。你这一回合自然结束后状态落 paused(不是 done);队列推进时会用 resumePrompt 把你叫醒、resume 同一个 CLI 会话(哨兵有结果时同理)。\n\n"
      + "用法:先把检查点前的活正常做完,要暂停时调一次,然后正常退出当前回合。**只能在任务正在跑时调用**,resumePrompt 不能为空(否则 resume 时没东西喂你)。\n\n"
      + "被具体问题卡住、要等人拍板时用 ask_question 而不是本工具:pause 是「到检查点等续跑」,ask 是「等答案」且会自动通知团队调度者。",
    inputSchema: {
      taskId: z.string().describe("当前正在执行的任务 id"),
      resumePrompt: z.string().min(1).describe("下次被 resume 时喂给你的 user 消息 —— 就当成一条「继续：…」replied 写"),
      directionToken: z.string().min(1).describe("最新用户方向附带的 directionToken；必须原样传入，不能省略或沿用更早消息里的值"),
    },
  },
  async ({ taskId, resumePrompt, directionToken }) => {
    try { return ok(await call("POST", `/tasks/${taskId}/pause`, { resumePrompt }, directionToken)); }
    catch (e) { return fail(e); }
  },
);

server.registerTool(
  "stop_task",
  {
    title: "停止/取消任务(杀进程树)",
    description:
      "停止任务的执行活动：杀掉存活进程树，由 run loop 结算 canceled；尚未启动的 queued 或 paused/backlog 上的有效持久推进请求，原子撤销并落 canceled。可重试续跑。**取消运行中的任务必须用这个，严禁 patch_task(status=canceled)**，后者只改库不停进程，会提前推进队列并破坏结算。",
    inputSchema: { taskId: z.string() },
  },
  async ({ taskId }) => {
    try { return ok(await call("POST", `/tasks/${taskId}/stop`, {})); }
    catch (e) { return fail(e); }
  },
);

server.registerTool(
  "ask_question",
  {
    title: "提问并暂停(等调度者/用户答复)",
    description:
      `在执行中调用,告诉 ash:「我被不拍板就没法继续的决策卡住了」。调完正常结束回合,任务落 paused 且**队列不会自动续跑**;问题即时送达团队调度者(你是执行者时),没有调度者就停在那等用户。你自己是团队调度者时调它 = 问用户。答复通过 answer_question 送达,会作为一段文本唤醒你同一个 CLI 会话续跑。\n\n`
      + `用法:只能在任务正在跑时调用,先把当下能做的都做完再提问。一个决策用 question + options;有几个**相关且都需要同一个人拍板**的决策时,用 question 写共同背景、questionItems 一次问完(最多 ${MAX_QUESTION_ITEMS} 个),别挤牙膏,也别把无关问题硬凑在一起。\n\n`
      + "options 都是**建议答案,不是单选题**:每条只写一句能直接当答复读的话,理由和取舍留在对应 question 里。答复者可以改、可以组合、也可以完全自由作答。跟 pause_task 的区别:pause 是「到检查点等续跑指令」,ask 是「等具体问题的答案」。",
    inputSchema: {
      taskId: z.string().describe("当前正在执行的任务 id(任务 prompt 前言里有)"),
      question: z.string().min(1).describe("单问题时就是问题本体；传 questionItems 时写共同引言/背景"),
      options: z
        .array(z.string().min(1).max(MAX_QUESTION_OPTION_LEN))
        .max(MAX_QUESTION_OPTIONS)
        .optional()
        .describe(
          `单问题的建议答案(可选,最多 ${MAX_QUESTION_OPTIONS} 个、每个不超过 ${MAX_QUESTION_OPTION_LEN} 字)。多问题时不要传这里,改放各 questionItems[i].options。`,
        ),
      questionItems: z
        .array(
          z.object({
            question: z.string().min(1).describe("这个独立问题的背景、取舍和需要拍板的点"),
            options: z
              .array(z.string().min(1).max(MAX_QUESTION_OPTION_LEN))
              .max(MAX_QUESTION_OPTIONS)
              .optional()
              .describe(
                `这个问题的建议答案(可选,最多 ${MAX_QUESTION_OPTIONS} 个、每个不超过 ${MAX_QUESTION_OPTION_LEN} 字):每条都应能直接当答复读,不是单选题。`,
              ),
          }),
        )
        .max(MAX_QUESTION_ITEMS)
        .optional()
        .describe(`一次并列询问的相关问题(可选,最多 ${MAX_QUESTION_ITEMS} 个)；每题会独立显示候选和输入框。`),
      directionToken: z.string().min(1).optional().describe("单飞任务必须原样传入最新用户方向附带的 directionToken；只有团队调度台可省略"),
    },
  },
  async ({ taskId, question, options, questionItems, directionToken }) => {
    try { return ok(await call("POST", `/tasks/${taskId}/ask`, { question, options, questionItems }, directionToken)); }
    catch (e) { return fail(e); }
  },
);

server.registerTool(
  "answer_question",
  {
    title: "答复提问中的任务并唤醒它",
    description:
      "给一个「提问暂停」中的任务(get_task 里 question 非空、status=paused)送答复:清空问题,并把答复作为消息 resume 它的 CLI 会话继续跑。团队调度者收到【执行者提问】通知后用这个答,用户/其他 agent 也可以直接调。提问任务还在 running/queued(回合没结算完)时会被拒,等它落 paused 再调 —— 例外是团队调度台(mode=team),常驻会话忙着也接得住。",
    inputSchema: {
      taskId: z.string().describe("提问任务的 id(通知里有)"),
      answer: z.string().min(1).describe("答复内容:直接给结论和理由,它会原样喂给对方续跑"),
    },
  },
  async ({ taskId, answer }) => {
    try { return ok(await call("POST", `/tasks/${taskId}/answer`, { answer })); }
    catch (e) { return fail(e); }
  },
);

}
