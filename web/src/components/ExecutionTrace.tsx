import { useEffect, useRef, useState } from "react";
import { CaretRight, WarningCircle, Wrench, X } from "@phosphor-icons/react";
import { hasMoreThanSummary, isVisibleExecutionEvent, traceSummary, type ExecutionEvent } from "../lib/executionTrace.ts";

function compact(text: string, limit = 52): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function eventPreview(event: ExecutionEvent): string {
  const summary = traceSummary(event);
  if (event.kind === "error") return compact(`异常 · ${event.label}`);
  if (event.kind === "thinking") return compact(`分析 · ${summary || event.label}`);
  // 提示那一支走默认分支:它的 label 本来就是「提示」,正文在 detail 里(见 auxEvent)。
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
  const latest = events.at(-1);
  const latestPreview = latest ? eventPreview(latest) : "";
  /* 提示是**状态**不是步骤:「上游返回 502,正在重试」说的是此刻正卡在哪儿,而不是刚做完
     一件事。所以它不走 3.6 秒就退回计数的轮播 —— 退回去之后,一次十分钟的上游停摆在界面
     上又变回「智能体委派中」杵在那,正是 2026-09-24 那次要治的病(两个任务各停 47 分钟,
     用户手上一条线索都没有)。下一条真事件到了它自然被顶掉,所以不会赖着不走。 */
  const sticky = running && latest?.kind === "notice";

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
      if (sticky) return;
      timers.push(window.setTimeout(() => swapText(baseLabel), 3_600));
    });
    return () => {
      timers.forEach(window.clearTimeout);
      frames.forEach(window.cancelAnimationFrame);
    };
  }, [baseLabel, events.length, latestPreview, running, sticky]);

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
  // 提示跟系统旁注里那身琥珀同一个图形(SystemNotice 的 eventIcon):同一类语气,
  // 换个地方出现时不该换一副长相。
  if (kind === "notice") return <WarningCircle size={11} weight="fill" aria-hidden="true" />;
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
  events = events.filter(isVisibleExecutionEvent);
  const thinking = events.filter((event) => event.kind === "thinking").length;
  const tools = events.filter((event) => event.kind === "tool").length;
  const notices = events.filter((event) => event.kind === "notice").length;
  const errors = events.filter((event) => event.kind === "error").length;
  const counts = [
    thinking ? `${thinking} 分析` : "",
    tools ? `${tools} 工具` : "",
    // 提示单独计数而不是并进异常:折起来时也得看得出「这一轮里上游闹过脾气」,
    // 但它跟「出了岔子」不是一回事,混在一起数等于把一次健康回合报成有异常。
    notices ? `${notices} 提示` : "",
    errors ? `${errors} 异常` : "",
  ].filter(Boolean).join(" · ");
  return `执行过程${counts ? ` · ${counts}` : ""}`;
}

export function hasExecutionError(events: ExecutionEvent[]): boolean {
  return events.some((event) => event.kind === "error");
}

/** 这一串里有没有过程提示(上游重试之类)。折叠条据此上一层琥珀,但**不是**报错。 */
export function hasExecutionNotice(events: ExecutionEvent[]): boolean {
  return events.some((event) => event.kind === "notice");
}

/** 折叠块外壳的类名:异常压过提示 —— 真出事了就别让琥珀把红色顶掉。 */
export function executionBlockTone(events: ExecutionEvent[]): string {
  if (hasExecutionError(events)) return " has-error";
  return hasExecutionNotice(events) ? " has-notice" : "";
}

/** `<summary>` 的内容：折角 + 运行小点 + 会临时轮播最新一步的标签。 */
export function ExecutionSummaryLine({ events, running }: { events: ExecutionEvent[]; running: boolean }) {
  events = events.filter(isVisibleExecutionEvent);
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
  events = events.filter(isVisibleExecutionEvent);
  if (!events.length) return null;
  return (
    <div className="task-execution-events">
      {events.map((event, index) => (
        <EventLine event={event} key={`${event.kind}:${index}`} />
      ))}
    </div>
  );
}

export function ExecutionDetails({ events, running }: { events: ExecutionEvent[]; running: boolean }) {
  events = events.filter(isVisibleExecutionEvent);
  if (!events.length) return null;
  return (
    <details className={`task-execution-block${executionBlockTone(events)}`}>
      <summary>
        <ExecutionSummaryLine events={events} running={running} />
      </summary>
      <ExecutionEventList events={events} />
    </details>
  );
}
