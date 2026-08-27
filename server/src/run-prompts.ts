import { STEP_LABELS } from "@ash/shared/workflow";
import { STRICT_DONE_PROTOCOL } from "./single-run.js";
import { FOLLOW_UP_LABEL } from "./labels.js";
import { railStalledAtRun } from "./workflows.js";

// 单任务每一轮 prompt 上下拼的那些**固定措辞**:前言、完成协议、续聊尾巴、工作目录
// 重建的告警。跟 team/prompts.ts 同一个位置 —— orchestrator.ts 只留「什么时候拼哪一段」
// 的逻辑,措辞本身住在这里(它超过 700 行之后就没别的地方可放了)。

// Single tasks run headless — nobody can answer a mid-run prompt. Tell the agent
// to act autonomously rather than stall waiting for confirmation; if it genuinely
// needs input it can still ask, and the user replies via continueTask (resume).
export const AUTONOMY =
  "你在一个无人值守的自动化环境中运行，没有人能实时回复你。请尽量自主完成：遇到多个合理方案时，选最稳妥的一个并在结果中说明假设与取舍；不要停下来等待人工确认，除非信息确实不足以继续。\n\n";
// Prefix for an agent invited into an existing task via @-mention. It joins in
// the SAME working directory, so it should read the current state before acting.
export const COLLAB_INVITE =
  "你被叫来加入这个任务的协作。当前工作目录里可能已经有其他 agent 的产出，请先了解现状再动手。\n\n";
// 被召唤进来的智能体只收到用户 @ 它的那一句话 —— 任务本身是干什么的，它一无所知
// （task.body 只进 fresh run 的 prompt，而它走的是 continueTask 这条路）。撞上
// 「审一下上面的提交」这种自带上下文的召唤还能靠工作目录补齐，换成依赖任务描述的
// 活就只能靠猜。所以首次入场时把原始描述一并给它，之后的回合不再重复（它自己的
// 会话里已经有了）。
// When a task that was interrupted (server restart → failed, manual stop →
// canceled, group pause → paused, or a non-zero exit) is (re)started, we RESUME
// its existing CLI session with this nudge instead of re-running from scratch —
// the agent already holds the full prior context via --resume, so no AUTONOMY
// preamble.
export const RESUME_PROMPT =
  "继续：你上一次的运行被中断了（可能是服务重启、被手动停止或所在分组被暂停）。请从中断处接着完成这个任务，先简要说明你已做到哪一步、还差什么，然后继续推进直到完成。";
// Backend-initiated continue leaves this trace in the timeline (distinct from a
// user reply), shown identically live (SSE) and on reload (.md).
export const SYS_MARKER = "〔系统〕继续（从中断处）";

// 完成协议前言(严格 done):告诉 agent 它的 taskId 和「必须亲口确认完成」的
// 规则。fresh run 用长版(第一回合,完整交代);reply/resume 回合用短版追加在
// 消息尾部(每回合都提醒,上下文再长 agent 也不至于忘)。
// 宽松模式(ASH_LAX_DONE,典型:预览实例)下这三段一律退化成空串 —— 那台 ash
// 的 MCP 对 agent 不可达,交代了它也做不到,理由见 single-run.ts 的 STRICT_DONE_PROTOCOL。
export const ACCEPTANCE_REMINDER = (taskId: string, sharedTeamWorker: boolean, verifying: boolean, free = false) => verifying
  ? "验收辅路:验证回合不适用 accept_task；这一轮只负责给出验证结论并留证。"
  : free
    ? "自由工作流:完成实现后只调用 complete_task；不要调用 report_stage 或 accept_task。派审和预览由用户按需触发，任务完成后由用户从统一验收页验收。"
  : sharedTeamWorker
    ? "验收辅路:本共享执行者不适用 accept_task；合并与验收由团队级处理。"
    : `验收辅路:准备交给人工验收前可调用 report_stage(taskId="${taskId}", stage="awaiting_acceptance", directionToken="<最新【当前方向身份】token>")；` +
      `只有用户明确表示「验收通过/可以合并」时，调用 accept_task(taskId="${taskId}")，不要自行运行 git merge、worktree remove 或 branch -d。`;
export const COMPLETION_PROTOCOL = (taskId: string, sharedTeamWorker: boolean, reviewTask: boolean, free = false) =>
  !STRICT_DONE_PROTOCOL ? "" :
  `【完成协议】本任务在 ash 的 taskId 是 ${taskId}。当且仅当你确定任务目标已经达成时,在结束前调用 ash MCP 的 complete_task(taskId="${taskId}", directionToken="<最新【当前方向身份】token>")确认完成;未确认就结束,本回合会按未完成记为 failed。跑到需要等待外部条件的检查点时,改用 pause_task 并同样传最新 directionToken 写下续跑指令。\n\n${ACCEPTANCE_REMINDER(taskId, sharedTeamWorker, reviewTask, free)}\n\n`;
