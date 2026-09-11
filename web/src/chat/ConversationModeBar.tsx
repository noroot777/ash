import type { TaskMode } from "@ash/shared";
import { ChatCircleDots } from "@phosphor-icons/react";
import { AssistantIcon } from "../assistant/AssistantIcon.tsx";
import { MODES } from "../composer/composerParts.tsx";
import "./conversation-mode-bar.css";

export function ConversationModeBar({ active, onMode, onChat, onAssistant }: {
  active: "chat" | "assistant"; onMode: (mode: TaskMode) => void;
  onChat?: () => void; onAssistant?: () => void;
}) {
  return <nav className="conversation-mode-bar" aria-label="工作模式" data-active={active}>
    {MODES.map((mode) => <button type="button" key={mode.value} onClick={() => onMode(mode.value)}>{mode.label}</button>)}
    <button type="button" aria-current={active === "chat" ? "page" : undefined} onClick={onChat}><ChatCircleDots size={14} />聊天</button>
    {(active === "assistant" || onAssistant) && <button type="button" aria-label="ash 助手" aria-current={active === "assistant" ? "page" : undefined} onClick={onAssistant}><AssistantIcon size={14} />助手</button>}
  </nav>;
}
