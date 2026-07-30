import { useRef } from "react";
import type { Task } from "@harness/shared";
import type { Batch } from "@harness/shared/team";
import { ArrowElbowDownRight, ArrowRight, Wrench } from "@phosphor-icons/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useStickToBottom } from "../lib/useStickToBottom.ts";
import { MessageAttachments } from "../task-detail/Attachments.tsx";
import { formatInstant, parseAttachmentText } from "../task-detail/utils.ts";
import { executorLabel, parseInbound, statusTone, workerStatusText, type InboundMessage, type TeamFeedRow } from "./teamModel.ts";

function AgentRow({ row }: { row: Extract<TeamFeedRow, { kind: "conv" }>["item"] }) {
  if (row.kind !== "agent") return null;
  return (
    <article className="team-feed-agent">
      <header><b>{row.label}</b>{row.at && <time>{formatInstant(row.at)}</time>}</header>
      {row.markdown && <ReactMarkdown remarkPlugins={[remarkGfm]}>{row.markdown}</ReactMarkdown>}
      {row.events.map((event, index) => (
        <details key={`${event.kind}-${index}`} className={`team-feed-tool is-${event.kind}`}>
          <summary><Wrench size={11} />{event.label}</summary>
          {event.detail && <pre>{event.detail}</pre>}
        </details>
      ))}
    </article>
  );
}

function UserRow({ row }: { row: Extract<TeamFeedRow, { kind: "conv" }>["item"] }) {
  if (row.kind !== "user") return null;
  const parsed = parseAttachmentText(row.text);
  const paths = [...parsed.paths, ...row.attachments];
  return (
    <article className="team-feed-user">
      <div>
        <header><b>你</b>{row.at && <time>{formatInstant(row.at)}</time>}</header>
        {parsed.body && <p>{parsed.body}</p>}
        <MessageAttachments paths={paths} onPreview={() => undefined} />
      </div>
    </article>
  );
}

function InboundRow({
  message,
  worker,
  number,
  at,
  onOpenWorker,
}: {
  message: InboundMessage;
  worker?: Task;
  number: number;
  at?: string;
  onOpenWorker: (taskId: string) => void;
}) {
  const body = message.kind === "question" && worker?.question ? worker.question : message.body;
  return (
    <article className={`team-feed-inbound is-${message.kind}`} title={message.raw}>
      <header>
        <span>{number || "工"}</span>
        {worker ? <button type="button" onClick={() => onOpenWorker(worker.id)}>{worker.title}</button> : <b>{message.title || "系统"}</b>}
        {message.kind !== "note" && <em>· {message.kind === "question" ? "提问，卡住了" : message.kind === "failed" ? "失败了" : "汇报完成"}</em>}
        <ArrowRight size={10} />
        <small>调度者</small>
        {at && <time>{formatInstant(at)}</time>}
      </header>
      <p>{body}</p>
      {message.kind === "question" && worker?.question && (
        <button className="team-feed-answer" type="button" onClick={() => onOpenWorker(worker.id)}>我来答</button>
      )}
    </article>
  );
}

function BatchCard({ batch, allWorkers, onOpenWorker }: { batch: Batch; allWorkers: Task[]; onOpenWorker: (taskId: string) => void }) {
  return (
    <article className="team-dispatch-card">
      <header>
        <ArrowElbowDownRight size={12} />
        <b>派活 · {batch.workers.length} 个执行者</b>
        <span>{batch.serial ? "串行" : "并行"}</span>
        {batch.group?.paused && <span>组已停止</span>}
        <time>{formatInstant(batch.at)}</time>
      </header>
      {batch.workers.map((worker) => (
        <button type="button" key={worker.id} onClick={() => onOpenWorker(worker.id)}>
          <i className={`team-status-dot team-status-dot--${statusTone(worker)}`} />
          <span className="team-dispatch-index">{allWorkers.findIndex((item) => item.id === worker.id) + 1}</span>
          <b>{worker.title}</b>
          <code title={executorLabel(worker)}>{executorLabel(worker)}</code>
          <small>{workerStatusText(worker, !!batch.group?.paused)}</small>
        </button>
      ))}
      <footer>{batch.group?.paused ? "本批执行已停止，已完成结果仍保留" : "点任一行查看完整会话与运行状态"}</footer>
    </article>
  );
}

export function TeamFeed({
  taskId,
  rows,
  workers,
  onOpenWorker,
}: {
  taskId: string;
  rows: TeamFeedRow[];
  workers: Task[];
  onOpenWorker: (taskId: string) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  useStickToBottom(scroll, taskId);
  const byId = new Map(workers.map((worker) => [worker.id, worker]));
  return (
    <section className="team-feed" aria-label="团队调度流" ref={scroll}>
      {!rows.length && <p className="team-feed-empty">运行后，调度者的拆解、派活、执行者提问与汇报会按发生顺序出现在这里。</p>}
      {rows.map((row) => {
        if (row.kind === "batch") return <BatchCard key={row.key} batch={row.batch} allWorkers={workers} onOpenWorker={onOpenWorker} />;
        const item = row.item;
        if (item.kind === "agent") return <AgentRow key={row.key} row={item} />;
        if (item.kind === "user") return <UserRow key={row.key} row={item} />;
        const inbound = parseInbound(item.text);
        if (inbound) {
          return (
            <div key={row.key}>
              {inbound.map((message, index) => {
                const worker = message.taskId ? byId.get(message.taskId) : undefined;
                return <InboundRow key={index} message={message} worker={worker} number={worker ? workers.indexOf(worker) + 1 : 0} at={item.at} onOpenWorker={onOpenWorker} />;
              })}
            </div>
          );
        }
        return <div className={`team-feed-event${item.tone === "error" ? " is-error" : ""}`} key={row.key}><span />{item.text}<span /></div>;
      })}
    </section>
  );
}