export const COMPLETION_REMINDER = (taskId: string, sharedTeamWorker: boolean, reviewTask: boolean, free = false) =>
  !STRICT_DONE_PROTOCOL ? "" :
  `\n\n(ash 完成协议:taskId=${taskId}。若本回合结束时任务目标已达成,先调用 complete_task 并传最新【当前方向身份】directionToken 确认再结束,否则按未完成记 failed;到等待检查点则用 pause_task 并传同一 token。${ACCEPTANCE_REMINDER(taskId, sharedTeamWorker, reviewTask, free)})`;

export const DIRECTION_PROTOCOL = (token: string) =>
  !STRICT_DONE_PROTOCOL ? "" :
    `\n\n【当前方向身份】本方向调用 report_stage、complete_task、pause_task 或 ask_question 时，必须在工具参数 directionToken 中原样传入 "${token}"，不得省略。上下文里若有更早的方向身份一律作废；收到“方向身份已过期”时，用本段 token 立即重试。`;

// 续聊(follow-up)回合的尾巴:任务早就到终态了,这一轮是「完成之后的对话」,
// 不该拿严格完成协议吓唬 agent(不确认就 failed)—— 这一轮不确认,任务状态原样不动。
//
// 但反过来说「本回合不需要 complete_task」也是个坑:任务身上可能挂着**只认
// complete_task 才往下走**的东西(自由工作流的预约审查、标准工作流执行链的下一站),
// 而它们要么 agent 根本看不见,要么是在这一轮跑到一半才被用户挂上的 —— prompt 发出去
// 的那一刻还不存在,再怎么在这里描述任务现状都盖不住(实测:nRVt1IkkB7TA、gsppwUacwZnn
// 的预约审查都是开跑 4 分钟后才挂上的,两个任务的预约至今停在「已预约」)。
//
// 所以判据不能是「你自己判断任务要不要往下走」,只能落在 agent 百分之百知道、且跟挂没挂
// 东西无关的那件事上:**这一轮动没动代码**。动了就确认 —— 反正续聊回合确认的代价是
// done→done,不会把任何状态变差。
export const FOLLOW_UP_REMINDER = (
  taskId: string, from: string, sharedTeamWorker: boolean, reviewTask: boolean, rail: string, free = false,
) =>
  !STRICT_DONE_PROTOCOL ? "" :
  `\n\n(ash:这是任务在「${FOLLOW_UP_LABEL[from] ?? from}」之后的续聊,taskId=${taskId}。` +
  `不确认不会把这一轮判失败 —— 没调 complete_task,任务状态就原样留在「${FOLLOW_UP_LABEL[from] ?? from}」。` +
  `但**只要你这一轮动了代码(改了文件、提交),结束前就必须调用 complete_task(taskId="${taskId}")确认**:` +
  `任务身上可能挂着等这声确认才往下跑的东西(完成后的预约审查、执行链的下一站),你未必看得见它们,` +
  `不确认它们就一直停在原地。纯回答问题、没动代码则不用确认。` +
  `${rail}${ACCEPTANCE_REMINDER(taskId, sharedTeamWorker, reviewTask, free)})`;

// 上面那句「动了代码就确认」是通用规则,这里再把**具体这条线停在哪**说清楚 —— 只在
// 续聊回合、且任务身上真挂着一条还有后续站的线时追加。
//
// 补它是因为通用规则之前那一版(「本回合不需要 complete_task」)在有线的任务上会把 agent
// 引进一个洼地:用户续聊说「改成 XXX」,agent 改完、按验收辅路那句调了
// report_stage(awaiting_acceptance)就收工 —— 它以为已经交给人工验收了,可**线的推进只认
// complete_task**(`handleTaskSettlement` 的 `confirmedDone && status === "done"`),于是新一版
// 代码躺在那儿,预览没开、人工关口没到,游标停在「让 AI 干活」原地不动,用户看到的是
// 「怎么第一步就停了」(实测任务 1rojF5Tjau91)。通用规则堵住了洼地本身,这一句负责让
// agent 知道**代价具体是什么**:不确认,后面这几站一站都不走。
const FOLLOW_UP_RAIL_NOTE = (taskId: string, summary: string) =>
  `\n具体到本任务:它身上挂着一条执行链(${summary}),此刻停在「让 AI 干活」这一站等你确认 —— ` +
  `调了 complete_task(taskId="${taskId}")后面的站才会自己往下跑,只调 report_stage 不会推动这条线。`;

