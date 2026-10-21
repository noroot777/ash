import { ArrowElbowDownRight, ArrowSquareIn, CaretRight, Check } from "@phosphor-icons/react";
import { useId } from "react";
import { CopyButton } from "../components/CopyButton.tsx";
import { MessageAttachments } from "./Attachments.tsx";
import type { ConversationItem } from "./conversationModel.ts";
import { monitorWakePreview, type MonitorWakeInput as WakeInput } from "./monitorWakeModel.ts";
import { formatInstant, parseAttachmentText } from "./utils.ts";

export function MonitorWakeInput({ item, input, surface }: {
  item: Extract<ConversationItem, { kind: "user" }>;
  input: WakeInput;
  surface: "task" | "team";
}) {
  const headingId = useId();
  const parsed = parseAttachmentText(item.text);
  const endedOnly = input.events.every((event) => event.kind === "ended");
  return (
    <article className={`monitor-wake-input is-${surface}`} aria-labelledby={headingId}>
      <div className="monitor-wake-message">
        <header className="monitor-wake-meta">
          <b>ash</b>
          <span className="monitor-wake-label"><ArrowSquareIn size={11} aria-hidden="true" />自动输入</span>
          {item.at && <time>{formatInstant(item.at)}</time>}
          <CopyButton value={item.text} ariaLabel="复制完整自动输入" icon />
        </header>
        <div className="monitor-wake-bubble">
          <div className="monitor-wake-body">
            <p className="monitor-wake-source"><ArrowSquareIn size={12} aria-hidden="true" /><span>哨兵触发 / {input.source}</span></p>
            <h3 id={headingId}>{input.reason}</h3>
            <p className="monitor-wake-context">以下内容作为新输入进入会话，不是普通通知。</p>
            <div className="monitor-wake-payload" aria-label="送给 Agent 的内容摘要">
              <p className="monitor-wake-payload-label">送给 Agent 的内容摘要</p>
              {input.events.slice(-2).map((event, index) => (
                <div className="monitor-wake-excerpt" key={index}>
                  {input.events.length > 1 && <span>{event.kind === "ended" ? "结束通知" : "输出事件"} · {event.source}</span>}
                  <pre>{monitorWakePreview(event.body) || "此消息没有附带输出正文，请展开查看完整输入。"}</pre>
                </div>
              ))}
              {input.events.length > 2 && <p className="monitor-wake-omitted">另有 {input.events.length - 2} 条较早消息，见完整输入。</p>}
            </div>
            {endedOnly && <p className="monitor-wake-caution">命令结束 ≠ 任务完成</p>}
            {input.historyTruncated && <p className="monitor-wake-omitted">较早的输出已被截断，完整输入中保留了原始截断说明。</p>}
            <MessageAttachments paths={[...parsed.paths, ...item.attachments]} />
          </div>
          <footer className="monitor-wake-delivery">
            <span><Check size={12} aria-hidden="true" />已写入会话</span>
            <span>{input.historyTruncated ? "至少 " : ""}{input.events.length} 条消息 → 1 次输入{input.hasCheckpoint ? " · 含续跑交代" : ""}</span>
          </footer>
          <details className="monitor-wake-raw">
            <summary><CaretRight size={11} aria-hidden="true" />查看完整输入与来源</summary>
            <pre>{item.text}</pre>
          </details>
        </div>
      </div>
      <span className="monitor-wake-avatar" aria-hidden="true"><ArrowSquareIn size={13} /></span>
    </article>
  );
}

export function MonitorWakeReply() {
  return <span className="monitor-wake-reply"><ArrowElbowDownRight size={11} aria-hidden="true" />回复这次自动输入</span>;
}
