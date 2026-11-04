import { createContext, useContext, useState, type ReactNode } from "react";
import { Trash } from "@phosphor-icons/react";
import type { ConversationItem, ConversationSource } from "./conversationModel.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/**
 * 删掉一条消息（真人的、agent 的、哨兵的自动输入）。
 *
 * 由会话页给出删除动作（`ConversationFeed` 的 `onDeleteMessage`），气泡里的按钮从上下文
 * 取 —— 哨兵输入卡、系统代发卡都住在别的文件里，一路传 prop 下去不划算。拿不到动作
 * （任务正在跑、团队/研讨任务、只读视图）或这颗气泡还没落盘（没有出处）就一颗都不出。
 */
type DeleteMessage = (sources: ConversationSource[]) => Promise<void>;

const MessageDeleteContext = createContext<DeleteMessage | null>(null);

export function MessageDeleteProvider({ onDelete, children }: { onDelete?: DeleteMessage; children: ReactNode }) {
  return <MessageDeleteContext value={onDelete ?? null}>{children}</MessageDeleteContext>;
}

export function DeleteMessageButton({ item, label }: {
  item: ConversationItem;
  /** 尾栏那种描边胶囊要带字；气泡头部只有图标。 */
  label?: string;
}) {
  const remove = useContext(MessageDeleteContext);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!remove || !item.sources?.length) return null;
  const sources = item.sources;
  return (
    <>
      <button
        type="button"
        className={`message-delete-button${label ? " task-message-copy-action" : ""}`}
        aria-label="删除这条消息"
        onClick={(event) => {
          // 哨兵卡的按钮落在 <summary> 里，点击默认会连带开合整张卡。
          event.preventDefault();
          event.stopPropagation();
          setConfirming(true);
        }}
      >
        <Trash size={label ? 12 : 13} aria-hidden="true" />
        {label}
      </button>
      {confirming && (
        <ConfirmDialog
          title="删除这条消息？"
          message="删除后无法恢复，智能体之后也读不到它：下一轮会换一条新的会话，只带着删除后留下的记录继续。"
          confirmLabel="删除"
          danger
          busy={busy}
          onConfirm={() => {
            setBusy(true);
            void remove(sources).finally(() => {
              setBusy(false);
              setConfirming(false);
            });
          }}
          onClose={() => setConfirming(false)}
        />
      )}
    </>
  );
}