/**
 * 线上除了「让 AI 干活」还有别的站、且游标此刻真停在那一站时,给续聊回合补一句上面那段。
 *
 * 判据本体在 `railStalledAtRun`,跟结算后写给用户的那句同源 —— 各写各的那一版里,这头
 * 漏了游标判断,验证打回(verify_failed)的轮次上就会对 agent 说假话:那一档故意不清账、
 * 游标还停在验证站,提醒里却写着「停在让 AI 干活」。
 *
 * 必须排在 `recordTurnBaseline` 之后:清账会把游标搬回起点,搬之前读到的是旧值。
 */
export async function followUpRailNote(taskId: string): Promise<string> {
  const def = await railStalledAtRun(taskId);
  if (!def) return "";
  return FOLLOW_UP_RAIL_NOTE(taskId, def.steps.map((step) => STEP_LABELS[step.kind]).join(" → "));
}

// The task's worktree was gone AND its branch with it, so we rebuilt an empty one.
// The CLI conversation lives outside the worktree (~/.claude/projects/<escaped
// cwd>/), so `--resume` hands the agent a full memory of files that no longer
// exist — it would happily "finish the last bit" on top of nothing. Break that
// continuity explicitly: the agent must re-read reality before acting. Shown to
// the user too (its own timeline bubble), since a silently reset workspace is
// exactly the kind of thing you must not discover at review time.
export const WORKSPACE_RESET = (path: string) =>
  `\n\n〔重要·工作目录已重建〕本任务原来的 worktree 和分支都已不存在(被删除了),ash 刚在 ${path} 建了一个空的工作目录:` +
  `你在上文里创建或修改过的文件**现在全都不在了**,git 历史也回到了基线。请不要相信上文中「我已经改过某某文件」的记忆——` +
  `动手之前先实际看一遍当前目录(ls / git status / git log),据此重新判断还要做什么。`;
export const WORKSPACE_RESET_MARKER = "〔系统〕原工作目录(worktree 与分支)已不存在，已重建为空目录并提醒 agent 重新确认现状";
// 任务登记的 base ref 已经不存在了（验收合并后目标分支被删是最常见的一种）。跟上面那条
// 一样要落进会话：分支基线换了人得知道。
//
// 「工作目录这一轮是怎么来的」有**三种**，一句都不能混：曾经用一个布尔同时表示「新建了
// 目录」和「按 used 新建的」，撞上「旧目录没了、同名 tag 还在」时它是 false，于是同一条
// 时间线先写上面那条 WORKSPACE_RESET_MARKER（已重建），紧接着又写「沿用原有的工作目录」，
// 用户刷新后根本判断不出这轮到底发生了什么（审查实测）。
export const WORKSPACE_BASE_FALLBACK_MARKER = (
  requested: string,
  used: string,
  workspace: { workspaceRebuilt: boolean; builtFromRequested: boolean },
  persisted: boolean,
) =>
  `〔系统〕任务登记的基线分支 ${requested} 已不存在，` +
  // 没新建目录（worktree 本来就在，或按任务分支恢复回来）时说成已重建就是假话 —— 用户会
  // 以为自己的改动被挪到了另一个基线上。新建了目录也还要分：名字还解析得出提交（同名
  // tag/SHA）时目录仍是从用户选的那个起点建的，跟「退回仓库当前分支」是两回事。
  (!workspace.workspaceRebuilt
    ? `本次沿用原有的工作目录，未改动其内容`
    : workspace.builtFromRequested
      ? `本次工作目录仍从同名的 ${requested}（tag 或提交）新建`
      : `本次工作目录改按仓库当前 ${used} 新建`) +
  // 说到底用户关心的是「那我这一轮做的东西还交得掉吗」。基线跟着落了库，diff 和验收就
  // 跟这次重建走同一个目标；没落库(团队执行者继承的共享分支、detached HEAD)时不能这么
  // 说 —— 那句话会变成一个到验收时才被戳穿的承诺。
  (persisted
    ? `，任务登记的基线也已一并更新为 ${used}（后续查看 diff 与验收都以它为目标）`
    : `，任务登记的基线未改动`);
// 这一轮**根本没起跑**（worktree 建不出来、执行器解析失败……）时留给用户的交代。走
// appendTaskTimeline 落进会话，所以不带 〔系统〕 前缀（那是 writeTurn 直写那条路的写法）。
// 真人发的话一并附上原文：它一个字都没送到 agent 那儿，会话里也不会有它的气泡，不写下来
// 就真的凭空消失了 —— 这正是「发出去没反应」的现场。
export const TURN_FAILED_TO_START = (reason: string, text?: string) =>
  `这一轮没能起跑：${reason}` +
  (text ? `\n\n你刚发的这条消息**没有送达** agent，原文如下，修好后可以重发：\n\n${text}` : "");
