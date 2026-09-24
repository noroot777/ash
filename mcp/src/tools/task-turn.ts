// 「一条任务在自己回合里对 ash 说的话」那一组工具：阶段上报、驳回审查意见（含把越界
// 的那几条提出来转独立任务）、辩论发言、验收、确认完成、到检查点暂停、停止、提问与答复。
//
// 这几段 description 是**注入给 agent 的规则本体**，不是文档：完成协议（exit 0 ≠ done）、
// 驳回的三条出路、辩论只许说话不许改代码，全靠这里的措辞立住。所以它们单独成文件——
// 混在建任务/队列那堆工具中间时，改别的工具顺手碰坏一句，没人看得出来。
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MAX_QUESTION_ITEMS, MAX_QUESTION_OPTIONS, MAX_QUESTION_OPTION_LEN, STAGE_ORDER } from "@ash/shared";
import { call, fail, ok } from "../runtime.js";
import { TASK_STAGE } from "../schemas.js";

export function registerTaskTurnTools(server: McpServer): void {
server.registerTool(
  "report_stage",
  {
    title: "上报验证结论",
    description:
      "在验证回合里上报与 TaskStatus 正交的验证结论，不会改变队列或任务结算。验证轮开始时后端自动置 verifying；真实运行验证后报 verified 或 verify_failed。web 改动必须启动服务、用浏览器确认行为，只读代码或只过编译不算验证；截图按需——改动看得见时必须截，看不见的改动（服务端逻辑、CLI、脚本）不需要截图，报告里贴命令与输出即可。验证现在就跑在被验任务自己身上（旁路回合），所以 taskId 填被验任务的 id——那多半就是你当前这个任务；历史的独立审查任务仍填被审任务 id，不是审查任务自己的 id。implemented/awaiting_acceptance/merged/accepted 保留给兼容与验收链路；团队调度台(mode=team)仍不适用。普通执行回合不自我上报验证阶段。",
    inputSchema: {
      taskId: z.string().describe("被验任务 id（就地验证时即当前任务；历史独立审查任务填被审任务 id）"),
      stage: TASK_STAGE.describe(`阶段：${STAGE_ORDER.join(" | ")}`),
      directionToken: z.string().min(1).describe("最新用户方向附带的 directionToken；必须原样传入，不能省略或沿用更早消息里的值"),
    },
  },
  async ({ taskId, stage, directionToken }) => {
    try { return ok(await call("POST", `/tasks/${taskId}/stage`, { stage }, directionToken)); }
    catch (e) { return fail(e); }
  },
);

server.registerTool(
  "dispute_review",
  {
    title: "驳回审查意见(不认这条结论/越界建议转独立任务)",
    description:
      "自由工作流的审查意见被打回来修复时,**你不必 100% 认可那份报告**。发现某条意见读错了代码、依据不可复现,或者那处是知情且有意为之、这次不该动,就调用本工具把驳回落下来,然后结束回合——链会停在「等用户裁定」,不会自动复审,也不会当成任务完成。\n\n用法:reason 里逐条写清**哪一条不成立、依据是什么**(指到具体文件/行/可复现步骤);部分成立时先把成立的那几条改掉并验证,再用本工具只驳不成立的那几条,并在 reason 里写明已经改了什么。默认仍然是照报告修复——拿不出具体依据就不要驳回。\n\n**第三种情况用 deferReason,别塞进 reason**:某条意见技术上成立、依据也可复现,但它**不属于本任务的边界**——最典型的是**本轮修复自己引入的衍生问题**。照改会让这条链没有终点(改→引入→再被打回),谎称「依据不可复现」一拆就穿。这种就填 deferReason,逐条写明哪几条、为什么越界(是哪一轮的哪次改动引入的)、建议的独立任务范围;用户同意后系统会建一个待办派生任务把它们带走。reason 与 deferReason 可以同时给,只提转出时 reason 可以不填。两者判据不同:reason 问「它对不对」,deferReason 问「它属不属于本任务」——后者的判据是**边界**不是**工作量**,说不出「为什么它不属于本任务」就照改。**你只负责提出,转不转由用户裁定**,本工具不会建任何任务。\n\n只能在**执行回合**里调用(审查回合不能驳回自己的结论),一轮意见只能驳一次;驳回之后不要调用 complete_task。用户看到驳回后可以让你和审查者辩论一轮(那时你会收到辩论提示并用 debate_reply 发言),也可以直接采纳你的说法、维持原意见让你照改,或者把越界的那几条转成独立任务。",
    inputSchema: {
      taskId: z.string().describe("当前正在执行的任务 id(任务 prompt 前言里有)"),
      reason: z.string().default("").describe("逐条写清哪一条意见不成立、依据是什么;部分成立时写明你已经改了哪几条。只提 deferReason 时可以留空"),
      deferReason: z.string().optional().describe("哪几条你认可、但超出本任务边界(多半是本轮修复引入的衍生问题),建议转独立任务:逐条写明是哪几条、为什么越界、建议的独立任务范围"),
      directionToken: z.string().min(1).describe("最新用户方向附带的 directionToken；必须原样传入，不能省略或沿用更早消息里的值"),
    },
  },
  async ({ taskId, reason, deferReason, directionToken }) => {
    try {
      return ok(await call(
        "POST",
        `/tasks/${taskId}/free-workflow/review/dispute`,
        { reason, deferReason },
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
      "执行者驳回审查意见后,用户可以让双方各说几段。你收到【审查意见辩论】提示时,说完自己这一段就调用本工具交卷,然后结束回合——**发言只认这次调用**,写在输出文本里的内容不算数,没交卷这场辩论会按「没说话」中止。\n\n这一段只辩论:不要改动任何文件、不要提交、不要跑会改变状态的命令。收尾那一段(提示里会写明)必须同时给 verdict:upheld=维持原意见 / withdrawn=撤回原意见 / partial=部分成立;那只是你自己的立场,**最终由用户裁定**,不改变任何结论。非收尾段传 verdict 会被忽略。本回合不要调用 report_stage / complete_task / accept_task。",
    inputSchema: {
      taskId: z.string().describe("正在辩论的任务 id(提示里有)"),
      statement: z.string().min(1).describe("你这一段的完整发言:逐条说清坚持什么、接受什么、依据是什么"),
      verdict: z
        .enum(["upheld", "withdrawn", "partial"])
        .optional()
        .describe("仅收尾那一段需要:upheld=维持原意见 / withdrawn=撤回原意见 / partial=部分成立"),
      directionToken: z.string().min(1).describe("最新用户方向附带的 directionToken；必须原样传入，不能省略或沿用更早消息里的值"),
    },
  },
  async ({ taskId, statement, verdict, directionToken }) => {
    try {
      return ok(await call(
        "POST", `/tasks/${taskId}/free-workflow/review/debate/reply`, { statement, verdict }, directionToken,
      ));
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "accept_task",
  {
    title: "确认验收通过并合并清理",
    description:
      "仅在用户明确表示「验收通过」「可以合并」等最终验收意图时调用。服务端会确定性执行：检查父成果依赖后把任务分支合并到 mergeTargetBranch（旧任务沿用原目标），确认已合并后删除任务 worktree，并用 git branch -d 安全删除任务分支，最后把 stage 标为 accepted；status 不会改变。冲突、目标工作区脏或清理失败时会返回结构化原因，绝不强制合并。不要自行运行 git merge / worktree remove / branch -d，统一调用本工具。parentId 指向团队且 useWorktree=false 的共享执行者不适用本工具，单独调用会被 409 拒绝；请验收团队整体，团队级成功会联动把全部共享执行者标为 accepted。",
    inputSchema: {
      taskId: z.string().describe("用户明确验收通过的任务 id"),
      confirmUnverified: z.boolean().optional().describe("返回 verify_not_run 时，只有用户知晓「独立验证尚未执行」且明确确认继续验收后才传 true；中途 human 关口会继续推进后续 verify，无需此参数"),
      commit: z.boolean().optional().describe("这一次合并完落不落提交。不传 = 按项目设置（默认落提交）；false = 只把改动合进目标分支的工作区并暂存、目标分支的提交历史一动不动，此时要求目标分支正检出在项目目录且工作区干净，任务分支一律保留。只有用户明确说了「先别提交」之类才传"),
    },
  },
  async ({ taskId, confirmUnverified, commit }) => {
    try { return ok(await call("POST", `/tasks/${taskId}/accept`, { confirmUnverified, commit })); }
    catch (e) { return fail(e); }
  },
);

server.registerTool(
  "complete_task",
  {
    title: "确认任务完成(严格 done 协议)",
    description:
      "在执行中调用,告诉 ash:「本任务的目标我确定已经达成了」。回合结束结算时读到这个确认才会把任务落成 done;**没有确认的正常退出(exit 0)会按未完成记为 failed**——因为正常退出不代表目标达成(报错后退出也是 exit 0),假 done 会误推进队列、错误唤醒下游任务。\n\n用法:当且仅当你核实任务目标已达成(产物在、校验过),在结束回合前调一次本工具,然后正常结束输出。**只能在任务正在跑时调用**。没完成就不要调:需要等外部条件用 pause_task;做不下去直接说明原因退出(会记 failed,用户可重试续跑)。",
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
      "在执行中调用,告诉 ash:「我跑到一个检查点了,下次该继续时给我喂这段 prompt」。ash 会把 resumePrompt 写到 task 上;你这一回合自然结束后,状态落到 paused(而不是 done),队列推进规则会在前一个任务 done 时用 resumePrompt 把你叫醒、resume 同一个 CLI 会话。\n\n用法:先正常做完检查点前的所有工作;要暂停时调一次本工具,然后正常退出当前回合(return / 结束输出即可)。**只能在任务正在跑时调用**,且 resumePrompt 不能为空(否则 resume 时没东西喂你)。\n\n典型场景:dr-dig-ytb 一类「pre-tts 并行 + tts 串行」流水线 —— 把任务跑到 pre-tts 末尾时调本工具,resumePrompt 写下「现在做 tts 这一段」;后续每个任务都在自己 queue 位置上等前一个 done 后自动续跑。\n\n注意:被具体问题卡住、要等人拍板才能继续时,用 ask_question 而不是本工具——pause 是「到检查点等续跑」,ask 是「等答案」且会自动通知团队调度者。",
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
      "停止一个 running/queued 的任务:终止它的整棵 agent 进程树(claude/codex 及其子进程一起),由 run loop 结算为 canceled(可重试,重试会从中断处续跑);queued 还没拉起进程的直接落 canceled。**取消运行中的任务必须用这个,严禁 patch_task(status=canceled)**——那样只改数据库不停进程,会导致:队列被提前推进(串行变并行)、活着的 agent 调 complete_task 吃 409、结算再把 canceled 覆盖成 failed。",
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
      `在执行中调用,告诉 ash:「我被不拍板就没法继续的决策卡住了」。调完后正常结束回合,任务落 paused 且**队列不会自动续跑**;问题会即时送达团队调度者(你是执行者时),没有调度者就停在那等用户答复。你自己是团队调度者时调它 = 问用户,界面上显示成「调度者在等你答复」。答复通过 answer_question 送达,会作为一段文本唤醒你的同一个 CLI 会话续跑。\n\n用法:只能在任务正在跑时调用;先把当下能做的都做完再提问。一个决策用 question + options;有几个**相关且都需要同一个人拍板**的决策时,用 question 写共同背景,再用 questionItems 一次问完(最多 ${MAX_QUESTION_ITEMS} 个),避免挤牙膏式来回。不要把无关问题硬凑在一起。\n\noptions / questionItems[i].options 都是**建议答案,不是单选题**:每条只写一句能直接当答复读的话,理由和取舍留在对应 question 里。网页点击候选只会填入该问题的输入框,已有内容会换行追加;答复者仍可修改、组合多条或完全自由作答。最终所有问题的答案会编号合并成一段文本,仍走原来的 answer_question 协议。跟 pause_task 的区别:pause 是「到检查点等续跑指令」,ask 是「等具体问题的答案」。`,
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
      "给一个「提问暂停」中的任务(get_task 里 question 非空、status=paused)送答复:清空问题、把答复作为消息 resume 它的 CLI 会话继续跑。团队调度者收到【执行者提问】通知后用这个答;用户/其他 agent 也可以直接调。提问任务还在 running/queued(回合没结算完)时会被拒,稍等它落 paused 再调 —— 例外是团队调度台(mode=team),它是常驻会话,忙着也接得住。",
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
