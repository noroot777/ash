// 一个任务的问答历史：调用方给的快照、整份读取、事件推送合成的**那一份**。
//
// 会话里两件事都读它：答过的气泡怎么画（QuestionHistory.tsx 的配对），和提问那一轮的结算说明要不要
// 再抄一遍题（timelineNoticeCopy.ts 的 questionsOnScreen）。两边必须是同一份——要是去重读的是 props
// 快照、气泡读的是补读之后的那份，补读一到，同一道题就既有气泡又有说明，画了两遍。所以这份合并
// 住在 hook 里，由会话组件取一次、两边各拿去用，不再藏在只有气泡读得到的 Provider 里。
import { useEffect, useMemo, useRef, useState } from "react";
import type { QuestionRecord } from "@ash/shared/questions";
import { api } from "../lib/api.ts";
import { useServerEvents } from "../lib/events.ts";
import { catchUpAbortKind } from "../lib/catchUp.ts";
import { useCatchUp, useCatchUpLink } from "../lib/useCatchUp.ts";

export type QuestionHistoryState = { records: QuestionRecord[]; error?: string; retry?: () => void };

const NONE: QuestionRecord[] = [];

/**
 * 按 id 合并几份问答历史（props 快照、整份读取、事件推送，先后不定）。删除是单向的：哪一份
 * 里它是墓碑就留墓碑 —— 删除之前发出、删除之后才到的那份旧读取不能把删掉的答复复活。记录
 * 答复之后除了被删不会再变，所以别的字段不存在「旧的盖新的」。
 */
function mergeRecords(left: QuestionRecord[], right: QuestionRecord[]): QuestionRecord[] {
  const merged = new Map<string, QuestionRecord>();
  for (const record of [...left, ...right]) {
    const known = merged.get(record.id);
    merged.set(record.id, known?.deleted && !record.deleted ? known : record);
  }
  return [...merged.values()].sort((a, b) => a.answeredAt.localeCompare(b.answeredAt));
}

/**
 * `live` = 自己补读、听推送（本机任务）；否则就是调用方给的那份快照原样（远程任务、只读回放）。
 * 不给 `live` 时：没有快照才自己去读。
 */
export function useQuestionHistory(taskId: string, history?: QuestionRecord[], live = history === undefined): QuestionHistoryState {
  // 读到的、推来的记在这里，并且记着是哪个任务的：换了任务，上一个任务的那份一条都不能混进来。
  const [state, setState] = useState<{ taskId: string; records: QuestionRecord[]; error?: string }>({ taskId, records: NONE });
  const own = (current: { taskId: string; records: QuestionRecord[] }) => current.taskId === taskId ? current.records : NONE;
  // 连上过没有。连上过之后就不再走那条「没连上时延迟兜底读一次」的路 —— 断线期间读也读
  // 不到,而追平那一层会自己重试到读到。
  const connectedOnce = useRef(false);
  // 读取、重试、代次都交给追平层(lib/catchUp.ts):这个组件原先自己写了一套 generation +
  // connectedOnce + setTimeout,而读失败不重试、断线也不作废在途那一发(第 5 轮审查 N1 点到
  // 的五处写法之一)。`taskId` 作身份:它一变就是新一代次。
  const catchUp = useCatchUp((signal) => api.taskQuestionHistory(taskId, signal).then(
    (records) => {
      setState((current) => ({ taskId, records: mergeRecords(own(current), records) }));
      return true;
    },
    (error) => {
      // **主动取消不是读取失败**(本轮审查 N1)。断线作废这一代次、以及有人点「重试」把在途
      // 那一发接替掉(`runNow`),都会 abort 这一发 —— 它的 rejection 一路冒上来被写成「加载
      // 失败」,而那一刻压根没有任何读取失败,得等下一发成功才消掉。追平层的其它四个消费者
      // (useTasks / useTaskMonitors / useRejectionNotices / useAcceptGate)都接了这一道,
      // 问答历史漏接了同一个协议。
      //
      // 换代次的那一种一个字都不说:新代次会自己追平。等到点的那一种照实说 —— 它的 reason
      // 本身就是人话,而且追平层还会接着重试。
      if (catchUpAbortKind(signal, error) === "stale") return false;
      // 如实显示「这一份没读到」,同时让追平层接着重试 —— 两件事不冲突(上一版只做了前者)。
      setState((current) => ({ taskId, records: own(current), error: String(error?.message ?? error) }));
      return false;
    },
  ), live ? taskId : "");
  const connected = useServerEvents((event) => {
    const records = event.type === "task.question" && event.taskId === taskId && event.answeredQuestion
      ? [event.answeredQuestion]
      : event.type === "task.updated" && event.task.id === taskId ? event.task.questionHistory : undefined;
    // 推来了这个任务的记录就说明连得上、读得到，之前那句「没读到」随之作废。
    if (records) setState((current) => ({ taskId, records: mergeRecords(own(current), records) }));
  }, live);
  // 连上就对账、断线就作废(统一接线,见 lib/useCatchUp.ts)。
  useCatchUpLink(catchUp, connected);
  useEffect(() => {
    if (!live) return;
    if (connected) {
      connectedOnce.current = true;
      return;
    }
    if (connectedOnce.current) return;
    // 调用方快照可能早于最近一次答复;事件流还没连上时用一次轻量读取补齐。
    const timer = setTimeout(() => { void catchUp.run(); }, 1000);
    return () => clearTimeout(timer);
  }, [catchUp, connected, live]);
  const mine = state.taskId === taskId ? state : null;
  const fetched = mine?.records ?? NONE;
  const records = useMemo(
    () => live ? mergeRecords(fetched, history ?? NONE) : history ?? NONE,
    [live, fetched, history],
  );
  return { records, error: live ? mine?.error : undefined, retry: live ? catchUp.runNow : undefined };
}
