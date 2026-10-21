// 引导会话的**旧方向状态**：进门时拍下的那份快照，以及清场与回滚。
//
// 从 task-steer.ts 搬出来单独成文件：那边是「怎么把队首那条消息送进同一个 CLI 会话」，这边是
// 「送之前把旧方向的哪些东西收起来、送失败了怎么放回去」。两件事各自都在长，挤在一个文件里
// 已经到了行数上限。
//
// 这一层的要害只有一句：**三张票各有各的资格**。
//
//  · 回合身份（turn / direction token 与版本）—— 按「还是我清场时那一代」判；
//  · 提问 + 完成票 —— 回合还在时按回合身份判；回合已经结束就只剩**方向世代**
//    （`tasks.direction_epoch`，见 task-direction-epoch.ts）—— 「那几列还空着」证明不了归属，
//    因为 `status.ts` 离开运行态时本来就会把它们清空，于是一个已经跑完新回合的任务看起来跟
//    「我刚清掉、还没人动过」一模一样（第 4 轮审查 F1-B）；
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
import { confirmDone, revokeConfirmed, takeConfirmed } from "./task-confirmation.js";
import {
  directionEpochUnchangedSince, directionIdentityRestored, directionRotate,
} from "./task-direction-epoch.js";
import {
  announceResumePrompt,
  restoreResumePrompt,
  resumePromptUnchangedSince,
  resumePromptVoidPatch,
} from "./task-resume-prompt.js";
import { id, now } from "./util.js";

