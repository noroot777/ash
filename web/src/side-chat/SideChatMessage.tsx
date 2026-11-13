// 侧聊里的一条：你的话靠右、垫一层底色；它的话靠左、不加框；都不报名字。
//
// 它的每条回答指到才出两颗键：复制、发给主任务。发出去以后那条回答底下多一行回执——主任务
// 还在跑就先排着（这时能撤回），空下来才送到。回答自己要求回传的那种（你在话里说了「把结论
// 告诉主任务」）走的是同一条投递路，回执长得一样。
import type { ChatMessage } from "@ash/shared/chat";
import { parseAttachmentText } from "@ash/shared/attachments";
import { splitSideChatBody } from "@ash/shared/chat";
import { ArrowBendUpLeft, Check, Clock, Warning, X } from "@phosphor-icons/react";
import { ExecutionDetails } from "../components/ExecutionTrace.tsx";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { InspCopy, InspTool } from "../inspector/parts.tsx";
import { MessageAttachments } from "../task-detail/Attachments.tsx";
import { ReuseInputButton } from "../task-detail/ReuseInput.tsx";

/** 你发的那条：带了主会话选文时，那一段是一行引用，跟在你那句话上面。指到时左边浮出「改了再发」。 */
function Mine({ message, onReuse }: { message: ChatMessage; onReuse: (input: { question: string; quote: string | null; paths: readonly string[] }) => void }) {
  const parsed = parseAttachmentText(message.body);
  const { quote, question } = splitSideChatBody(parsed.body);
  const tip = useHoverTip();
  return (
    <div className={`side-chat-message side-chat-me is-user is-${message.status}`}>
      {quote && (
        <>
          <p className="side-chat-me__quote" tabIndex={0} aria-label={`引用主会话：${quote}`} {...tip.anchorProps}>{quote}</p>
          <HoverTip at={tip.at}>{quote.length > 280 ? `${quote.slice(0, 280)}…` : quote}</HoverTip>
        </>
      )}
      {question.trim() && <MarkdownBody text={question} />}
      {!!parsed.paths.length && <MessageAttachments paths={parsed.paths} />}
      <ReuseInputButton className="side-chat-me__reuse" onReuse={() => onReuse({ question: question.trim(), quote, paths: parsed.paths })} />
    </div>
  );
}

function Receipt({ message, onRevoke }: { message: ChatMessage; onRevoke: (forwardId: string) => void }) {
  const textTip = useHoverTip();
  if (message.forwardError) {
    return (
      <p className="side-chat-receipt is-error" role="status">
        <Warning size={12} aria-hidden="true" />
        <span>未发送到主任务：{message.forwardError}</span>
      </p>
    );
  }
  const forward = message.forward;
  if (!forward) return null;
  const queued = forward.status === "queued";
  return (
    <p className={`side-chat-receipt is-${forward.status}`} role="status">
      {forward.status === "sent" ? <Check size={12} aria-hidden="true" /> : forward.status === "canceled" ? <X size={12} aria-hidden="true" /> : <Clock size={12} aria-hidden="true" />}
      <span tabIndex={0} {...textTip.anchorProps}>
        {forward.status === "sent" ? "已送达主任务"
          : forward.status === "delivering" ? "正在发给主任务"
            : queued ? "排着，主任务空下来就发"
              // 撤回了也留一行：刷新之后仍看得出「发过、又撤了」。「发给主任务」那颗键会回来，想发再点。
              : forward.status === "canceled" ? "已撤回，没有发给主任务" : "回执不可用"}
      </span>
      <HoverTip at={textTip.at}>{forward.text}</HoverTip>
      {queued && (
        <button type="button" className="side-chat-receipt__undo" onClick={() => onRevoke(forward.messageId)}>撤回</button>
      )}
    </p>
  );
}

/** 它的一条回答：执行过程（跑的中途就露在外面）、正文、回执，和指到才出的两颗键。 */
function Answer({ message, onForward, onRevoke }: {
  message: ChatMessage;
  onForward: (messageId: string) => void;
  onRevoke: (forwardId: string) => void;
}) {
  const busy = message.status === "queued" || message.status === "running";
  // 侧聊的 trace 里只有工具/思考/提示,正文压根不进(server 的 chat/execution.ts 跑完
  // 才一次性落 body),所以这一路没有「正文已经恢复」这个信号可用,判据只能是「那条提示
  // 之后还没有新的 trace 事件」。代价说在明处:上游恢复之后先说一段话、迟迟不调下一个
  // 工具的那段时间里,这句提示会多留一会儿,直到下一条事件或者这条跑完。
  const trace = message.trace ?? [];
  const done = message.status === "done" && !!message.body.trim();
  // 已经排着、正在送、送到了的那条不再给「发给主任务」；撤回了的可以再发。
  const forwarded = !!message.forward && message.forward.status !== "canceled";
  return (
    <article className={`side-chat-message side-chat-ans is-agent is-${message.status}`}>
      {!!trace.length && <ExecutionDetails events={trace} running={busy} awaiting={trace.at(-1)?.kind === "notice"} />}
      {busy && !trace.length && <p className="side-chat-thinking" role="status">{message.status === "queued" ? "等着回答…" : <span className="insp-live">在想</span>}</p>}
      {!busy && <MarkdownBody text={message.body} />}
      <footer className="side-chat-ans__foot">
        <Receipt message={message} onRevoke={onRevoke} />
        {done && (
          <span className="side-chat-ans__acts">
            <InspCopy text={message.body} label="复制" />
            {!forwarded && (
              <InspTool label="发给主任务" tip="把这条回答原样发给主任务；主任务在跑就先排着" onClick={() => onForward(message.id)}>
                <ArrowBendUpLeft aria-hidden="true" />
              </InspTool>
            )}
          </span>
        )}
      </footer>
    </article>
  );
}

export function SideChatMessage({ message, onForward, onRevoke, onReuse }: {
  message: ChatMessage;
  onForward: (messageId: string) => void;
  onRevoke: (forwardId: string) => void;
  onReuse: Parameters<typeof Mine>[0]["onReuse"];
}) {
  if (message.role === "user") return <Mine message={message} onReuse={onReuse} />;
  if (message.role === "system") {
    return <div className={`side-chat-message side-chat-sys is-system is-${message.status}`}><MarkdownBody text={message.body} /></div>;
  }
  return <Answer message={message} onForward={onForward} onRevoke={onRevoke} />;
}
