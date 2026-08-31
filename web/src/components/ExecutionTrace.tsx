import { useEffect, useRef, useState } from "react";
import { CaretRight, Wrench, X } from "@phosphor-icons/react";
import { hasMoreThanSummary, traceSummary, type ExecutionEvent } from "../lib/executionTrace.ts";
import { nextProcessFoldOpen } from "../task-detail/turnFold.ts";

function compact(text: string, limit = 52): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function eventPreview(event: ExecutionEvent): string {
  const summary = traceSummary(event);
  if (event.kind === "error") return compact(`异常 · ${event.label}`);
  if (event.kind === "thinking") return compact(`分析 · ${summary || event.label}`);
  return compact(`${event.label}${summary ? ` · ${summary}` : ""}`);
}

function textSwapDuration(): number {
  if (typeof document === "undefined") return 150;
  return parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--text-swap-dur"),
  ) || 150;
}

function TransientExecutionLabel({
  baseLabel,
  events,
  running,
}: {
  baseLabel: string;
  events: ExecutionEvent[];
  running: boolean;
}) {
  const label = useRef<HTMLSpanElement>(null);
  const previousCount = useRef(running ? 0 : events.length);
  const [display, setDisplay] = useState(baseLabel);
  const [phase, setPhase] = useState("");
  const latestPreview = events.length ? eventPreview(events.at(-1)!) : "";

  useEffect(() => {
    if (!running) {
      previousCount.current = events.length;
      setDisplay(baseLabel);
      setPhase("");
      return;
    }
    if (events.length <= previousCount.current) return;
    previousCount.current = events.length;
    if (!latestPreview) return;

    const timers: number[] = [];
    const frames: number[] = [];
    const swapText = (next: string, settled?: () => void) => {
      setPhase("is-exit");
      timers.push(window.setTimeout(() => {
        setDisplay(next);
        setPhase("is-enter-start");
        frames.push(window.requestAnimationFrame(() => {
          if (label.current) void label.current.offsetHeight;
          setPhase("");
          settled?.();
        }));
      }, textSwapDuration()));
    };
    swapText(latestPreview, () => {
      timers.push(window.setTimeout(() => swapText(baseLabel), 3_600));
    });
    return () => {
      timers.forEach(window.clearTimeout);
      frames.forEach(window.cancelAnimationFrame);
    };
  }, [baseLabel, events.length, latestPreview, running]);

  return (
    <span
      className={`task-execution-label t-text-swap ${phase}${running ? " t-shimmer" : ""}`}
      data-text={running ? display : undefined}
      aria-label={running ? display : undefined}
      ref={label}
    >
      {display}
    </span>
  );
}

function EventIcon({ kind }: { kind: ExecutionEvent["kind"] }) {
  if (kind === "tool") return <Wrench size={12} aria-hidden="true" />;
  if (kind === "error") return <X size={12} aria-hidden="true" />;
  return <span aria-hidden="true">◌</span>;
}

/**
 * 一行执行事件:图标 + 工具名 + **当场就能看见的命令/文件**(traceSummary)。
 * 完整 detail 仍可点开;摘要已把话说尽时就不做成可展开的(点开只是同一句)。
 */
function EventLine({ event }: { event: ExecutionEvent }) {
  const summary = traceSummary(event);
  const body = (
    <>
      <EventIcon kind={event.kind} />
      <span className="task-tool-name">{event.label}</span>
      {summary && <span className="task-tool-summary">{summary}</span>}
    </>
  );
  const className = `task-tool-line task-tool-line--${event.kind}`;
  if (!hasMoreThanSummary(event, summary)) {
    return <div className={`${className} is-flat`}><span className="task-tool-head">{body}</span></div>;
  }
  return (
    <details className={className}>
      <summary>{body}</summary>
      <pre>{event.detail}</pre>
    </details>
  );
}

