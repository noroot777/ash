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
import { MAX_QUESTION_OPTIONS, MAX_QUESTION_OPTION_LEN } from "@harness/shared";
import type { QuestionItem } from "@harness/shared";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
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
