// 引导会话的**旧方向状态**：进门时拍下的那份快照，以及清场与回滚。
//
// 从 task-steer.ts 搬出来单独成文件：那边是「怎么把队首那条消息送进同一个 CLI 会话」，这边是
// 「送之前把旧方向的哪些东西收起来、送失败了怎么放回去」。两件事各自都在长，挤在一个文件里
// 已经到了行数上限。
//
// 这一层的要害只有一句：**三张票各有各的资格**。
//
//  · 回合身份（turn / direction token 与版本）—— 按「还是我清场时那一代」判；
//  · 提问 + 完成票 —— 按「那几列还空着」判；
//  · 那段检查点 —— 按存储层的口径判（空槽 + 同一次占用），跟回合身份无关。
//
// 把它们挤进同一笔 UPDATE、共用一套 CAS，就会出现「检查点那一侧不符，于是用户的问题和 agent
// 的完成确认也一起放弃恢复」—— 第 3 轮审查 F1-C 实测到的现场：新工作一个字没送出去，原来的
// 安排三样同时消失。
import type { QuestionItem } from "@ash/shared";
import { and, eq, isNull, ne } from "drizzle-orm";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { confirmDone, takeConfirmed } from "./runs.js";
import { announceResumePrompt, resumePromptVoidPatch, restoreResumePrompt } from "./task-resume-prompt.js";
import { id, now } from "./util.js";

export interface PreviousDirectionState {
  activeTurnToken: string | null;
  activeDirectionToken: string | null;
  activeDirectionVersion: number;
  clearedTurnToken: string;
  clearedDirectionToken: string;
  clearedDirectionVersion: number;
  completeConfirmedAt: string | null;
  // 那段续跑指令的**整张凭证**：文字、谁写的、这一格被占用的第几次（第 2 轮审查 F2）。
  // 只记文字的话，回滚填回去时来源只能靠任务行上那个可能已经改过的布尔 —— 期间有人写过新的
  // 一段又被取走时，这段文字就会继承到不属于它的来源。
  resumePrompt: string | null;
  resumePromptAuto: boolean;
  /**
   * **这条改派自己最后留下的那一代**，不是进门时读到的那一代（第 3 轮审查 F1-C）。
   *
   * 回滚要分清两件事：「这中间别人写下了新意图」（代次变了 ⇒ 这段旧文字就此过期）和「代次是
   * 我自己清场推走的」（那不是新意图，凭它拒绝回滚就是自己把自己挡死）。所以清场的每一步都
   * 把结果写回这一格：回滚的 CAS 问的永远是「还是我离开时那一代吗」。
   */
  resumePromptGeneration: number;
  question: string | null;
  questionOptions: string | null;
  questionItems: string | null;
  memoryConfirmed: boolean;
}

