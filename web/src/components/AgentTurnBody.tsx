import type { AgentContentSegment } from "../task-detail/conversationModel.ts";
import { MessageAttachments } from "../task-detail/Attachments.tsx";
import { splitTurnSegments } from "../task-detail/turnFold.ts";
import { MarkdownBody } from "./MarkdownBody.tsx";
import {
  ExecutionDetails,
  ExecutionEventList,
  ExecutionSummaryLine,
  hasExecutionError,
  useAutoFold,
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
 * 过程折叠块。跑的时候默认摊开（不然用户盯着一行摘要不知道在干嘛），整条执行链路停下来
 * 的那一刻才自动收起 —— 判据见 useAutoFold / nextProcessFoldOpen，跑的中途一律不折。
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
  const fold = useAutoFold(running, taskLive);

  return (
    <details
      className={`task-execution-block task-turn-process${hasExecutionError(events) ? " has-error" : ""}`}
      open={fold.open}
      onToggle={fold.onToggle}
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
  const { process, conclusion } = splitTurnSegments(segments);
  return (
    <>
      {!!process.length && <ProcessFold segments={process} running={running} taskLive={taskLive} />}
      {conclusion.map((segment, index) => (
        <section className="task-agent-segment" key={segment.id}>
          {/*
            不折的那条路径（无过程可折 / 折完没内容）仍按老样子逐段折事件 —— 但**摊开的
            时机跟过程块一致**：这条路径正是一条回合跑到「最后一步是工具调用、后面还没
            吐字」时的形状，让它保持默认收起，用户看到的就是执行过程在跑的中途自己合上。
            live 传回合级的 running（这一段是不是当前那一步只决定小圆点，不决定开合）。
          */}
          <ExecutionDetails
            events={segment.events}
            running={running && !process.length && index === conclusion.length - 1}
            live={running}
            taskLive={taskLive}
          />
          <SegmentBody segment={segment} />
        </section>
      ))}
    </>
  );
}
