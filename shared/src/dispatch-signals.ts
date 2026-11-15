import type { QuestionItem } from "./index.ts";
import type { QuestionRecord } from "./questions.ts";

/**
 * 派出的任务来问 / 失败的那一刻（server/src/db/schema-dispatch-signals.ts），画在派它的那条任务的会话里。
 * 记的是那一刻的事：题目、原因都是当时的原话；那条任务后来怎样，读任务列表里它此刻的样子。
 *
 * **先后 = (at, seq)**：先比那一刻，同一刻（同一毫秒一起来）再比序号。序号单独不代表先后 ——
 * 记录不止一个来源（触发器跟着那一笔实时记的、升级时补录的），补录的序号是补录时才排的。
 * 读接口按它排，页面上气泡的位置、答题卡轮到谁也都按它。
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
  /** 这一问后来答过没有（不论在哪答的）：答复认领那一问时同一个事务里记下的。 */
  answered?: boolean;
  /** 在派它的那条任务里答的：那条问答记录。在别处答的为空。 */
  answer?: QuestionRecord | null;
};