export async function clearPreviousDirectionState(
  taskId: string,
  rotateTurnToken = true,
): Promise<PreviousDirectionState> {
  // 硬切降级先换 token 再 kill；原生 steer 仍是同一个活动 turn，必须保留 token，让同一
  // 进程里后续的 complete_task / ask_question 继续有效。两种路径都清两次内存快路。
  const confirmedBefore = takeConfirmed(taskId);
  const current = (await db
    .select({
      activeTurnToken: tasks.activeTurnToken,
      activeDirectionToken: tasks.activeDirectionToken,
      activeDirectionVersion: tasks.activeDirectionVersion,
      completeConfirmedAt: tasks.completeConfirmedAt,
      resumePrompt: tasks.resumePrompt,
      resumePromptAuto: tasks.resumePromptAuto,
      resumePromptGeneration: tasks.resumePromptGeneration,
      question: tasks.question,
      questionOptions: tasks.questionOptions,
      questionItems: tasks.questionItems,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))).at(0);
  if (!current) {
    if (confirmedBefore) confirmDone(taskId);
    throw new Error("任务不存在");
  }
  const clearedTurnToken = rotateTurnToken ? id() : current.activeTurnToken;
  const clearedDirectionToken = id();
  const clearedDirectionVersion = Math.max(current.activeDirectionVersion + 1, 2);
  if (!clearedTurnToken) {
    if (confirmedBefore) confirmDone(taskId);
    throw new Error("当前回合缺少身份 token，无法原生引导");
  }
  const updatedAt = now();
  let memoryConfirmed = confirmedBefore;
  let generationAfterClear = current.resumePromptGeneration;
  try {
    const updated = await db
      .update(tasks)
      .set({
        activeTurnToken: clearedTurnToken,
        activeDirectionToken: clearedDirectionToken,
        activeDirectionVersion: clearedDirectionVersion,
        completeConfirmedAt: null,
        // **清场要连在途的旧凭证一起作废**：这一笔清掉的那段检查点可能早就被消息账本取走、还
        // 在路上，而它那一侧的回填只认「空槽 + 同一代次」。不推代次的话，那段旧文字能凭一个空
        // 槽填回**新方向**头上（第 3 轮审查 F1 的 Codex 那一支：它的成功路径没有第二次清场）。
        // 推走的这一代随后由 `generationAfterClear` 记进快照 —— 回滚问的是「还是我离开时那一代
        // 吗」，所以自己推的代次挡不住自己（F1-C）。
        ...resumePromptVoidPatch(),
        question: null,
        questionOptions: null,
        questionItems: null,
        updatedAt,
      })
      .where(and(
        eq(tasks.id, taskId),
        current.activeTurnToken === null
          ? isNull(tasks.activeTurnToken)
          : eq(tasks.activeTurnToken, current.activeTurnToken),
        current.activeDirectionToken === null
          ? isNull(tasks.activeDirectionToken)
          : eq(tasks.activeDirectionToken, current.activeDirectionToken),
        eq(tasks.activeDirectionVersion, current.activeDirectionVersion),
        current.completeConfirmedAt === null
          ? isNull(tasks.completeConfirmedAt)
          : eq(tasks.completeConfirmedAt, current.completeConfirmedAt),
        current.resumePrompt === null
          ? isNull(tasks.resumePrompt)
          : eq(tasks.resumePrompt, current.resumePrompt),
        current.question === null ? isNull(tasks.question) : eq(tasks.question, current.question),
        current.questionOptions === null
          ? isNull(tasks.questionOptions)
          : eq(tasks.questionOptions, current.questionOptions),
        current.questionItems === null
          ? isNull(tasks.questionItems)
          : eq(tasks.questionItems, current.questionItems),
      ))
      // 清完之后那一格是第几次占用 —— 回滚的 CAS 认的是这一个值（见快照字段的注释）。
      .returning({ id: tasks.id, generation: tasks.resumePromptGeneration });
    memoryConfirmed = takeConfirmed(taskId) || memoryConfirmed;
    if (!updated.length) throw new Error("当前回合状态已变化，请重试引导");
    generationAfterClear = updated[0]!.generation;
  } catch (error) {
    memoryConfirmed = takeConfirmed(taskId) || memoryConfirmed;
    if (memoryConfirmed) confirmDone(taskId);
    throw error;
  }
  if (current?.question) {
    try {
      bus.publish({
        type: "task.question",
        taskId,
        updatedAt,
        question: null,
        questionOptions: null,
        questionItems: null,
      });
    } catch (error) {
      console.warn(`[ash] 引导会话已清提问，但实时通知失败 ${taskId}:`, error);
    }
  }
  // 提问有自己的局部事件，检查点没有：清掉的 resume_prompt 只能靠整行广播告诉前端
  // （见 task-resume-prompt.ts 顶部）。
  if (current?.resumePrompt) await announceResumePrompt(taskId);
  return {
    ...current,
    resumePromptGeneration: generationAfterClear,
    clearedTurnToken, clearedDirectionToken, clearedDirectionVersion, memoryConfirmed,
  };
}

