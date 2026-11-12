import { CaretRight, File, Globe, Lightbulb, ListChecks, MagnifyingGlass, PencilSimple, Plug, Robot, TerminalWindow, WarningCircle, X } from "@phosphor-icons/react";
import { isVisibleExecutionEvent, type ExecutionEvent } from "../lib/executionTrace.ts";
import { describeEvent, isFlatStep, liveLabel, pastSummary, type StepView } from "../lib/executionWords.ts";
import { useSwapText } from "../lib/useSwapText.ts";

/* 执行过程:收着是一句话(在跑时「正在读 ReplyBox.tsx」,做完「读了 2 个文件，跑了 1 条命令」),
   点开一步一行(「读 ReplyBox.tsx」),每一行再点开是「字段 值」,原始参数再折一层。
   说法全在 lib/executionWords.ts 与 lib/toolPhrase.ts,这里只管画。 */

function StepIcon({ view }: { view: StepView }) {
  const props = { size: 13, "aria-hidden": true } as const;
  if (view.tone === "error" || view.failed) return <X {...props} />;
  // 提示跟系统旁注里那身琥珀同一个图形(SystemNotice 的 eventIcon):同一类语气,
  // 换个地方出现时不该换一副长相。
  if (view.tone === "notice") return <WarningCircle {...props} weight="fill" />;
  if (view.tone === "thinking") return <Lightbulb {...props} />;
  switch (view.kind) {
    case "read": return <File {...props} />;
    case "search": return <MagnifyingGlass {...props} />;
    case "edit":
    case "write": return <PencilSimple {...props} />;
    case "run": return <TerminalWindow {...props} />;
    case "web": return <Globe {...props} />;
    case "dispatch": return <Robot {...props} />;
    default: return view.verb === "记待办" ? <ListChecks {...props} /> : <Plug {...props} />;
  }
}

function StepHead({ view }: { view: StepView }) {
  return (
    <>
      <StepIcon view={view} />
      <span className="task-tool-verb">{view.verb}</span>
      {view.object && <span className={`task-tool-object${view.mono ? " is-mono" : ""}`}>{view.object}</span>}
      {view.tail && <span className="task-tool-tail">{view.tail}</span>}
    </>
  );
}

/** 一步。说得完的就是一行字;还有话的(字段、装不下的原文)做成能点开的。 */
function StepLine({ event }: { event: ExecutionEvent }) {
  const view = describeEvent(event);
  const className = `task-tool-line task-tool-line--${view.tone}${view.failed ? " is-failed" : ""}`;
  if (isFlatStep(view)) {
    return <div className={`${className} is-flat`}><span className="task-tool-head"><StepHead view={view} /></span></div>;
  }
  return (
    <details className={className}>
      <summary><StepHead view={view} /></summary>
      <div className="task-tool-more">
        {!!view.fields.length && (
          <dl className="task-tool-fields">
            {view.fields.map(([key, value], index) => (
              <div key={`${key}:${index}`}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {view.raw && (view.fields.length
          ? (
            <details className="task-tool-raw">
              <summary>原始参数</summary>
              <pre>{view.raw}</pre>
            </details>
          )
          // 思考、异常、长提示没有字段可拆:点开直接就是原文。
          : <pre>{view.raw}</pre>)}
      </div>
    </details>
  );
}

/** 折叠条做完以后的那句话(「读了 2 个文件，跑了 1 条命令」)。 */
export { pastSummary as executionSummaryText };

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

/**
 * `<summary>` 的内容:折角 + 那一句话。
 *
 * 在跑时这句话跟着最新的一步走(「正在读 ReplyBox.tsx」),每一句至少停一秒、来得快的只留
 * 最新的(useSwapText),字上扫一道光;做完原地换成过去式摘要。不会过几秒又退回成计数。
 *
 * `awaiting` = **此刻**正卡在上游等回话:那句提示常驻在这一行上(见 liveLabel)。它必须由
 * 调用方按自己那条路上的恢复信号算 —— 这里看不见正文,拿「最后一条事件是提示」当替代品
 * 就会在上游恢复后一直写着正在重试。缺省 false:算不出来时宁可按普通一步说。
 */
export function ExecutionSummaryLine(
  { events, running, awaiting = false }: { events: ExecutionEvent[]; running: boolean; awaiting?: boolean },
) {
  events = events.filter(isVisibleExecutionEvent);
  const text = running ? liveLabel(events, awaiting) : pastSummary(events);
  const { shown, phase } = useSwapText(text, { dwellMs: running ? 1000 : 0 });
  return (
    <>
      <CaretRight className="task-execution-caret" size={12} weight="bold" aria-hidden="true" />
      <span className={`task-execution-label swap${phase ? ` ${phase}` : ""}${running ? " shim" : ""}`}>{shown}</span>
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
        <StepLine event={event} key={`${event.kind}:${index}`} />
      ))}
    </div>
  );
}

export function ExecutionDetails(
  { events, running, awaiting = false }: { events: ExecutionEvent[]; running: boolean; awaiting?: boolean },
) {
  events = events.filter(isVisibleExecutionEvent);
  if (!events.length) return null;
  /* data-selection-chrome:选中一段会话时整块不算正文。折叠条本身是 `summary`,选文那边
     认语义就够;要标的是**展开之后那些事件行** —— 它们是一堆普通 div,语义上说不出
     「这不是用户要的那段话」,只能在这里声明(见 side-chat/selectionContent.ts)。 */
  return (
    <details className={`task-execution-block${executionBlockTone(events)}${running ? " is-live" : ""}`} data-selection-chrome="">
      <summary>
        <ExecutionSummaryLine events={events} running={running} awaiting={awaiting} />
      </summary>
      <ExecutionEventList events={events} />
    </details>
  );
}
