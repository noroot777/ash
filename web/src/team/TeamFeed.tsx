// /team 中间那条流:调度者的回合(气泡跟单任务一模一样)+ 派活卡 + 入站气泡。
//
// 三种东西的来源各不相同:
// - 调度者回合 / 用户插话 / 系统提示 → 会话条目(ConvItem),跟单任务同一套渲染。
// - 入站气泡(执行者提问/失败/汇报)→ 其实就是 system 条目,认出模板前缀后换个长相画。
// - 派活卡 → 会话里没有留痕(dispatch 是个 MCP 工具调用),由执行者反推出来按时刻插进流里。
import type { Task } from "@harness/shared";
import { ArrowElbowDownRight, ArrowRight } from "@phosphor-icons/react";
import { ConvBubble } from "../Conversation";
import { StatusIcon } from "../StatusIcon";
import { CollapsibleText } from "../ui";
import { formatInstant } from "../time";
import { WorkerStatusText } from "./WorkerRail";
import { parseInbound, type Batch, type FeedRow, type Inbound } from "./teamData";
import { executorLabel } from "../executorLabel";

export function TeamFeed({
  rows,
  workers,
  empty,
  onOpenWorker,
}: {
  rows: FeedRow[];
  workers: Task[];
  empty: boolean;
  onOpenWorker: (id: string) => void;
}) {
  const byId = new Map(workers.map((w) => [w.id, w]));
  const indexOf = (id?: string) => (id ? workers.findIndex((w) => w.id === id) + 1 : 0);
  return (
    <div className="min-h-0 overflow-y-auto border-r border-line px-4 py-4">
      {empty && (
        <p className="text-[13px] text-faint">
          点「运行」让调度者开工:它会先读需求、拆活,再用 <span className="font-mono">dispatch</span> 把活派给执行者。
        </p>
      )}
      {rows.map((row) => {
        if (row.kind === "batch")
          return <BatchCard key={row.key} batch={row.batch} workers={workers} onOpenWorker={onOpenWorker} />;
        const it = row.item;
        const inbound = it.kind === "system" ? parseInbound(it.text) : null;
        if (inbound)
          return (
            <div key={row.key}>
              {inbound.map((m, i) => (
                <InboundBubble
                  key={i}
                  m={m}
                  n={indexOf(m.taskId)}
                  worker={m.taskId ? byId.get(m.taskId) : undefined}
                  at={it.kind === "system" ? it.at : undefined}
                  onOpen={onOpenWorker}
                />
              ))}
            </div>
          );
        return <ConvBubble key={row.key} item={it} />;
      })}
    </div>
  );
}

// 一次 dispatch 一张卡。点任一行 → 右侧滑出那个执行者的完整会话。
function BatchCard({
  batch,
  workers,
  onOpenWorker,
}: {
  batch: Batch;
  workers: Task[];
  onOpenWorker: (id: string) => void;
}) {
  return (
    <div className="mb-3.5 overflow-hidden rounded-lg border border-line">
      <div className="flex items-center gap-2 bg-raised px-2.5 py-1.5 text-[11.5px] text-muted">
        <ArrowElbowDownRight size={12} />
        <b className="text-[12px] font-semibold text-ink">派活 · {batch.workers.length} 个执行者</b>
        <span className="rounded bg-panel px-1.5 py-px text-[10.5px]">{batch.serial ? "串行" : "并行"}</span>
        {batch.group?.paused && (
          <span className="rounded border border-line bg-panel px-1.5 py-px text-[10.5px] font-medium text-muted">
            组已停止
          </span>
        )}
        <span className="ml-auto font-mono text-[10.5px] text-faint">{formatInstant(batch.at)}</span>
      </div>
      {batch.workers.map((w) => (
        <BatchWorkerRow
          key={w.id}
          w={w}
          n={workers.findIndex((x) => x.id === w.id) + 1}
          groupPaused={!!batch.group?.paused}
          onOpen={() => onOpenWorker(w.id)}
        />
      ))}
      <div className="border-t border-line bg-panel px-2.5 py-1.5 text-[11px] text-faint">
        {batch.group?.paused ? batchSummary(batch.workers) : "点任一行 → 右侧滑出它的完整会话;也能单独重跑 / 换执行器"}
      </div>
    </div>
  );
}