export async function discardLateDirectionState(
  taskId: string,
  turnToken: string,
  directionToken: string,
  /** 这条改派的快照：清场推走代次时要把结果记回去，否则紧接着的回滚会被它自己挡死（F1-C）。 */
  previous: PreviousDirectionState,
): Promise<void> {
  // 原生请求确认接收前，旧方向已经发出的完成/提问/检查点仍可能刚好落库；成功 ACK 后
  // 再清一遍。此刻新消息还没开始执行，因此不会误删新方向自己产生的状态；turn token
  // 保持不变，方向 token 已在第一次清理时旋转。
  takeConfirmed(taskId);
  const late = (await db
    .select({ question: tasks.question, resumePrompt: tasks.resumePrompt })
    .from(tasks)
    .where(and(
      eq(tasks.id, taskId),
      eq(tasks.activeTurnToken, turnToken),
      eq(tasks.activeDirectionToken, directionToken),
    ))).at(0);
  const updatedAt = now();
  const discarded = await db
    .update(tasks)
    .set({
      completeConfirmedAt: null,
      // **作废,不是取走**:旧方向迟到的那段检查点不该再回来,在途的旧凭证也一律过期(同上)。
      //
      // 这一笔推走的代次同样**记回快照**。原来它只推不记,于是没有任何竞争写入也把代次推走,紧
      // 接着新正文发送失败要回滚时,回滚自己的 CAS 被自己刚推走的那一格挡死 —— 检查点、提问、
      // 完成票一起没了,而新工作压根没送出去（第 3 轮审查 F1-C 实测
      // `F2_NATIVE_STEER_SELF_INVALIDATES_ROLLBACK`）。
      ...resumePromptVoidPatch(),
      question: null,
      questionOptions: null,
      questionItems: null,
      updatedAt,
    })
    .where(and(
      eq(tasks.id, taskId),
      eq(tasks.activeTurnToken, turnToken),
      eq(tasks.activeDirectionToken, directionToken),
    ))
    .returning({ generation: tasks.resumePromptGeneration });
  // 这一笔真落在这条任务上(身份还对得上)时,它留下的那一代就是回滚该认的那一代。落空就不动
  // 快照:那说明身份已经换走,回滚本来就该按原来那一代判成过期。
  const generationAfterDiscard = discarded.at(0)?.generation;
  if (generationAfterDiscard !== undefined) previous.resumePromptGeneration = generationAfterDiscard;
  takeConfirmed(taskId);
  if (late?.question) {
    try {
      bus.publish({
        type: "task.question",
        taskId,
        updatedAt,
        question: null,
        questionOptions: null,
        questionItems: null,
      });
    } catch (error) {
      console.warn(`[ash] 原生引导已清迟到提问，但实时通知失败 ${taskId}:`, error);
    }
  }
  if (late?.resumePrompt) await announceResumePrompt(taskId);
}

/**
 * 引导失败后把清掉的那些东西放回去。
 *
 * **检查点和「提问 + 完成票」是两张互不相干的票，资格各判**（第 3 轮审查 F1-C）。原来它们挤在
 * 同一笔 UPDATE 里、共用一套 CAS，于是检查点那一侧的代次条件一旦不符，提问和完成确认也跟着
 * 一起放弃恢复 —— 实测到的现场是：新工作一个字都没送出去，而用户原来的问题、agent 的完成确认
 * 和那段待续工作三样同时消失。检查点的归属判据（空槽 + 同一代次）本来就跟回合身份无关，所以
 * 它走存储层那一份口径；身份、提问、完成票留在下面这一笔里按回合身份判。
 */
