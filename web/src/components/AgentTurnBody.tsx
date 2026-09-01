import { useState } from "react";
import type { AgentContentSegment } from "../task-detail/conversationModel.ts";
import { MessageAttachments } from "../task-detail/Attachments.tsx";
import { turnLayout } from "../task-detail/turnFold.ts";
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
 * 过程折叠块。**只在这一回合收口之后才会被渲染**（见 turnLayout），所以它一上来就是
 * 折好的，之后再不自动动 —— 用户点开了就一直开着。
 */
function ProcessFold({ segments }: { segments: AgentContentSegment[] }) {
  const events = segments.flatMap((segment) => segment.events);
  const [open, setOpen] = useState(false);

  return (
    <details
      className={`task-execution-block task-turn-process${hasExecutionError(events) ? " has-error" : ""}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <ExecutionSummaryLine events={events} running={false} />
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
  /** 这一回合还在飞（会话行还没落 endedAt）。在飞就不折，见 turnLayout。 */
  running: boolean;
}) {
  // 跑的时候不折 —— 连「切成过程 / 结论」这一步都不做（见 turnLayout）。折叠是个重组
  // 动作：它会把已经说出口、已经露在外面的正文一并收进过程块，跑的中途干这件事，用户
  // 正读的内容说没就没。这一回合收口那一下才折，位置从此不再变。
  const { process, conclusion } = turnLayout(segments, { live: running });
  return (
    <>
      {!!process.length && <ProcessFold segments={process} />}
      {conclusion.map((segment, index) => (
        <section className="task-agent-segment" key={segment.id}>
          {/* 平铺那条路径（跑着的时候、以及折不出结论的回合）逐段折事件，跟原来一样。 */}
          <ExecutionDetails
            events={segment.events}
            running={running && index === conclusion.length - 1}
          />
          <SegmentBody segment={segment} />
        </section>
      ))}
    </>
  );
}
