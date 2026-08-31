import { useEffect, useRef, useState } from "react";
import type { AgentContentSegment } from "../task-detail/conversationModel.ts";
import { MessageAttachments } from "../task-detail/Attachments.tsx";
import { splitTurnSegments, nextProcessFoldOpen } from "../task-detail/turnFold.ts";
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
 * 过程折叠块。跑的时候默认摊开（不然用户盯着一行摘要不知道在干嘛），整个任务停下来
 * 的那一刻才自动收起 —— 判据见 nextProcessFoldOpen，跑的中途一律不折。
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
  const [open, setOpen] = useState(running);
  const touched = useRef(false);

  useEffect(() => {
    const next = nextProcessFoldOpen({ running, taskLive, touched: touched.current });
    if (next !== null) setOpen(next);
  }, [running, taskLive]);

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
   * 整条执行链路还没停：它为真时过程块绝不自动收起。判据归调用方 ——
   * 单飞看 taskAttention 的 isTaskLive（含 awaiting_review），团队看这一队收没收工
   * （调度台派完活自己就落回 idle，只读它那一行会把满负荷的团队判成静止）。
   */
  taskLive: boolean;
}) {
  const { process, conclusion } = splitTurnSegments(segments);
  return (
    <>
      {!!process.length && <ProcessFold segments={process} running={running} taskLive={taskLive} />}
      {conclusion.map((segment, index) => (
        <section className="task-agent-segment" key={segment.id}>
          {/* 不折的那条路径（无过程可折 / 折完没内容）仍按老样子逐段折事件。 */}
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