export async function restorePreviousDirectionState(
  taskId: string,
  previous: PreviousDirectionState,
  preserveDirectionBarrier = false,
): Promise<boolean> {
  const updatedAt = now();
  // ① 检查点：空槽 + 还是这条改派离开时那一代（存储层口径，整行广播也在那边）。
  const checkpointBack = previous.resumePrompt !== null && await restoreResumePrompt(taskId, {
    text: previous.resumePrompt,
    // **来源跟着文字一起回来**（F2）：清那一笔没动来源列，但这中间别人可能写过新的一段并把
    // 它取走，于是那一格的来源早就不是这段文字的了。代次条件保证这一笔只在「还是同一次占用」
    // 时落地，所以把快照里的来源原样写回去是安全的、也是唯一正确的。
    auto: previous.resumePromptAuto,
    generation: previous.resumePromptGeneration,
  });
  // ② 身份 + 提问 + 完成票：**不带检查点的任何条件**（见函数头）。
  let restored = await db
    .update(tasks)
    .set({
      activeTurnToken: previous.activeTurnToken,
      activeDirectionToken: preserveDirectionBarrier
        ? previous.clearedDirectionToken
        : previous.activeDirectionToken,
      activeDirectionVersion: preserveDirectionBarrier
        ? previous.clearedDirectionVersion
        : previous.activeDirectionVersion,
      completeConfirmedAt: previous.completeConfirmedAt,
      question: previous.question,
      questionOptions: previous.questionOptions,
      questionItems: previous.questionItems,
      updatedAt,
    })
    .where(and(
      eq(tasks.id, taskId),
      eq(tasks.activeTurnToken, previous.clearedTurnToken),
      eq(tasks.activeDirectionToken, previous.clearedDirectionToken),
      eq(tasks.activeDirectionVersion, previous.clearedDirectionVersion),
      isNull(tasks.completeConfirmedAt),
      isNull(tasks.question),
      isNull(tasks.questionOptions),
      isNull(tasks.questionItems),
    ))
    .returning({ id: tasks.id });
  if (!restored.length) {
    // 旧回合可能已按停止/自然结束完成结算：setTaskStatus 会把 token 置 null，但清掉的
    // 方向字段仍全是 null。只在任务已离开运行态且这些字段仍未被新写入时恢复，避免
    // 覆盖停止窗口里新产生的提问、检查点或完成票。
    restored = await db
      .update(tasks)
      .set({
        completeConfirmedAt: previous.completeConfirmedAt,
        question: previous.question,
        questionOptions: previous.questionOptions,
        questionItems: previous.questionItems,
        updatedAt,
      })
      .where(and(
        eq(tasks.id, taskId),
        isNull(tasks.activeTurnToken),
        ne(tasks.status, "running"),
        ne(tasks.status, "queued"),
        isNull(tasks.completeConfirmedAt),
        isNull(tasks.question),
        isNull(tasks.questionOptions),
        isNull(tasks.questionItems),
      ))
      .returning({ id: tasks.id });
  }
  // 检查点填回去了也算「恢复过东西」：那两件事各判资格，任何一件成了都不该报「什么都没恢复」。
  if (!restored.length) return checkpointBack;
  if (previous.memoryConfirmed) confirmDone(taskId);
  if (previous.question) {
    try {
      bus.publish({
        type: "task.question",
        taskId,
        updatedAt,
        question: previous.question,
        questionOptions: previous.questionOptions
          ? JSON.parse(previous.questionOptions) as string[]
          : null,
        questionItems: previous.questionItems
          ? JSON.parse(previous.questionItems) as QuestionItem[]
          : null,
      });
    } catch (error) {
      console.warn(`[ash] 引导会话已恢复提问，但实时通知失败 ${taskId}:`, error);
    }
  }
  return true;
}

export async function restorePreviousCompletionState(
  taskId: string,
  previous: PreviousDirectionState,
): Promise<void> {
  if (!previous.completeConfirmedAt && !previous.memoryConfirmed) return;
  const restored = await db
    .update(tasks)
    .set({ completeConfirmedAt: previous.completeConfirmedAt, updatedAt: now() })
    .where(and(
      eq(tasks.id, taskId),
      isNull(tasks.activeTurnToken),
      isNull(tasks.completeConfirmedAt),
      previous.resumePrompt === null
        ? isNull(tasks.resumePrompt)
        : eq(tasks.resumePrompt, previous.resumePrompt),
      previous.question === null ? isNull(tasks.question) : eq(tasks.question, previous.question),
      previous.questionOptions === null
        ? isNull(tasks.questionOptions)
        : eq(tasks.questionOptions, previous.questionOptions),
      previous.questionItems === null
        ? isNull(tasks.questionItems)
        : eq(tasks.questionItems, previous.questionItems),
    ))
    .returning({ id: tasks.id });
  if (restored.length && previous.memoryConfirmed) confirmDone(taskId);
}
