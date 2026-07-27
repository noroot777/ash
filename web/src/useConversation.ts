// 「一个任务的会话」这份数据的装配钩子:拉 sessions、在没有实时日志时快照历史输出
// (.md)、把两者 + SSE 流拼成条目流。
//
// 单独一个文件是因为 TaskDetail 和 /team 的调度台都要它,而 Conversation.tsx 刻意
// 保持「不碰 api」的纯展示层。两处共用同一份装配,刷新/实时的一致性就不会在某一个
// 界面上偷偷漂掉。
import { useEffect, useMemo, useState } from "react";
import type { Task, Session, AgentType } from "@harness/shared";
import { api } from "./api";
import { buildConversation, type ConvItem, type LogLine } from "./Conversation";

export function useConversation({
  task,
  logs,
  sessionsBump,
  primaryAgent,
}: {
  task: Task;
  logs: LogLine[];
  sessionsBump: number;
  primaryAgent: AgentType;
}): { items: ConvItem[]; sessions: Session[]; snapshot: { s: Session; out: string }[] } {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [snapshot, setSnapshot] = useState<{ s: Session; out: string }[]>([]);

  useEffect(() => {
    api.sessions(task.id).then(setSessions);
  }, [task.id, sessionsBump]);

  // Snapshot of prior output, taken once per task when there are no in-memory
  // live logs (i.e. a reload / fresh navigation). Per session, so each run
  // becomes its own bubble carrying its own resume credential. Sticky: a later
  // reply (which fills logs) must not wipe it, so prior context stays above the
  // new turns.
  useEffect(() => {
    setSnapshot([]);
    if (logs.length > 0) return;
    let alive = true;
    api.sessions(task.id).then(async (ss) => {
      const withOut = await Promise.all(
        ss.map(async (s) => ({ s, out: await api.sessionOutput(s.id).catch(() => "") })),
      );
      if (alive) setSnapshot(withOut.filter(({ out }) => out.trim()));
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  // The conversation, assembled once here so a header's copy/export and the body
  // bubbles share exactly one source of truth.
  const items = useMemo(
    () => buildConversation({ task, snapshot, logs, sessions, primaryAgent }),
    [task, snapshot, logs, sessions, primaryAgent],
  );

  return { items, sessions, snapshot };
}
