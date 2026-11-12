import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ClockCounterClockwise, Plus } from "@phosphor-icons/react";
import { InspectorHeadActions } from "../inspector/index.ts";
import { InspTool } from "../inspector/parts.tsx";
import { useDismissable } from "../lib/useDismissable.ts";
import { placementStyle, usePanelPlacement } from "../lib/usePanelPlacement.ts";
import { formatInstant } from "../task-detail/utils.ts";
import { sideChatTitle } from "@ash/shared/chat";
import type { useSideChat } from "./useSideChat.ts";

type SideChatState = ReturnType<typeof useSideChat>;

/**
 * 侧聊挂在面板头带上的两颗：钟（换一场，聊过别的场才有）和 +（新开一场，正在一场里才有）。
 *
 * 一场侧聊拿它的第一句话当名字（服务端从这一场的第一条消息里取，见 shared 的
 * `sideChatTitle`）；还没问过话的老场次退回「侧聊 · 几点开的」。
 */
export function SideChatHeadControls({ chat }: { chat: SideChatState }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const place = usePanelPlacement(trigger, list, { minWidth: 240, minHeight: 80, fallbackHeight: 40 * (chat.rooms.length + 1) + 8, enabled: open });
  useDismissable({ enabled: open, containerRef: list, restoreFocusRef: trigger, onClose: () => setOpen(false) });
  // 传图传到一半不让切场：在途那张传完之后会落进「当时那一场」的草稿，切走等于把图挂到
  // 别人名下。上传就那么几秒，这里跟发送中同一档处理。
  const locked = chat.sending || chat.savingMember || chat.pending.length > 0;
  const current = chat.room?.id ?? null;
  const others = chat.rooms.filter((room) => room.id !== current).length;
  // 刚开的这一场列表里还没有名字：拿手上这份快照里的第一句话补上。
  const firstAsked = chat.snapshot?.messages.find((message) => message.role === "user");
  const titleOf = (room: { id: string; title?: string }) =>
    room.title || (room.id === current && firstAsked ? sideChatTitle(firstAsked.body) : "") || "侧聊";
  useLayoutEffect(() => {
    if (!open) return;
    const options = [...(list.current?.querySelectorAll<HTMLButtonElement>("[role=option]") ?? [])];
    (options.find((option) => option.getAttribute("aria-selected") === "true") ?? options[0])?.focus();
  }, [open]);
  const pick = (id: string | null) => {
    setOpen(false);
    trigger.current?.focus();
    chat.select(id);
  };
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const options = [...(list.current?.querySelectorAll<HTMLButtonElement>("[role=option]") ?? [])];
    if (!options.length) return;
    event.preventDefault();
    const at = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? options.length - 1
        : (at + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
  };
  return <InspectorHeadActions>
    {others > 0 && (
      <InspTool
        ref={trigger}
        label="换一场侧聊"
        className="side-chat-rooms-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={locked}
        onClick={() => setOpen((value) => !value)}
      >
        <ClockCounterClockwise aria-hidden="true" />
      </InspTool>
    )}
    {chat.room && <InspTool label="新建侧聊" tip="新开一场" disabled={locked} onClick={() => chat.select(null)}><Plus aria-hidden="true" /></InspTool>}
    {open && createPortal(
      <div ref={list} className="insp-more-menu side-chat-rooms" style={place ? { ...placementStyle(place), width: undefined } : { visibility: "hidden" }} onKeyDown={move}>
        <div className="ui-menu" role="listbox" aria-label="切换侧聊">
          {chat.rooms.map((room) => (
            <button
              key={room.id}
              type="button"
              role="option"
              aria-selected={room.id === current}
              data-room-id={room.id}
              className={`ui-menu-item side-chat-rooms__item${room.id === current ? " is-selected" : ""}`}
              onClick={() => pick(room.id)}
            >
              <span className="insp-cut">{titleOf(room)}</span>
              <span className="side-chat-rooms__at">{formatInstant(room.createdAt)}</span>
            </button>
          ))}
        </div>
      </div>,
      document.body,
    )}
  </InspectorHeadActions>;
}
