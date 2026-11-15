/**
 * 派出的任务失败的那一刻（server/src/db/schema-dispatch-signals.ts），画在派它的那条任务的会话里。
 * 记的是那一刻的事：原因是当时的原话；那条任务后来怎样，读任务列表里它此刻的样子。
 *
 * **先后 = (at, seq)**：先比那一刻，同一刻（同一毫秒一起来）再比序号。读接口按它排，页面上气泡的
 * 位置也按它。
 */
export type DispatchSignal = {
  seq: number;
  /** 派出的那条任务。 */
  taskId: string;
  kind: "failed";
  at: string;
  /** 失败的原因（一句话）；结算还没说出来、或者说不出来时为空。 */
  reason: string | null;
};
