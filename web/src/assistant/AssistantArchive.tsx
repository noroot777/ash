import { useEffect, useState } from "react";
import type { Session, Task } from "@ash/shared";
import { ArrowLeft } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import { MarkdownBody } from "../components/MarkdownBody.tsx";

export function AssistantArchive({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const [task, setTask] = useState<Task | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [output, setOutput] = useState("");
  const [error, setError] = useState("");
  const [loadingOutput, setLoadingOutput] = useState(false);
  useEffect(() => {
    let alive = true;
    Promise.all([api.task(taskId), api.sessions(taskId)]).then(([value, rows]) => {
      if (alive) { setTask(value); setSessions(rows); setSessionId(rows.at(-1)?.id ?? ""); }
    }).catch((reason) => { if (alive) setError(String(reason)); });
    return () => { alive = false; };
  }, [taskId]);
  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    setOutput(""); setLoadingOutput(true);
    api.sessionOutput(sessionId).then((value) => { if (alive) setOutput(value); }).catch((reason) => { if (alive) setError(String(reason)); }).finally(() => { if (alive) setLoadingOutput(false); });
    return () => { alive = false; };
  }, [sessionId]);
  return <section className="assistant-archive" aria-label="归档任务详情">
    <button type="button" onClick={onClose}><ArrowLeft size={16} />返回助手</button>
    <small>已归档 · 只读查看</small><h2>{task?.title ?? "正在读取任务…"}</h2>
    {error && <p role="alert" className="assistant-error">{error}</p>}
    {task && <><MarkdownBody text={task.body} /><h3>历史会话</h3>{sessions.length ? <>
      <label>查看回合<select value={sessionId} onChange={(event) => setSessionId(event.target.value)}>{sessions.map((session, index) => <option key={session.id} value={session.id}>回合 {index + 1} · {session.agentType}</option>)}</select></label>
      {loadingOutput ? <p role="status">正在读取会话…</p> : <MarkdownBody text={output || "这次会话没有文字输出。"} />}
    </> : <p>这个任务没有历史会话。</p>}</>}
  </section>;
}
