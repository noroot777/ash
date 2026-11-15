import type { QuestionItem } from "./index.ts";
import type { QuestionRecord } from "./questions.ts";

/**
 * 派出的任务来问 / 失败的那一刻（server/src/db/schema-dispatch-signals.ts），画在派它的那条任务的会话里。
 * 记的是那一刻的事：题目、原因都是当时的原话；那条任务后来怎样，读任务列表里它此刻的样子。
 */
export type DispatchSignal = {
  seq: number;
  /** 派出的那条任务。 */
  taskId: string;
  kind: "question" | "failed";
  at: string;
  question?: string | null;
  questionOptions?: string[] | null;
  questionItems?: QuestionItem[] | null;
  /** 失败的原因（一句话）；结算还没说出来、或者说不出来时为空。 */
  reason?: string | null;
  /** 这一问后来答过没有（不论在哪答的）：提问之后、它下一次提问之前有没有一条答复记录。 */
  answered?: boolean;
  /** 在派它的那条任务里答的：那条问答记录。在别处答的为空。 */
  answer?: QuestionRecord | null;
};
