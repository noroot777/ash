// 给一个任务挂上「等你答复」的提问。
//
// 两条路共用这一处：agent 自己调 `ask_question`（POST /tasks/:id/ask），以及**工作流
// 里某一站没过、线上写着「问我一句」**时由执行链发起。写库和广播必须绑在一起——
// `task.status` 不捎 question，提问态的出现/消失走独立的 `task.question` 事件，漏发
// 一次卡片就杵在那儿像是没答上。
//
// 答复一律走既有的 POST /tasks/:id/answer：清空提问，把答复原样送进这个任务的 CLI
// 会话。所以工作流的提问也**不需要另开一条决策链路** —— 用户答「重做一次，先修
// 类型错误」，干活的 agent 就带着这句话接着干；答「先这样，我自己来」，它就停在那儿。
import { eq } from "drizzle-orm";
import { MAX_QUESTION_OPTIONS, MAX_QUESTION_OPTION_LEN } from "@ash/shared";
import type { AgentType, QuestionItem, SessionRole } from "@ash/shared";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { agents, sessions, tasks } from "./db/schema.js";
import { now } from "./util.js";

export interface AskInput {
  taskId: string;
  question: string;
  options?: string[];
  items?: QuestionItem[] | null;
}

/** 写库 + 广播。校验（空问题、超限）由调用方做，这里只负责落地和发事件。 */
export async function setTaskQuestion({ taskId, question, options = [], items = null }: AskInput): Promise<void> {
  const updatedAt = now();
  await db
    .update(tasks)
    .set({
      question,
      questionOptions: options.length ? JSON.stringify(options) : null,
      questionItems: items ? JSON.stringify(items) : null,
      updatedAt,
    })
    .where(eq(tasks.id, taskId));
  bus.publish({
    type: "task.question",
    taskId,
    updatedAt,
    question,
    questionOptions: options.length ? options : null,
    questionItems: items,
  });
}

/**
 * 答复该送回给**提问的那个** agent,而不是任务的常设执行器。
 *
 * 一个普通任务可以住着好几个智能体(每个 @ 召唤进来的都有自己的会话行),提问的
 * 完全可能是被召唤来的那个。照 `task.agentType` 续跑等于把答复念给了另一个 CLI:
 * 它既没提过这个问题,也没有那一回合的上下文。会话行按**回合时间**取最新的那条,
 * 就是刚停下来提问的那条(单飞锁保证同一时刻只有一个在跑)。
 *
 * executorId 由会话记下的 profile 名反查:同一类型下换过 profile(供应商/模型都可能
 * 不同)时,续跑得回到当初那一个,查不到才按类型默认执行器降级。
 */
export async function askingAgentFor(
  taskId: string,
): Promise<{ agent: AgentType; executorId: string | null; role: Extract<SessionRole, "single" | "reviewer"> } | null> {
  const turnAt = (row: { turnStartedAt: string | null; startedAt: string }) => row.turnStartedAt ?? row.startedAt;
  const latest = (await db.select().from(sessions).where(eq(sessions.taskId, taskId)))
    .filter((row) => row.role === "single" || row.role === "reviewer")
    .sort((left, right) => turnAt(left).localeCompare(turnAt(right)))
    .at(-1);
  if (!latest) return null;
  const profile = (await db.select().from(agents).where(eq(agents.name, latest.executor))).at(0);
  return { agent: latest.agentType as AgentType, executorId: profile?.id ?? null, role: latest.role as "single" | "reviewer" };
}

/**
 * 工作流的「问我一句」：某一站没过，问用户接下来怎么办。
 *
 * 候选答案是**建议答案不是单选题**（点一下是填进输入框），所以每条都写成一句能直接
 * 当答复读的话。上限跟 agent 提问共用同一组常量，超了就截断——这里的选项是我们自己
 * 生成的固定几条，不存在「悄悄砍掉用户看不见的候选」那个问题。
 */
export async function askAboutFailure(
  taskId: string,
  stepLabel: string,
  reason: string | null | undefined,
): Promise<void> {
  const detail = (reason ?? "").trim();
  const question = `这条线在「${stepLabel}」这一站没过，线上写的是「问我一句」——接下来怎么办？`
    + (detail ? `\n\n\`\`\`\n${detail.slice(0, 1200)}\n\`\`\`` : "");
  await setTaskQuestion({
    taskId,
    question,
    options: [
      "重做一次：按上面的报错改到它能过，然后照常确认完成。",
      "跳过这一站：这个问题不影响交付，接着往下走。",
      "先停着，我自己来处理。",
    ].slice(0, MAX_QUESTION_OPTIONS).map((text) => text.slice(0, MAX_QUESTION_OPTION_LEN)),
  });
}
