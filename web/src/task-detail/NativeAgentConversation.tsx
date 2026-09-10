import { useMemo, useRef } from "react";
import { ArrowLeft, Robot } from "@phosphor-icons/react";
import { AgentTurnBody } from "../components/AgentTurnBody.tsx";
import { ConversationScrollControls } from "../components/ConversationScrollControls.tsx";
import { ImagePreviewGroup } from "../components/ImagePreview.tsx";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import type { NativeWorkItem } from "./nativeWorkModel.ts";
import { nativeAgentSegments } from "./nativeAgentSegments.ts";
import { NativeWorkMeta } from "./NativeWorkMeta.tsx";

export function NativeAgentConversation({ row, statusLabel, onBack, error, onRetry }: {
  row: NativeWorkItem; statusLabel: string; onBack: () => void;
  error?: Error | null; onRetry?: () => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const segments = useMemo(() => nativeAgentSegments(row.activity ?? []), [row.activity]);
  const running = row.status === "running";
  const pending = row.status === "pending";
  const finalResult = segments.length > 0 && (row.status === "completed" || row.status === "failed")
    && row.result && !segments.map((segment) => segment.markdown).join("").includes(row.result) ? row.result : null;
  return <div className="native-agent" aria-label="子智能体执行详情">
    <header className="native-agent__header">
      <button type="button" onClick={onBack}><ArrowLeft size={14} aria-hidden="true" />返回列表</button>
      <div className="native-agent__heading"><span className="native-work__avatar"><Robot size={19} aria-hidden="true" /></span>
        <div><strong>{row.title}</strong><small>{row.sessionLabel}</small></div>
      </div>
      <span className="native-work__status" data-status={row.status} role="status">{statusLabel}</span>
      <NativeWorkMeta row={row} />
    </header>
    <ImagePreviewGroup isolated>
      <div className="conversation-scroll-region native-agent__scroll-region">
        <div className="native-agent__conversation" ref={scroll} tabIndex={0} aria-label="子智能体会话内容">
          <div className="native-agent__section-label"><span>执行记录</span><span>{running ? "实时同步" : pending ? "等待开始" : "历史记录"}</span></div>
          {error && <p className="native-work__error" role="alert">{error.message} {onRetry && <button type="button" onClick={onRetry}>重试</button>}</p>}
          {row.description && <details className="native-agent__assignment"><summary>任务说明</summary><MarkdownBody text={row.description} /></details>}
          {segments.length > 0 ? <AgentTurnBody segments={segments} running={running} /> : <>
            <p className="native-work__hint">{running ? "等待子智能体的执行记录…" : pending ? "等待子智能体开始执行…" : "此会话未记录详细执行过程。"}</p>
            {row.message && <MarkdownBody text={row.message} />}
            {row.result && row.result !== row.message && <MarkdownBody text={row.result} />}
          </>}
          {finalResult && <section><h4>返回结果</h4><MarkdownBody text={finalResult} /></section>}
          {running && <p className="native-agent__live" role="status"><span className="task-execution-pulse" aria-hidden="true" />执行中，内容实时更新</p>}
        </div>
        <ConversationScrollControls scrollRef={scroll} resetKey={row.id} />
      </div>
    </ImagePreviewGroup>
  </div>;
}