export interface PreviousDirectionState {
  activeTurnToken: string | null;
  activeDirectionToken: string | null;
  activeDirectionVersion: number;
  /** 进门时读到的方向世代 —— 清场的 CAS 用它问「这一格还是我读到的那个方向吗」。 */
  directionEpoch: number;
  clearedTurnToken: string;
  clearedDirectionToken: string;
  clearedDirectionVersion: number;
  /**
   * **这条改派清完之后留下的那一代方向世代**，不是进门读到的那一代。
   *
   * 跟 `resumePromptGeneration` 同一个道理（见下面那段注释）：清场自己就换了一个方向、把世代
   * 推走了，回滚要是拿进门那一代当资格就会被自己挡死。所以记的是「我离开时任务停在第几代」，
   * 回滚问的永远是「还是我离开时那一代吗」—— 相等 ⇒ 这中间没有任何新方向开过工（回合结没
   * 结束都算），不等 ⇒ 我是迟到者（第 4 轮审查 F1-B）。
   */
  clearedDirectionEpoch: number;
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
  const current = (await db
    .select({
      activeTurnToken: tasks.activeTurnToken,
      activeDirectionToken: tasks.activeDirectionToken,
      activeDirectionVersion: tasks.activeDirectionVersion,
      directionEpoch: tasks.directionEpoch,
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
  if (!current) throw new Error("任务不存在");
  // **收走内存那张票要先知道它该属于哪一代**（runs.ts）：只收旧方向这一代的，新方向自己拿到
  // 的确认一个字都不能碰。所以这一步排在读出 `directionEpoch` 之后 —— 读与取之间只隔一次
  // select，期间落下的确认同属这一代，由下面那次 take 兜住。
  const confirmedBefore = takeConfirmed(taskId, current.directionEpoch);
  const clearedTurnToken = rotateTurnToken ? id() : current.activeTurnToken;
  const clearedDirectionToken = id();
  const clearedDirectionVersion = Math.max(current.activeDirectionVersion + 1, 2);
  if (!clearedTurnToken) {
    // 还票按**它来的那一代**还：这一笔还没改过任何东西，所以它仍是当下这一代，本回合的结算
    // 照样认（见 runs.ts 的口径：作不作数由消费者比当下那一代来答）。
    if (confirmedBefore) confirmDone(taskId, current.directionEpoch);
    throw new Error("当前回合缺少身份 token，无法原生引导");
  }
  const updatedAt = now();
  let memoryConfirmed = confirmedBefore;
  let generationAfterClear = current.resumePromptGeneration;
  let epochAfterClear = current.directionEpoch;
  try {
    const updated = await db
      .update(tasks)
      .set({
        // **换方向就是换方向**:三列回合内身份连同那一列永不归零的世代一起落库（走
        // task-direction-epoch.ts 的唯一写入口）。世代在这里前进,是为了让「上一条改派的迟到
        // 回滚」撞上「这一条改派」时也认得出自己过期了 —— 两条改派之间任务可能根本没离开过
        // 运行态,那时 `status.ts` 的归零压根不会发生。
        ...directionRotate(clearedTurnToken, clearedDirectionToken, clearedDirectionVersion),
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
        // 老库里那些升级前就在跑的回合 token 全是 null,上面三条于是退化成「现在也空着」——
        // 而一轮完整跑完的新回合结束后看起来正是那样。世代补上这条缝:它只增不减,跑过就认得出。
        directionEpochUnchangedSince(current.directionEpoch),
        current.completeConfirmedAt === null
          ? isNull(tasks.completeConfirmedAt)
          : eq(tasks.completeConfirmedAt, current.completeConfirmedAt),
        // **连代次一起比**：只比文字的话，这中间那一段被取走、又被原样写成一段新的主动暂停
        // （文字一样、代次已变）时清场照样命中，于是带走的是 SELECT 读到的旧来源配上作废推出
        // 的新代次 —— 那份错配的凭证随后合法回填，把真人刚写下的主动暂停洗成系统等待、被
        // `clearAutoCheckpoint` 删掉（第 4 轮审查 F1-A）。代次变了就一行都不匹配，整笔清场
        // 退回下面那句「请重试引导」：宁可让这一趟改派重来，也不能替一次陌生的占用签发凭证。
        ...resumePromptUnchangedSince({
          text: current.resumePrompt,
          generation: current.resumePromptGeneration,
        }),
        current.question === null ? isNull(tasks.question) : eq(tasks.question, current.question),
        current.questionOptions === null
          ? isNull(tasks.questionOptions)
          : eq(tasks.questionOptions, current.questionOptions),
        current.questionItems === null
          ? isNull(tasks.questionItems)
          : eq(tasks.questionItems, current.questionItems),
      ))
      // 清完之后那一格是第几次占用 —— 回滚的 CAS 认的是这一个值（见快照字段的注释）。
      .returning({
        id: tasks.id,
        generation: tasks.resumePromptGeneration,
        epoch: tasks.directionEpoch,
      });
    memoryConfirmed = takeConfirmed(taskId, current.directionEpoch) || memoryConfirmed;
    if (!updated.length) throw new Error("当前回合状态已变化，请重试引导");
    generationAfterClear = updated[0]!.generation;
    epochAfterClear = updated[0]!.epoch;
  } catch (error) {
    memoryConfirmed = takeConfirmed(taskId, current.directionEpoch) || memoryConfirmed;
    // 还给**它原来那一代**。这里有一条新失败路径：CAS 落空（这中间又跑完了一轮新回合，
    // 世代已经变了）—— 那时还回去的这张票对当下这一代不作数，下一次结算会把它当没有确认过
    // 直接丢掉，而不是让一轮从没交卷的工作显示「已完成」（第 1 轮审查 F1
    // `clear-CAS-rejected-but-memory-restored`）。UPDATE 自己抛错那一支则相反：行没动过，
    // 这一代仍是它，本回合照样认得出 —— 两种都由消费者比对，这里不必分情况。
    if (memoryConfirmed) confirmDone(taskId, current.directionEpoch);
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
    clearedDirectionEpoch: epochAfterClear,
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
  //
  // 这一扫**不分代次**（`revokeConfirmed`）：它的语义就是「ACK 之前落下来的任何残留都不作数」。
  // 此刻新方向的正文还没写进去、方向协议 token 也还没到 agent 手上，所以这一格里不可能有属于
  // 新方向的票；而旧方向那张可能是绕开身份 CAS 落进来的（它不一定带着旧那一代的编号）—— 按代
  // 收会把它漏掉，那正是「旧方向的完成票不得穿进新方向」要挡的东西。
  revokeConfirmed(taskId);
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
  revokeConfirmed(taskId);
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
 *
 * **回合已经结束的那一支另有一道闸**：那时 token 全被 `status.ts` 清空，「这几列还空着」就不再
 * 证明任何归属 —— 一个已经跑完新回合的任务看起来跟「我刚清掉、还没人动过」一模一样。所以备用
 * 分支还要问一句方向世代（`tasks.direction_epoch`，回合起跑和方向轮换各 +1、永不归零）：还是我
 * 离开时那一代才落地（第 4 轮审查 F1-B）。
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
      // 放回旧身份,不是装一个新方向 ⇒ 不推世代（写法收口在 task-direction-epoch.ts）。
      ...directionIdentityRestored(previous, preserveDirectionBarrier),
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
      // 跟下面那一支同一口径:每一笔回滚都带世代。这里它是冗余的（方向 token 是现开的随机值,
      // 对得上就说明没人换过方向）—— 但留两种写法迟早会漏,而漏掉的那一处就是 F1-B。
      directionEpochUnchangedSince(previous.clearedDirectionEpoch),
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
    //
    // **「现在空着」只够排除并发写入，排除不了「后来又跑完了一轮」**：那一轮结束时这几列同样
    // 被清回空，于是迟到的旧回滚会把旧提问、旧完成确认写到一个早已跑完新工作的任务头上（第 4
    // 轮审查 F1-B 实测 `F1_B_LATE_ROLLBACK_AFTER_NEW_DIRECTION_DONE`）。方向世代补上这条边。
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
        directionEpochUnchangedSince(previous.clearedDirectionEpoch),
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
  // **内存那张票也得带着世代回去**（runs.ts）。还的是「这条改派离开时任务停在的那一代」：
  //  · 同一轮内正常失败 ⇒ 当下就是那一代，本回合结算照样认；
  //  · SQL 刚落、新回合紧接着开跑（报告实测的那条 TOCTOU）⇒ 当下已经是下一代，这张票对新
  //    一轮不作数，结算会把它当没确认过丢掉 —— 否则一轮从没交卷的工作直接显示「已完成」
  //    （第 1 轮审查 F1）。
  if (previous.memoryConfirmed) confirmDone(taskId, previous.clearedDirectionEpoch);
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

/**
 * 停止抢在引导前面落地时，把那张完成票单独放回去（结算已经跑完，所以只剩这一张票要补）。
 *
 * 它天生只有备用分支那一种形态（回合已经结束，token 必然是 null），所以**世代这道闸在这里是
 * 唯一的归属判据**：比空活动回合和旧正文/提问只能说明「此刻没人占着」，而一个已经跑完新回合
 * 的任务正好也是那个样子 —— 旧完成确认于是被写回去，下一次结算就拿它当这一轮交了卷（第 4 轮
 * 审查 F1-B 实测 `F1_B_COMPLETION_FALLBACK_SAME_CLASS`）。
 */
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
      directionEpochUnchangedSince(previous.clearedDirectionEpoch),
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
  if (restored.length && previous.memoryConfirmed) confirmDone(taskId, previous.clearedDirectionEpoch);
}
