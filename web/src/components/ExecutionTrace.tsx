import { useEffect, useRef, useState } from "react";
import { CaretRight, Wrench, X } from "@phosphor-icons/react";
import { hasMoreThanSummary, traceSummary, type ExecutionEvent } from "../lib/executionTrace.ts";

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

export function ExecutionDetails({ events, running }: { events: ExecutionEvent[]; running: boolean }) {
  if (!events.length) return null;
  const thinking = events.filter((event) => event.kind === "thinking").length;
  const tools = events.filter((event) => event.kind === "tool").length;
  const errors = events.filter((event) => event.kind === "error").length;
  const counts = [
    thinking ? `${thinking} 分析` : "",
    tools ? `${tools} 工具` : "",
    errors ? `${errors} 异常` : "",
  ].filter(Boolean).join(" · ");
  const baseLabel = `执行过程${counts ? ` · ${counts}` : ""}`;

  return (
    <details className={`task-execution-block${errors ? " has-error" : ""}`}>
      <summary>
        <CaretRight className="task-execution-caret" size={11} weight="bold" aria-hidden="true" />
        {running && <span className="task-execution-pulse" aria-hidden="true" />}
        <TransientExecutionLabel baseLabel={baseLabel} events={events} running={running} />
      </summary>
      <div className="task-execution-events">
        {events.map((event, index) => (
          <EventLine event={event} key={`${event.kind}:${index}`} />
        ))}
      </div>
    </details>
  );
}