/** 折叠条上那句「执行过程 · 3 分析 · 5 工具」。回合级折叠和单段折叠共用同一套词。 */
export function executionCountsLabel(events: ExecutionEvent[]): string {
  const thinking = events.filter((event) => event.kind === "thinking").length;
  const tools = events.filter((event) => event.kind === "tool").length;
  const errors = events.filter((event) => event.kind === "error").length;
  const counts = [
    thinking ? `${thinking} 分析` : "",
    tools ? `${tools} 工具` : "",
    errors ? `${errors} 异常` : "",
  ].filter(Boolean).join(" · ");
  return `执行过程${counts ? ` · ${counts}` : ""}`;
}

export function hasExecutionError(events: ExecutionEvent[]): boolean {
  return events.some((event) => event.kind === "error");
}

/** `<summary>` 的内容：折角 + 运行小点 + 会临时轮播最新一步的标签。 */
export function ExecutionSummaryLine({ events, running }: { events: ExecutionEvent[]; running: boolean }) {
  return (
    <>
      <CaretRight className="task-execution-caret" size={11} weight="bold" aria-hidden="true" />
      {running && <span className="task-execution-pulse" aria-hidden="true" />}
      <TransientExecutionLabel baseLabel={executionCountsLabel(events)} events={events} running={running} />
    </>
  );
}

/** 光秃秃的事件行列表。外面已经有折叠壳时用它，别再套一层 `<details>`。 */
export function ExecutionEventList({ events }: { events: ExecutionEvent[] }) {
  if (!events.length) return null;
  return (
    <div className="task-execution-events">
      {events.map((event, index) => (
        <EventLine event={event} key={`${event.kind}:${index}`} />
      ))}
    </div>
  );
}

/**
 * 折叠块的自动开合，回合级折叠（ProcessFold）和单段折叠共用这一份：跑的时候摊开，
 * 整条链路停下来才收起，用户动过折角之后一律不再自动动它。判据本体在
 * turnFold 的 nextProcessFoldOpen（那儿有测试钉着）。
 *
 * 两种形状都得挂上它。一条回合在跑的过程中会**来回换形状** —— 最后一步是工具调用、
 * 后面还没吐字时 splitTurnSegments 折不出结论，于是退回逐段折（ExecutionDetails）；
 * 等它再说话又变回 ProcessFold。只给其中一种做自动摊开，用户看到的就是执行过程
 * 在跑的中途一收一放。
 */
export function useAutoFold(live: boolean, taskLive: boolean) {
  const [open, setOpen] = useState(live);
  const touched = useRef(false);

  useEffect(() => {
    const next = nextProcessFoldOpen({ running: live, taskLive, touched: touched.current });
    if (next !== null) setOpen(next);
  }, [live, taskLive]);

  return {
    open,
    onToggle: (event: { currentTarget: HTMLDetailsElement }) => {
      const next = event.currentTarget.open;
      if (next !== open) touched.current = true;
      setOpen(next);
    },
  };
}

export function ExecutionDetails({
  events,
  running,
  live = running,
  taskLive,
}: {
  events: ExecutionEvent[];
  /** 这一段是不是「此刻正在跑的那一步」：只管摘要条上的小圆点和微光。 */
  running: boolean;
  /** 这一回合还在飞。缺省跟着 running —— 只有一段的形状（duet）两者本来就是一回事。 */
  live?: boolean;
  /** 整条执行链路还没停（见 AgentTurnBody 的同名 prop）。 */
  taskLive: boolean;
}) {
  const fold = useAutoFold(live, taskLive);
  if (!events.length) return null;
  return (
    <details
      className={`task-execution-block${hasExecutionError(events) ? " has-error" : ""}`}
      open={fold.open}
      onToggle={fold.onToggle}
    >
      <summary>
        <ExecutionSummaryLine events={events} running={running} />
      </summary>
      <ExecutionEventList events={events} />
    </details>
  );
}
