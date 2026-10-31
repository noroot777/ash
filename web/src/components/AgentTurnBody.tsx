import { useMemo, useState, type ReactNode } from "react";
import { isVisibleExecutionEvent } from "../lib/executionTrace.ts";
import type { AgentContentSegment } from "../task-detail/conversationModel.ts";
import { awaitingUpstream, segmentHasVisibleContent } from "../task-detail/conversationSegments.ts";
import { MessageAttachments } from "../task-detail/Attachments.tsx";
import { turnDocument, type TurnStop } from "../task-detail/turnDocument.ts";
import { ImagePreviewGroup } from "./ImagePreview.tsx";
import { MarkdownBody } from "./MarkdownBody.tsx";
import type { MarkdownLayout } from "./markdownLayout.ts";
import {
  ExecutionDetails,
  ExecutionEventList,
  ExecutionSummaryLine,
  executionBlockTone,
} from "./ExecutionTrace.tsx";

/**
 * 过程折叠块。**只在这一回合收口之后才会被渲染**（见 turnDocument），所以它一上来就是
 * 折好的，之后再不自动动 —— 用户点开了就一直开着。
 *
 * 里面是**同一次解析**出来的那几个顶层块(由 markdownLayout 圈进来的 children),所以
 * 折叠内外的链接引用定义、脚注照旧全局有效。灯箱另立一组:折着的那半截里的图不该混进
 * 外面那一组的队列,否则左右翻会翻到屏幕上根本没有的图。
 */
function ProcessFold({ events, open, onToggle, children }: {
  events: TurnStop["events"];
  open: boolean;
  onToggle: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <details
      className={`task-execution-block task-turn-process${executionBlockTone(events)}`}
      /* 选中一段会话时整块不算正文 —— 这里尤其要声明:折进去的那半截**本来就是正文**
         (markdown 顶层块),语义上跟外面那段结论一模一样,分不出来(同 ExecutionTrace)。 */
      data-selection-chrome=""
      open={open}
      onToggle={(event) => onToggle(event.currentTarget.open)}
    >
      <summary>
        <ExecutionSummaryLine events={events} running={false} />
      </summary>
      <div className="task-turn-process-body">
        <ImagePreviewGroup isolated>{children}</ImagePreviewGroup>
      </div>
    </details>
  );
}

/**
 * 一条 agent 气泡的正文。普通任务与团队调度流共用；duet 的回合没有交错结构（就一份
 * events 加一份正文），继续直接用 ExecutionDetails。
 *
 * **整条消息只解析一次**：执行步骤按节点偏移摆进顶层块之间（见 markdownLayout 与
 * turnDocument）。上一版把每一段正文各自过一遍渲染器，于是文档级的定义只要跨过一个工具
 * 步骤就两头落空 —— 脚注里的截图谁都画不出来，而附件卡片已经被认领走（审查第 3 轮 R2）。
 */
export function AgentTurnBody({
  segments,
  running,
  taskId,
}: {
  segments: AgentContentSegment[];
  /** 这一回合还在飞（会话行还没落 endedAt）。在飞就不折，见 turnDocument。 */
  running: boolean;
  /**
   * 这一回合是在哪个任务的工作目录里说的话。给了才有「读的时候再去目录里取一次」那一
   * 档退路——存量消息（落盘之前说的那些）唯一还拿得到图的路子，见 turnImages。
   */
  taskId?: string;
}) {
  const turn = useMemo(
    () => turnDocument(segments, { live: running, taskId }),
    [segments, running, taskId],
  );
  // 此刻还卡在上游等回话?判据连理由住在 awaitingUpstream;跟 main 路径同口径,先滤掉
  // 画不出东西的段再取末段(重建那一路 markSegmentsAwaiting 落的就是最后一个可见段)。
  const awaiting = running && awaitingUpstream(segments.filter(segmentHasVisibleContent));
  // 折叠的开合状态放在这一层:整篇只解析一次,「折着的那一区里的引用不算看得见」要在布局
  // 里判(只被过程折叠引用到的脚注不该把正文和截图露在外面,见 markdownLayout 的 collapsed)。
  const [foldOpen, setFoldOpen] = useState(false);
  const layout = useMemo((): MarkdownLayout => {
    const { stops, fold } = turn;
    // 还在飞的那一下,脉冲点只给**最后一个画得出东西的**步骤 —— 它就是此刻正在发生的那一步。
    const pulse = running
      ? stops.reduce((last, stop, index) => (stop.events.some(isVisibleExecutionEvent) ? index : last), -1)
      : -1;
    return {
      inserts: stops.map((stop, index) => ({
        offset: stop.offset,
        node: (
          <StopBody
            key={stop.id}
            stop={stop}
            /* 折叠块自己就是一层 `<details>`,里面的事件行不再各自套一层(见 ExecutionEventList)。 */
            bare={!!fold && index < fold.stops}
            running={index === pulse}
            awaiting={awaiting && index === pulse}
          />
        ),
      })),
      // 过程折叠 = 第一个区(前 `fold.stops` 个步骤 + 整个在切点之前的那几个块);剩下的
      // 正文排在它后面、原样铺开(见 markdownLayout 的 regions)。
      ...(fold
        ? {
          regions: [{
            until: fold.offset,
            inserts: fold.stops,
            collapsed: !foldOpen,
            render: (children: ReactNode) => (
              <ProcessFold
                events={stops.slice(0, fold.stops).flatMap((stop) => stop.events)}
                open={foldOpen}
                onToggle={setFoldOpen}
              >
                {children}
              </ProcessFold>
            ),
          }],
        }
        : {}),
    };
  }, [turn, running, awaiting, foldOpen]);

  return <MarkdownBody text={turn.text} layout={layout} />;
}

/* `awaiting` = 此刻正卡在上游等回话,只会落在脉冲那一步上(它就是正在发生的这一步):
   折叠条上那句「正在重试」要常驻,见 ExecutionTrace 的 TransientExecutionLabel。 */
function StopBody({ stop, bare, running, awaiting }: { stop: TurnStop; bare: boolean; running: boolean; awaiting: boolean }) {
  return (
    <>
      {bare
        ? <ExecutionEventList events={stop.events} />
        : <ExecutionDetails events={stop.events} running={running} awaiting={awaiting} />}
      <MessageAttachments paths={stop.attachments} />
    </>
  );
}
