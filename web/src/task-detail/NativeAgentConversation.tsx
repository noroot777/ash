import { useMemo, useRef } from "react";
import { Robot } from "@phosphor-icons/react";
import { AgentTurnBody } from "../components/AgentTurnBody.tsx";
import { ConversationScrollControls } from "../components/ConversationScrollControls.tsx";
import { ImagePreviewGroup } from "../components/ImagePreview.tsx";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { taskFileResolver } from "../components/markdownPolicy.ts";
import type { NativeWorkItem } from "./nativeWorkModel.ts";
import { NATIVE_WORK_NO_ASSIGNMENT } from "./nativeWorkModel.ts";
import { nativeAgentSegments } from "./nativeAgentSegments.ts";
import { segmentContentSize } from "./conversationContentSize.ts";
import { NativeWorkHeadline } from "./NativeWorkMeta.tsx";

// 住在左侧抽屉里（见 components/SideDrawer.tsx）：返回列表靠抽屉自己那颗关闭按钮、
// 点遮罩或 Esc —— 列表本来就一直在右侧 Inspector 里开着，这里不再重复一个「返回」。
export function NativeAgentConversation({ row, taskId, statusLabel, error, onRetry }: {
  row: NativeWorkItem; statusLabel: string;
  /** 子智能体跑在**派它的那个任务**的工作目录里：正文里的图按它去取（见 AgentTurnBody）。 */
  taskId: string;
  error?: Error | null; onRetry?: () => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const segments = useMemo(() => nativeAgentSegments(row.activity ?? []), [row.activity]);
  // 没有执行记录、只剩 message/result 那条路径不走分段模型（也就没有 turnImages 那一档
  // 快照配对），正文里的本机图片只能「现在去工作目录里取」。
  const resolveFile = useMemo(() => taskFileResolver(taskId), [taskId]);
  const running = row.status === "running";
  const pending = row.status === "pending";
  const finalResult = segments.length > 0 && (row.status === "completed" || row.status === "failed")
    && row.result && !segments.map((segment) => segment.markdown).join("").includes(row.result) ? row.result : null;
  /* 这一屏到底显示了多少字。两条规矩:
     ① 按**归一化之后**的 segments 算,不按原始 activity 条数 —— 同一个附件被重复通知时
        nativeAgentSegments 会去重,渲染数据一个像素没变,那就不该算成新内容(审查 B6);
     ② 只算**这一帧真渲染出来的那个分支** —— 下面 segments 在场时走 AgentTurnBody,
        message/result 那两段根本不画出来;把不画的字算进去,子智能体在后台更新 message
        就会把正在读的人拽到底(审查第 5 轮 F1)。 */
  const nativeTailKey = [
    segments.length,
    segments.reduce((total, segment) => total + segmentContentSize(segment), 0),
    segments.length > 0 ? 0 : (row.message?.length ?? 0) + (row.result?.length ?? 0),
    finalResult?.length ?? 0,
    row.description?.length ?? 0,
    row.status,
  ].join(":");
  return <div className="native-agent" aria-label="子智能体执行详情">
    <header className="native-agent__header">
      <div className="native-agent__heading"><span className="native-agent__avatar"><Robot size={19} aria-hidden="true" /></span>
        <div><strong>{row.title}</strong><NativeWorkHeadline row={row} /></div>
      </div>
      <span className="native-work__status" data-status={row.status} role="status">{statusLabel}</span>
    </header>
    <ImagePreviewGroup isolated>
      <div className="conversation-scroll-region native-agent__scroll-region">
        <div className="native-agent__conversation" ref={scroll} tabIndex={0} aria-label="子智能体会话内容">
          <div className="native-agent__section-label"><span>执行记录</span><span>{running ? "实时同步" : pending ? "等待开始" : "历史记录"}</span></div>
          {error && <p className="native-work__error" role="alert">{error.message} {onRetry && <button type="button" onClick={onRetry}>重试</button>}</p>}
          {row.description
            ? <details className="native-agent__assignment"><summary>收到的输入</summary><MarkdownBody text={row.description} /></details>
            : <p className="native-work__hint">{NATIVE_WORK_NO_ASSIGNMENT}</p>}
          {/* 分段在场时正文走 AgentTurnBody(附件快照优先,见 turnImages)。下面那一支只在
              **一条活动记录都没有**时出现 —— 分段就是从同一串活动里切出来的,所以那时
              连一条附件结果都不存在,没有快照可兑现,`resolveFile` 的「现在去工作目录取」
              是唯一一档,不是绕过了谁(审查第 1 轮 F1 同类路径)。`finalResult` 同理:它只在
              返回结果不在任何分段正文里时才画,那段文字从来没进过 text 活动。 */}
          {segments.length > 0 ? <AgentTurnBody segments={segments} running={running} taskId={taskId} /> : <>
            <p className="native-work__hint">{running ? "等待子智能体的执行记录…" : pending ? "等待子智能体开始执行…" : "此会话未记录详细执行过程。"}</p>
            {row.message && <MarkdownBody text={row.message} resolveFile={resolveFile} />}
            {row.result && row.result !== row.message && <MarkdownBody text={row.result} resolveFile={resolveFile} />}
          </>}
          {finalResult && <section><h4>返回结果</h4><MarkdownBody text={finalResult} resolveFile={resolveFile} /></section>}
          {running && <p className="native-agent__live" role="status"><span className="task-execution-pulse" aria-hidden="true" />执行中，内容实时更新</p>}
        </div>
        <ConversationScrollControls scrollRef={scroll} resetKey={row.id} tailKey={nativeTailKey} />
      </div>
    </ImagePreviewGroup>
  </div>;
}
