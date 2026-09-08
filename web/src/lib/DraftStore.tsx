import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { UploadAttachment, UploadingFile } from "../task-detail/Attachments.tsx";

// 「还没发出去的那份东西」统一放这里：对话框的回复草稿、主工作区新建任务框里的草稿，
// 都是同一件事 —— 组件卸载（切任务、去设置、开聊天）不该把用户敲的字和粘的图弄丢。
// 存活范围是**这一次会话**（provider 挂在 App 上），刷新页面即清空，跟对话框一致。
type Draft = {
  text: string;
  attachments: UploadAttachment[];
  // 在途上传也留在草稿里：切走再切回来，那张图该还在传、进度条该接着走。
  pendingUploads: UploadingFile[];
  // 新建任务框专用：正文来自随手记时，创建成功后要把任务 id 回写给这几条随手记。
  // 它跟着草稿一起活，所以「转任务 → 中途去看别的 → 回来再创建」的回链不会断。
  noteIds: string[];
};

type DraftContextValue = {
  drafts: Record<string, Draft>;
  updateDraft: (key: string, update: (current: Draft) => Draft) => void;
};

const EMPTY_DRAFT: Draft = { text: "", attachments: [], pendingUploads: [], noteIds: [] };
const DraftContext = createContext<DraftContextValue | null>(null);

/** 一条草稿的存放位置。任务回复按任务分，新建任务框按项目分 —— 两边不会互相盖。 */
export const replyDraftKey = (taskId: string) => `reply:${taskId}`;
export const composerDraftKey = (projectId: string) => `composer:${projectId}`;

export function DraftProvider({ children }: { children: ReactNode }) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const updateDraft = useCallback((key: string, update: (current: Draft) => Draft) => {
    setDrafts((current) => {
      const previous = current[key] ?? EMPTY_DRAFT;
      const next = update(previous);
      if (!next.text && next.attachments.length === 0 && next.pendingUploads.length === 0
        && next.noteIds.length === 0) {
        if (!(key in current)) return current;
        const { [key]: _removed, ...remaining } = current;
        return remaining;
      }
      if (next.text === previous.text
        && next.attachments === previous.attachments
        && next.pendingUploads === previous.pendingUploads
        && next.noteIds === previous.noteIds) return current;
      return { ...current, [key]: next };
    });
  }, []);
  const value = useMemo(() => ({ drafts, updateDraft }), [drafts, updateDraft]);
  return <DraftContext.Provider value={value}>{children}</DraftContext.Provider>;
}

export type DraftHandle = {
  text: string;
  attachments: UploadAttachment[];
  pendingUploads: UploadingFile[];
  noteIds: string[];
  setText: Dispatch<SetStateAction<string>>;
  setAttachments: Dispatch<SetStateAction<UploadAttachment[]>>;
  setPendingUploads: Dispatch<SetStateAction<UploadingFile[]>>;
  setNoteIds: Dispatch<SetStateAction<string[]>>;
  /** 整份丢掉（发送/创建成功，或用户自己按了「清空」）。 */
  clear: () => void;
};

export function useDraft(key: string): DraftHandle {
  const context = useContext(DraftContext);
  if (!context) throw new Error("useDraft must be used inside DraftProvider");
  const draft = context.drafts[key] ?? EMPTY_DRAFT;
  const { updateDraft } = context;
  const setText = useCallback<Dispatch<SetStateAction<string>>>((next) => {
    updateDraft(key, (current) => ({
      ...current,
      text: typeof next === "function" ? next(current.text) : next,
    }));
  }, [key, updateDraft]);
  const setAttachments = useCallback<Dispatch<SetStateAction<UploadAttachment[]>>>((next) => {
    updateDraft(key, (current) => ({
      ...current,
      attachments: typeof next === "function" ? next(current.attachments) : next,
    }));
  }, [key, updateDraft]);
  const setPendingUploads = useCallback<Dispatch<SetStateAction<UploadingFile[]>>>((next) => {
    updateDraft(key, (current) => ({
      ...current,
      pendingUploads: typeof next === "function" ? next(current.pendingUploads) : next,
    }));
  }, [key, updateDraft]);
  const setNoteIds = useCallback<Dispatch<SetStateAction<string[]>>>((next) => {
    updateDraft(key, (current) => ({
      ...current,
      noteIds: typeof next === "function" ? next(current.noteIds) : next,
    }));
  }, [key, updateDraft]);
  // 在途上传一并掐掉：清空之后那几张图再传完也没有地方落，进度条却还挂在别处跑。
  const clear = useCallback(() => {
    for (const pending of draft.pendingUploads) pending.abort();
    updateDraft(key, () => EMPTY_DRAFT);
  }, [draft.pendingUploads, key, updateDraft]);
  return {
    text: draft.text,
    attachments: draft.attachments,
    pendingUploads: draft.pendingUploads,
    noteIds: draft.noteIds,
    setText,
    setAttachments,
    setPendingUploads,
    setNoteIds,
    clear,
  };
}

export function useTaskReplyDraft(taskId: string): DraftHandle {
  return useDraft(replyDraftKey(taskId));
}
