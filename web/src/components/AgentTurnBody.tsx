import { useEffect, useRef, useState } from "react";
import type { AgentContentSegment } from "../task-detail/conversationModel.ts";
import { MessageAttachments } from "../task-detail/Attachments.tsx";
import { MarkdownBody } from "./MarkdownBody.tsx";
import {
  ExecutionDetails,
  ExecutionEventList,
  ExecutionSummaryLine,
  hasExecutionError,
} from "./ExecutionTrace.tsx";

/**
 * 把一个回合切成「过程」和「结论」两段。切点是**最后一次工具/分析事件**：在它之前的
 * 一切（含夹在两次工具调用之间的正文）折起来，在它之后吐出的正文原样露在外面。
 *
 * 判据是位置而不是内容类型 —— 同一段边干边说的正文，落在最后一次工具动作之前就是过程，
 * 之后就是结论。这样一条长回合收起来只剩它最后要讲的那件事。
 *
 * 切点常常落在**一段之内**：contentSegments 把「若干工具事件 + 紧随其后的正文」攒成同
 * 一段（见 conversationModel.ts 的 pushCurrent），所以这里要把那一段拆开——事件归过程，
 * 正文和附件归结论。按段切会把结论也一并折没。
 */
export function splitTurnSegments(segments: AgentContentSegment[]): {
  process: AgentContentSegment[];
  conclusion: AgentContentSegment[];
} {
  const flat = { process: [] as AgentContentSegment[], conclusion: segments };
  let pivot = -1;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index]!.events.length) { pivot = index; break; }
  }
  if (pivot < 0) return flat;

  const split = segments[pivot]!;
  const conclusion = [
    { ...split, id: `${split.id}:said`, events: [] },
    ...segments.slice(pivot + 1),
  ];
  // 折完一个字都不剩就不折：跑完工具没再说话的回合、以及 trace 不完整退回的单段气泡，
  // 折起来用户只能对着一片空白猜发生了什么。这种回合维持原样（逐段折事件）。
  if (!conclusion.some((segment) => segment.markdown.trim() || segment.attachments.length)) return flat;

  return {
    process: [
      ...segments.slice(0, pivot),
      { ...split, id: `${split.id}:did`, markdown: "", attachments: [] },
    ],
    conclusion,
  };
}

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
