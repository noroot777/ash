import { useEffect, useRef, useState } from "react";
import type { AgentContentSegment } from "../task-detail/conversationModel.ts";
import { MessageAttachments } from "../task-detail/Attachments.tsx";
import { splitTurnSegments } from "../task-detail/turnFold.ts";
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
 * 过程折叠块。跑的时候默认摊开（不然用户盯着一行摘要不知道在干嘛），收工那一刻自动
 * 收起；用户自己动过折角就以他的选择为准，不再自动开合。
 */
function ProcessFold({ segments, running }: { segments: AgentContentSegment[]; running: boolean }) {
  const events = segments.flatMap((segment) => segment.events);
  const [open, setOpen] = useState(running);
  const touched = useRef(false);
  const wasRunning = useRef(running);

  useEffect(() => {
    if (wasRunning.current !== running && !touched.current) setOpen(running);
    wasRunning.current = running;
  }, [running]);

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
}: {
  segments: AgentContentSegment[];
  /** 这一回合还在飞。 */
  running: boolean;
}) {
  const { process, conclusion } = splitTurnSegments(segments);
  return (
    <>
      {!!process.length && <ProcessFold segments={process} running={running} />}
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
