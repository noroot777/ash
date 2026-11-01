import { ArrowElbowDownRight, ArrowSquareIn, CaretDown, CaretRight, Check } from "@phosphor-icons/react";
import { useId } from "react";
import { CopyButton } from "../components/CopyButton.tsx";
import { MessageAttachments } from "./Attachments.tsx";
import type { ConversationItem } from "./conversationModel.ts";
import { monitorWakePreview, type MonitorWakeInput as WakeInput } from "./monitorWakeModel.ts";
import { formatInstant, parseAttachmentText } from "./utils.ts";

/**
 * 哨兵唤起的那条自动输入。
 *
 * 默认是**折叠态**：身份行加一行摘要，高度跟问答答复卡一个量级。会话里这种输入常常
 * 一来就是好几条，摊开的样子（来源、输出摘要、完整原文入口）会把真正的对话挤出屏幕，
 * 而它绝大多数时候只需要被扫一眼确认「哦，哨兵把结果送进来了」。要看细节再点开。
 */
export function MonitorWakeInput({ item, input, surface }: {
  item: Extract<ConversationItem, { kind: "user" }>;
  input: WakeInput;
  surface: "task" | "team";
}) {
  const headingId = useId();
  const parsed = parseAttachmentText(item.text);
  const endedOnly = input.events.length > 0 && input.events.every((event) => event.kind === "ended");
  return (
    <article className={`monitor-wake-input is-${surface}`} aria-labelledby={headingId}>
      <div className="monitor-wake-message">
        <details className="monitor-wake-fold">
          <summary className="monitor-wake-head">
            <span className="monitor-wake-mark" aria-hidden="true"><ArrowSquareIn size={14} /></span>
            <span className="monitor-wake-head-main">
              <span className="monitor-wake-meta">
                <b>ash</b>
                <span className="monitor-wake-label">自动输入</span>
                {item.at && <time>{formatInstant(item.at)}</time>}
                {/* 复制按钮落在 <summary> 里：那里的点击默认连带开合这张卡，所以这一格把默认
                    动作掐掉——否则「复制一下」会顺手把整张卡翻面。 */}
                <span className="monitor-wake-copy" onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}>
                  <CopyButton value={item.text} ariaLabel="复制完整自动输入" icon />
                </span>
                <span className="monitor-wake-fold-action">
                  <span className="monitor-wake-fold-open">展开</span>
                  <span className="monitor-wake-fold-close">收起</span>
                  <CaretDown size={11} aria-hidden="true" />
                </span>
              </span>
              {/* 折叠时这一行就是全部内容；展开后正文里的标题会把同一句话说全，这里让位。
                  所以它也要声明成正文（否则选中整张折着的卡只能得到空的），而展开之后
                  CSS 把它藏起来，取文那边按「看不见就不算正文」自己让位，不会说两遍。 */}
              <span className="monitor-wake-brief" data-selection-content="">
                {input.reason}
                {input.source && <span className="monitor-wake-brief-source">{input.source}</span>}
              </span>
            </span>
          </summary>
          <div className="monitor-wake-bubble">
            <div className="monitor-wake-body">
              <h3 id={headingId}>{input.reason}</h3>
              <p className="monitor-wake-source"><span className="monitor-wake-source-label">{input.source ? "来自哨兵" : "历史输入"}</span><span>{input.source ?? "历史来源未记录"}</span></p>
              <div className="monitor-wake-payload" aria-label="送给 Agent 的内容摘要">
                <p className="monitor-wake-payload-label">输入摘要</p>
                {input.events.slice(-2).map((event, index) => (
                  <div className="monitor-wake-excerpt" key={index}>
                    {input.events.length > 1 && <span>{event.kind === "ended" ? "结束通知" : "输出事件"} · {event.source} [{event.monitorId}]</span>}
                    <pre>{monitorWakePreview(event.body) || "此消息没有附带输出正文，请展开查看完整输入。"}</pre>
                  </div>
                ))}
                {input.eventCount === null && <><pre>{monitorWakePreview(item.text)}</pre><p className="monitor-wake-omitted">历史输入未记录结构化来源，请查看原文；不推断事件条数或续跑交代。</p></>}
                {input.eventCount !== null && input.eventCount > Math.min(input.events.length, 2) && <p className="monitor-wake-omitted">另有 {input.eventCount - Math.min(input.events.length, 2)} 条较早消息未展示，{input.historyTruncated ? "完整记录见哨兵日志" : "见完整输入"}。</p>}
              </div>
              {endedOnly && <p className="monitor-wake-caution">命令结束 ≠ 任务完成</p>}
              {input.historyTruncated && <p className="monitor-wake-omitted">摘要仅保留部分输出，请结合完整输入与哨兵日志核对。</p>}
              <MessageAttachments paths={[...parsed.paths, ...item.attachments]} />
            </div>
            <details className="monitor-wake-raw">
              <summary>
                <span className="monitor-wake-delivery"><Check size={12} aria-hidden="true" /><span>已写入会话</span><span className="monitor-wake-receipt">{input.eventCount === null ? "历史自动输入" : `${input.eventCount} 条消息 → 1 次输入`}</span>{input.hasCheckpoint && <span className="monitor-wake-checkpoint">含续跑交代</span>}</span>
                <span className="monitor-wake-expand">查看完整输入与来源<CaretRight size={11} aria-hidden="true" /></span>
              </summary>
              <pre>{item.text}</pre>
            </details>
          </div>
        </details>
      </div>
    </article>
  );
}

export function MonitorWakeReply() {
  return <span className="monitor-wake-reply"><ArrowElbowDownRight size={11} aria-hidden="true" />回复这次自动输入</span>;
}
