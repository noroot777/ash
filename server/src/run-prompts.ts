import { STEP_LABELS } from "@harness/shared/workflow";
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
// 宽松模式(HARNESS_LAX_DONE,典型:预览实例)下这三段一律退化成空串 —— 那台 harness
// 的 MCP 对 agent 不可达,交代了它也做不到,理由见 single-run.ts 的 STRICT_DONE_PROTOCOL。
const ACCEPTANCE_REMINDER = (taskId: string, sharedTeamWorker: boolean, verifying: boolean, free = false) => verifying
  ? "验收辅路:验证回合不适用 accept_task；这一轮只负责给出验证结论并留证。"
  : free
    ? "自由工作流:完成实现后只调用 complete_task；不要调用 report_stage 或 accept_task，派审、预览、合并与清理由用户在页面快捷按钮中按需触发。"
  : sharedTeamWorker
    ? "验收辅路:本共享执行者不适用 accept_task；合并与验收由团队级处理。"
    : `验收辅路:准备交给人工验收前可调用 report_stage(taskId="${taskId}", stage="awaiting_acceptance")；` +
      `只有用户明确表示「验收通过/可以合并」时，调用 accept_task(taskId="${taskId}")，不要自行运行 git merge、worktree remove 或 branch -d。`;
export const COMPLETION_PROTOCOL = (taskId: string, sharedTeamWorker: boolean, reviewTask: boolean, free = false) =>
  !STRICT_DONE_PROTOCOL ? "" :
  `【完成协议】本任务在 harness 的 taskId 是 ${taskId}。当且仅当你确定任务目标已经达成时,在结束前调用 harness MCP 的 complete_task(taskId="${taskId}")确认完成;未确认就结束,本回合会按未完成记为 failed。跑到需要等待外部条件的检查点时,改用 pause_task 写下续跑指令。\n\n${ACCEPTANCE_REMINDER(taskId, sharedTeamWorker, reviewTask, free)}\n\n`;
export const COMPLETION_REMINDER = (taskId: string, sharedTeamWorker: boolean, reviewTask: boolean, free = false) =>
  !STRICT_DONE_PROTOCOL ? "" :
  `\n\n(harness 完成协议:taskId=${taskId}。若本回合结束时任务目标已达成,先调用 complete_task 确认再结束,否则按未完成记 failed;到等待检查点则用 pause_task。${ACCEPTANCE_REMINDER(taskId, sharedTeamWorker, reviewTask, free)})`;

// 续聊(follow-up)回合的尾巴:任务早就到终态了,这一轮是「完成之后的对话」,
// 不该拿严格完成协议吓唬 agent(不确认就 failed)—— 这一轮不确认,任务状态原样
// 不动。只有它真把任务推进到新的完成时才需要确认。
export const FOLLOW_UP_REMINDER = (
  taskId: string, from: string, sharedTeamWorker: boolean, reviewTask: boolean, rail: string, free = false,
) =>
  !STRICT_DONE_PROTOCOL ? "" :
  `\n\n(harness:这是任务在「${FOLLOW_UP_LABEL[from] ?? from}」之后的续聊,taskId=${taskId}。任务状态不会因为本回合而改变,本回合不需要 complete_task;只有当你在这一轮把任务推进到了新的完成状态时,才调用 complete_task(taskId="${taskId}")确认。${rail}${ACCEPTANCE_REMINDER(taskId, sharedTeamWorker, reviewTask, free)})`;

// 「你这一轮要是改了代码,这条线在等你确认」—— 只在续聊回合、且任务身上真挂着一条
// 还有后续站的线时追加。
//
// 补它是因为上面那句「不需要 complete_task」在有线的任务上会把 agent 引进一个洼地:
// 用户续聊说「改成 XXX」,agent 改完、按验收辅路那句调了 report_stage(awaiting_acceptance)
// 就收工 —— 它以为已经交给人工验收了,可**线的推进只认 complete_task**
// (`handleTaskSettlement` 的 `confirmedDone && status === "done"`),于是新一版代码躺在
// 那儿,预览没开、人工关口没到,游标停在「让 AI 干活」原地不动,用户看到的是「怎么第一步
// 就停了」(实测任务 1rojF5Tjau91)。改代码这一档本来就属于「把任务推进到了新的完成状态」,
// 只是没人对 agent 明说过 —— 它得同时知道这条线存在、以及不确认的后果是线不走。
const FOLLOW_UP_RAIL_NOTE = (taskId: string, summary: string) =>
  `\n本任务身上挂着一条执行链(${summary}),它停在「让 AI 干活」这一站等你确认:` +
  `你这一轮**改了代码**就属于上面说的「推进到了新的完成状态」,做完请调 complete_task(taskId="${taskId}")确认,` +
  `后面的站才会自己往下跑;只调 report_stage 不会推动这条线。纯回答问题、没动代码则不用确认。`;

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
  `\n\n〔重要·工作目录已重建〕本任务原来的 worktree 和分支都已不存在(被删除了),harness 刚在 ${path} 建了一个空的工作目录:` +
  `你在上文里创建或修改过的文件**现在全都不在了**,git 历史也回到了基线。请不要相信上文中「我已经改过某某文件」的记忆——` +
  `动手之前先实际看一遍当前目录(ls / git status / git log),据此重新判断还要做什么。`;
export const WORKSPACE_RESET_MARKER = "〔系统〕原工作目录(worktree 与分支)已不存在，已重建为空目录并提醒 agent 重新确认现状";
