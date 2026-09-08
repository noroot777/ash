import { useRef } from "react";
import type { ChatSnapshot } from "@ash/shared/chat";
import { ALL_MENTION_ALIASES, isAllMention } from "@ash/shared/chat";
import type { TaskListItem } from "@ash/shared";
import { taskDisplayStatus } from "@ash/shared";
import { ArrowDown, ArrowUpRight, CheckCircle, Hash, Lightning } from "@phosphor-icons/react";
import { useStickToBottom } from "../lib/useStickToBottom.ts";
import { useScrollEdges } from "../lib/useScrollEdges.ts";

export function ChatMessages({ snapshot, onTask, onMention }: { snapshot: ChatSnapshot; onTask: (task: TaskListItem) => void; onMention: (name: string) => void }) {
  const scroll = useRef<HTMLDivElement>(null);
  const { resume } = useStickToBottom(scroll, snapshot.room.id);
  // 已经贴底时没有「跳到最新」可跳，按钮只会挡住最后一条消息。
  const { atBottom } = useScrollEdges(scroll, snapshot.room.id);
  // resume() 只是把贴底意图设回来，真正的滚动要自己发起，否则要等下一条消息进来才跳。
  const toBottom = () => {
    resume();
    const element = scroll.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };
  return <div className="chat-feed-wrap"><div className="chat-feed" ref={scroll} role="log" aria-label="群聊消息" aria-live="polite">
    <div className="chat-welcome"><span className="chat-welcome-icon"><Hash size={32} weight="bold" /></span><h2>{snapshot.room.name}，从一句话开始。</h2><p>想法留在这里，复杂的工作交给任务。<br />点名才加入对话，不点名就安静待命。</p><div>{snapshot.room.members.length > 1 && <button type="button" onClick={() => onMention(ALL_MENTION_ALIASES[0])}>@all</button>}{snapshot.room.members.map((member) => <button type="button" key={member.id} onClick={() => onMention(member.name)}>@{member.name}</button>)}</div></div>
    {snapshot.messages.length >= 500 && <p className="chat-history-note">显示最近 500 条消息；更早的消息仍保存在群聊中。</p>}
    {snapshot.messages.map((message, index) => {
      if (message.role === "system") return <p key={message.id} className="chat-history-note">{message.body}</p>;
      const memberIndex = snapshot.room.members.findIndex((member) => member.id === message.memberId);
      const task = snapshot.tasks.find((candidate) => candidate.id === message.taskId);
      const busy = message.status === "queued" || message.status === "running";
      const previous = snapshot.messages[index - 1];
      const day = new Date(message.createdAt).toLocaleDateString(undefined, { month: "long", day: "numeric" });
      const showDate = !previous || new Date(previous.createdAt).toDateString() !== new Date(message.createdAt).toDateString();
      return <div key={message.id}>
        {showDate && <div className="chat-date"><span>{day}</span></div>}
        <article className={`chat-message ${message.role === "user" ? "is-user" : ""} is-${message.status}`}>
          <span className={`chat-avatar ${message.role === "user" ? "tone-user" : `tone-${Math.max(0, memberIndex) % 4}`}`}>{message.role === "user" ? "你" : message.author.slice(0, 1).toUpperCase()}</span>
          <div className="chat-message-content"><header><strong>{message.role === "user" ? "你" : message.author}</strong>{message.role === "agent" && <span className="chat-bot-label">智能体</span>}<time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</time></header>
            {busy ? <p className="chat-typing"><span><i /><i /><i /></span>{message.status === "queued" ? "已收到点名，等待回复" : "正在组织简短回复"}</p> : <p className="chat-message-body">{message.body.split(/(@[^\s@，。！？,:：;；]+)/gu).map((part, position) => part.startsWith("@") && (snapshot.room.members.some((member) => `@${member.name}` === part) || isAllMention(part.slice(1))) ? <mark key={position}>{part}</mark> : part)}</p>}
            {task && <button type="button" className={`chat-task-card ${task.status === "done" ? "is-done" : ""}`} onClick={() => onTask(task)}>
              <span className="chat-task-symbol">{task.status === "done" ? <CheckCircle size={23} weight="fill" /> : <Lightning size={23} weight="duotone" />}</span>
              <span className="chat-task-copy"><small>ASH 任务 · {task.agentType}</small><strong>{task.title}</strong><span key={`${task.status}-${task.stage}`}>{taskDisplayStatus(task.status, task.stage, !!task.question).label}{task.question ? ` · ${task.question}` : task.status === "done" ? " · 结果已就绪，点击查看" : " · 点击查看详情与日志"}</span></span><ArrowUpRight size={18} />
            </button>}
            {message.taskId && !task && <small>关联任务已删除或当前不可访问。</small>}
          </div>
        </article>
      </div>;
    })}
  </div><button className={`chat-jump${atBottom ? " is-hidden" : ""}`} type="button" onClick={toBottom} tabIndex={atBottom ? -1 : 0} aria-hidden={atBottom} aria-label="跳到最新消息"><ArrowDown size={13} />最新消息</button></div>;
}