function BatchWorkerRow({
  w,
  n,
  groupPaused,
  onOpen,
}: {
  w: Task;
  n: number;
  groupPaused: boolean;
  onOpen: () => void;
}) {
  const label = executorLabel({ task: w });
  return (
    <button
      onClick={onOpen}
      className="flex w-full items-center gap-2 border-t border-line px-2.5 py-2 text-left transition-colors hover:bg-canvas"
    >
      <StatusIcon status={w.status} size={12} awaitingAnswer={!!w.question} />
      <span className="w-3.5 shrink-0 font-mono text-[10.5px] text-faint">{n}</span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">{w.title}</span>
      <span
        className="max-w-[112px] shrink truncate rounded border border-line px-1 font-mono text-[10px] text-muted"
        title={label}
      >
        {label}
      </span>
      <span className="shrink-0 text-[11px] text-faint">
        <WorkerStatusText w={w} groupPaused={groupPaused} />
      </span>
    </button>
  );
}

function batchSummary(workers: Task[]): string {
  const interrupted = workers.filter((w) => w.status === "paused" && !w.question).length;
  const done = workers.filter((w) => w.status === "done").length;
  if (interrupted > 0) return `本批组已停止 · ${interrupted} 个执行者被暂停打断，${done} 个已完成`;
  if (done > 0) return `本批组已停止 · ${done} 个执行者已正常完成，没有被暂停打断`;
  return "本批组已停止 · 暂无执行者被暂停打断";
}

const KIND_LABEL: Record<Inbound["kind"], string> = {
  question: "提问，卡住了",
  failed: "失败了",
  done: "汇报完成",
  note: "",
};

// 执行者 → 调度者的一条入站消息。「提问」用青色(全表最扎眼那格,因为不动手就永远停
// 在这)、「失败」用红、「汇报完成」朴素。提问的正文优先取执行者身上还挂着的 question
// (最准),答复后它被清空,就退回模板里解析出来的那段。
function InboundBubble({
  m,
  n,
  worker,
  at,
  onOpen,
}: {
  m: Inbound;
  n: number;
  worker?: Task;
  at?: string;
  onOpen: (id: string) => void;
}) {
  const tone =
    m.kind === "question"
      ? "border-l-cyan-500 bg-gradient-to-r from-cyan-500/[0.07] to-transparent"
      : m.kind === "failed"
        ? "border-l-red-500 bg-gradient-to-r from-red-500/[0.06] to-transparent"
        : "border-l-line2";
  const label = KIND_LABEL[m.kind];
  const body = (m.kind === "question" && worker?.question) || m.body;
  return (
    <div className={`mb-3.5 rounded-r-lg border-l-2 py-1.5 pl-3 pr-2 ${tone}`} title={m.raw}>
      <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-muted">
        <span className="grid h-[19px] w-[19px] shrink-0 place-items-center rounded-[5px] bg-slate-400 text-[10px] font-bold text-white">
          {n || "工"}
        </span>
        {m.taskId && worker ? (
          <button onClick={() => onOpen(m.taskId!)} className="font-semibold text-ink hover:text-accent">
            {m.title}
          </button>
        ) : (
          <b className="font-semibold text-ink">{m.title ?? "系统"}</b>
        )}
        {label && (
          <span className={`text-[10.5px] font-semibold ${m.kind === "question" ? "text-cyan-700" : m.kind === "failed" ? "text-red-600" : "text-faint"}`}>
            · {label}
          </span>
        )}
        <ArrowRight size={10} className="text-faint" />
        <span className="text-[10.5px] text-faint">调度者</span>
        {at && <span className="ml-auto font-mono text-[10.5px] text-faint">{formatInstant(at)}</span>}
      </div>
      <CollapsibleText text={body} />
      {m.kind === "question" && worker?.question && (
        <button
          onClick={() => onOpen(worker.id)}
          className="mt-1.5 rounded-md bg-cyan-600 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-cyan-500"
        >
          我来答
        </button>
      )}
    </div>
  );
}
