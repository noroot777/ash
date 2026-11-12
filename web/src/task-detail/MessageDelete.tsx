import { createContext, useContext, useState, type ReactNode } from "react";
import { Trash } from "@phosphor-icons/react";
import type { ConversationSource } from "./conversationModel.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/**
 * 删掉一条消息（真人的、agent 的、哨兵的自动输入）。
 *
 * 由会话页给出删除动作（`ConversationFeed` 的 `onDeleteMessage`），气泡里的按钮从上下文
 * 取 —— 哨兵输入卡、系统代发卡、答复卡、系统注记都住在别的文件里，一路传 prop 下去不划算。拿不到动作
 * （任务正在跑、团队/研讨任务、只读视图）或这颗气泡还没落盘（没有出处）就一颗都不出。
 */
type DeleteMessage = (sources: ConversationSource[]) => Promise<void>;

const MessageDeleteContext = createContext<DeleteMessage | null>(null);

export function MessageDeleteProvider({ onDelete, children }: { onDelete?: DeleteMessage; children: ReactNode }) {
  return <MessageDeleteContext value={onDelete ?? null}>{children}</MessageDeleteContext>;
}

/** 有出处的那几种气泡（会话里的一段，或一段只有执行过程的 trace）。 */
export type DeletableItem = { sources?: ConversationSource[] };

/**
 * 删除这一条要走的那一步：有没有得删、发起删除、以及那张确认框。按钮之外的入口
 * （回合尾「更多」里的一项）用它，确认框和删除动作跟按钮是同一份。
 */
export function useMessageDelete(item: DeletableItem) {
  const remove = useContext(MessageDeleteContext);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const sources = item.sources;
  const available = !!remove && !!sources?.length;
  const dialog = available && confirming ? (
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
  ) : null;
  return { available, request: () => setConfirming(true), dialog };
}

export function DeleteMessageButton({ item, label }: {
  item: DeletableItem;
  /** 尾栏那种描边胶囊要带字；气泡头部只有图标。 */
  label?: string;
}) {
  const remove = useMessageDelete(item);
  if (!remove.available) return null;
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
          remove.request();
        }}
      >
        <Trash size={label ? 12 : 13} aria-hidden="true" />
        {label}
      </button>
      {remove.dialog}
    </>
  );
}
