import { useRef, useState } from "react";
import { Info, Plus } from "@phosphor-icons/react";
import { InspectorHeadActions } from "../inspector/index.ts";
import { useDismissable } from "../lib/useDismissable.ts";
import type { useSideChat } from "./useSideChat.ts";

type SideChatState = ReturnType<typeof useSideChat>;

const roomTime = (at: string) =>
  new Date(at).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * 侧聊的三个入口挂在 inspector 头带上：切换房间、新建、ⓘ 说明。
 *
 * 它们原先是面板顶部一条工具栏加底部一段常驻说明文字，两头各占一条；侧栏本来就窄，
 * 消息列表和输入框才是要看的东西。说明只在点 ⓘ 时才展开——那段话是头一回用时读的。
 */
export function SideChatHeadControls({ chat }: { chat: SideChatState }) {
  const [helpOpen, setHelpOpen] = useState(false);
  const help = useRef<HTMLDivElement>(null);
  const helpTrigger = useRef<HTMLButtonElement>(null);
  useDismissable({ enabled: helpOpen, containerRef: help, restoreFocusRef: helpTrigger, onClose: () => setHelpOpen(false) });
  const locked = chat.sending || chat.savingMember;
  return <InspectorHeadActions>
    <div className="side-chat-head">
      {!!chat.rooms.length && <>
        <select aria-label="切换侧聊" value={chat.room?.id ?? ""} disabled={locked} onChange={(event) => chat.select(event.target.value || null)}>
          <option value="">新侧聊</option>
          {chat.rooms.map((room, index, rooms) => <option key={room.id} value={room.id}>侧聊 {rooms.length - index} · {roomTime(room.createdAt)}</option>)}
        </select>
        <button type="button" aria-label="新建侧聊" disabled={locked || !chat.room} onClick={() => chat.select(null)}><Plus size={13} weight="bold" /></button>
      </>}
      <button ref={helpTrigger} type="button" aria-label="侧聊说明" aria-haspopup="dialog" aria-expanded={helpOpen} onClick={() => setHelpOpen((open) => !open)}><Info size={13} /></button>
      {helpOpen && <div className="side-chat-help" ref={help} role="dialog" aria-label="侧聊说明">
        <p>围绕主会话独立提问，不打断主任务。需要回传时，直接说：<code>把结论告诉主任务</code>。</p>
        <p>首次发送时带入主会话快照，不限长度；主会话特别长时会先整理一份摘要，可能增加等待时间和用量，整理过程可随时停止。关闭面板保留对话与草稿。</p>
        <p>输入框里 Enter 发送，Shift Enter 换行。</p>
      </div>}
    </div>
  </InspectorHeadActions>;
}
