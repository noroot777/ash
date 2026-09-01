import { useEffect, useRef, useState } from "react";
import type { AgentContentSegment } from "../task-detail/conversationModel.ts";
import { MessageAttachments } from "../task-detail/Attachments.tsx";
import { turnLayout, nextProcessFoldOpen } from "../task-detail/turnFold.ts";
import { MarkdownBody } from "./MarkdownBody.tsx";
import {
  ExecutionDetails,
  ExecutionEventList,
  ExecutionSummaryLine,
  hasExecutionError,
} from "./ExecutionTrace.tsx";

function SegmentBody({ segment }: { segment: AgentContentSegment }) {
  return (
    <>
      <MessageAttachments paths={segment.attachments} />
      {segment.markdown && <MarkdownBody text={segment.markdown} />}
    </>
  );
}

/**
 * 过程折叠块。**只在整条执行链路停下来之后才会被渲染**（见 turnLayout），所以它一上来
 * 就是折好的 —— 哪怕这一瞬当前气泡还挂着 running（终态 SSE 比 sessions 重拉先到）。
 * 这里的开合只管一件事：用户自己动过折角之后不再自动动它（判据见 nextProcessFoldOpen）。
 */
function ProcessFold({
  segments,
  running,
  taskLive,
}: {
  segments: AgentContentSegment[];
  running: boolean;
  /** 见 AgentTurnBody 的同名 prop。 */
  taskLive: boolean;
}) {
  const events = segments.flatMap((segment) => segment.events);
  const [open, setOpen] = useState(false);
  const touched = useRef(false);

  useEffect(() => {
    const next = nextProcessFoldOpen({ taskLive, touched: touched.current });
    if (next !== null) setOpen(next);
  }, [taskLive]);

  return (
    <details
      className={`task-execution-block task-turn-process${hasExecutionError(events) ? " has-error" : ""}`}
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        if (next !== open) touched.current = true;
        setOpen(next);
      }}
    >
      <summary>
        <ExecutionSummaryLine events={events} running={running} />
      </summary>
      <div className="task-turn-process-body">
        {segments.map((segment) => (
          <section className="task-agent-segment" key={segment.id}>
            <ExecutionEventList events={segment.events} />
            <SegmentBody segment={segment} />
          </section>
        ))}
      </div>
    </details>
  );
}

/**
 * 一条 agent 气泡的正文。普通任务与团队调度流共用；duet 的回合没有交错结构（就一份
 * events 加一份正文），继续直接用 ExecutionDetails。
 */
export function AgentTurnBody({
  segments,
  running,
  taskLive,
}: {
  segments: AgentContentSegment[];
  /** 这一回合还在飞。 */
  running: boolean;
  /**
   * 整条执行链路还没停：它为真时过程块绝不自动收起。判据归调用方，两个会话流用的都是
   * taskAttention 的 isExecutionChainLive —— 在跑、卡在审查门上、停在检查点等人答话、
   * 团队还没收工，都算没停。
   */
  taskLive: boolean;
}) {
  // 跑的时候不折 —— 连「切成过程 / 结论」这一步都不做（见 turnLayout）。折叠是个重组
  // 动作：它会把已经说出口、已经露在外面的正文一并收进过程块，跑的中途干这件事，用户
  // 正读的内容说没就没。链路停下来那一下才折，位置从此不再变。
  const { process, conclusion } = turnLayout(segments, { live: taskLive });
  return (
    <>
      {!!process.length && <ProcessFold segments={process} running={running} taskLive={taskLive} />}
      {conclusion.map((segment, index) => (
        <section className="task-agent-segment" key={segment.id}>
          {/* 平铺那条路径（跑着的时候、以及折不出结论的回合）逐段折事件，跟原来一样。 */}
          <ExecutionDetails
            events={segment.events}
            running={running && !process.length && index === conclusion.length - 1}
          />
          <SegmentBody segment={segment} />
        </section>
      ))}
    </>
  );
}
