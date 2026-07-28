// /team 右侧常驻执行者栏:永远知道谁在干、谁卡住了。点一张卡 → 右侧滑出它自己的
// 会话抽屉(TeamView 里的 WorkerDrawer),不跳页、不丢调度者上下文。
//
// 卡片上的「实时最后一行」只有在本次会话里收到过 SSE 的执行者才有(刷新后 logs 是空
// 的),所以它是锦上添花,不承载必要信息 —— 必要信息在状态行里。
import { useEffect } from "react";
import { taskDisplayStatus, type Group, type Task } from "@harness/shared";
import { StatusIcon } from "../StatusIcon";
import { Duration } from "../time";
import type { LogLine } from "../Conversation";
import { executorLabel } from "../executorLabel";
import { isSharedTeamWorker, sharedWorkerDisplayStage, sharedWorkerStageLabel } from "../taskPolicy";

export function WorkerRail({
  lead,
  workers,
  groups,
  logs,
  selected,
  onSelect,
}: {
  lead: Task;
  workers: Task[];
  groups: Group[];
  logs: Record<string, LogLine[]>;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const groupById = new Map(groups.map((g) => [g.id, g]));
  // 1–9 直接点开第 N 个执行者。用裸数字而不是 ⌘1–9:浏览器把 ⌘+数字占去切标签了,
  // 承诺一个按不出来的快捷键不如给个真能用的。App 的全局键位没有数字键,不冲突。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > 9) return;
      const w = workers[n - 1];
      if (!w) return;
      e.preventDefault();
      onSelect(w.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [workers, onSelect]);

  return (
    <aside className="min-h-0 overflow-y-auto bg-canvas px-3 py-3.5">
      <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-[0.06em] text-faint">
        <span>执行者（{workers.length}）</span>
        {workers.length > 0 && <span className="normal-case tracking-normal">按 1–9</span>}
      </div>
      {workers.length === 0 && (
        <p className="text-[11.5px] leading-relaxed text-faint">
          调度者还没派活。它会自己拆活、调 <span className="font-mono">dispatch</span> 派出去,派出来的执行者在这里排着。
        </p>
      )}
      {workers.map((w, i) => (
        <WorkerCard
          key={w.id}
          w={w}
          n={i + 1}
          groupPaused={!!(w.groupId && groupById.get(w.groupId)?.paused)}
          live={lastLine(logs[w.id])}
          selected={selected === w.id}
          onSelect={() => onSelect(w.id)}
          sharedWorker={isSharedTeamWorker(w, lead)}
        />
      ))}
      {workers.length > 0 && (
        <p className="mt-2.5 px-0.5 text-[11px] leading-relaxed text-faint">
          执行者能单独重跑、答复和查看完整会话；元信息仍由调度者统一管理。
        </p>
      )}
    </aside>
  );
}

function WorkerCard({
  w,
  n,
  groupPaused,
  live,
  selected,
  onSelect,
  sharedWorker,
}: {
  w: Task;
  n: number;
  groupPaused: boolean;
  live: string | null;
  selected: boolean;
  onSelect: () => void;
  sharedWorker: boolean;
}) {
  const asking = !!w.question;
  const label = executorLabel({ task: w });
  const displayStage = sharedWorker ? sharedWorkerDisplayStage(w.stage) : w.stage;
  return (
    <button
      onClick={onSelect}
      data-worker-id={w.id}
      className={`mb-1.5 block w-full rounded-lg border bg-panel px-2.5 py-2 text-left shadow-[0_1px_1px_rgba(0,0,0,.03)] transition-colors ${
        selected
          ? "border-accent ring-[3px] ring-accent/15"
          : asking
            ? "border-cyan-500/40 bg-cyan-500/[0.05] hover:border-cyan-500/60"
            : "border-transparent hover:border-line2"
      }`}
    >
      <div className="flex items-center gap-1.5">
        <StatusIcon status={w.status} stage={displayStage} awaitingAnswer={asking} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{w.title}</span>
        <span
          className="max-w-[92px] shrink truncate rounded border border-line px-1 font-mono text-[10px] text-muted"
          title={label}
        >
          {label}
        </span>
        <span className="w-3 shrink-0 text-center font-mono text-[10px] text-faint">{n <= 9 ? n : ""}</span>
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-[11px] text-faint">
        <WorkerStatusText w={w} groupPaused={groupPaused} sharedWorker={sharedWorker} />
      </div>
      {live && <div className="mt-1 truncate text-[11px] text-muted">{live}</div>}
    </button>
  );
}

// 一行状态说明:等答复(青,带等待时长)/ 运行中(实时跳)/ 排队第几位 / 完成用时…
export function WorkerStatusText({
  w,
  groupPaused = false,
  sharedWorker = false,
}: {
  w: Task;
  groupPaused?: boolean;
  sharedWorker?: boolean;
}) {
  if (w.question)
    return (
      <span className="text-cyan-700">
        等答复 <Duration from={w.endedAt ?? w.startedAt} />
      </span>
    );
  const displayStage = sharedWorker ? sharedWorkerDisplayStage(w.stage) : w.stage;
  const display = taskDisplayStatus(w.status, displayStage, false);
  const displayLabel = sharedWorker ? sharedWorkerStageLabel(w.stage) ?? display.label : display.label;
  if (displayStage && w.status !== "failed" && w.status !== "canceled") {
    return (
      <span className={displayStage === "verify_failed" ? "text-red-600" : undefined}>
        {displayLabel}
        {w.status === "running" && <> · <Duration from={w.startedAt} /></>}
        {groupPaused && " · 所属组已停止"}
      </span>
    );
  }
  switch (w.status) {
    case "running":
      return (
        <span>
          运行中 · <Duration from={w.startedAt} />
          {groupPaused && " · 所属组已停止"}
        </span>
      );
    case "queued":
    case "backlog":
      return <span>{groupPaused ? "未启动 · 所属组已停止" : w.queuePosition != null ? `排队 · 第 ${w.queuePosition + 1} 位` : "待派"}</span>;
    case "paused":
      return <span>{groupPaused ? "已暂停 · 被停止全组打断" : `已暂停${w.resumePrompt ? " · 到检查点" : ""}`}</span>;
    case "awaiting_review":
      return <span>待审查</span>;
    case "done":
      return (
        <span>
          完成 · <Duration from={w.startedAt} to={w.endedAt} />
          {groupPaused && " · 所属组已停止"}
        </span>
      );
    case "failed":
      return <span className="text-red-600">失败</span>;
    case "canceled":
      return <span>已取消</span>;
    case "idle":
      return <span>待命</span>;
  }
}

// 执行者最近吐的一行:优先正文尾部,否则最近一次工具调用。
function lastLine(lines?: LogLine[]): string | null {
  if (!lines?.length) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (l.kind === "text" && l.text.trim()) return l.text.trim().split("\n").filter(Boolean).pop() ?? null;
    if (l.kind === "tool") return `⚙ ${l.name ?? "tool"}`;
    if (l.kind === "error") return `✕ ${l.text}`;
  }
  return null;
}
