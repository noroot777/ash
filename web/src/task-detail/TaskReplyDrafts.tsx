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
import type { UploadAttachment } from "./Attachments.tsx";

type TaskReplyDraft = {
  text: string;
  attachments: UploadAttachment[];
  pendingUploads: number;
};

type TaskReplyDraftContextValue = {
  drafts: Record<string, TaskReplyDraft>;
  updateDraft: (taskId: string, update: (current: TaskReplyDraft) => TaskReplyDraft) => void;
};

const EMPTY_DRAFT: TaskReplyDraft = { text: "", attachments: [], pendingUploads: 0 };
const TaskReplyDraftContext = createContext<TaskReplyDraftContextValue | null>(null);

export function TaskReplyDraftProvider({ children }: { children: ReactNode }) {
  const [drafts, setDrafts] = useState<Record<string, TaskReplyDraft>>({});
  const updateDraft = useCallback((taskId: string, update: (current: TaskReplyDraft) => TaskReplyDraft) => {
    setDrafts((current) => {
      const previous = current[taskId] ?? EMPTY_DRAFT;
      const next = update(previous);
      if (!next.text && next.attachments.length === 0 && next.pendingUploads === 0) {
        if (!(taskId in current)) return current;
        const { [taskId]: _removed, ...remaining } = current;
        return remaining;
      }
      if (next.text === previous.text
        && next.attachments === previous.attachments
        && next.pendingUploads === previous.pendingUploads) return current;
      return { ...current, [taskId]: next };
    });
  }, []);
  const value = useMemo(() => ({ drafts, updateDraft }), [drafts, updateDraft]);
  return <TaskReplyDraftContext.Provider value={value}>{children}</TaskReplyDraftContext.Provider>;
}

export function useTaskReplyDraft(taskId: string): {
  text: string;
  attachments: UploadAttachment[];
  pendingUploads: number;
  setText: Dispatch<SetStateAction<string>>;
  setAttachments: Dispatch<SetStateAction<UploadAttachment[]>>;
  setPendingUploads: Dispatch<SetStateAction<number>>;
} {
  const context = useContext(TaskReplyDraftContext);
  if (!context) throw new Error("useTaskReplyDraft must be used inside TaskReplyDraftProvider");
  const draft = context.drafts[taskId] ?? EMPTY_DRAFT;
  const setText = useCallback<Dispatch<SetStateAction<string>>>((next) => {
    context.updateDraft(taskId, (current) => ({
      ...current,
      text: typeof next === "function" ? next(current.text) : next,
    }));
  }, [context.updateDraft, taskId]);
  const setAttachments = useCallback<Dispatch<SetStateAction<UploadAttachment[]>>>((next) => {
    context.updateDraft(taskId, (current) => ({
      ...current,
      attachments: typeof next === "function" ? next(current.attachments) : next,
    }));
  }, [context.updateDraft, taskId]);
  const setPendingUploads = useCallback<Dispatch<SetStateAction<number>>>((next) => {
    context.updateDraft(taskId, (current) => ({
      ...current,
      pendingUploads: Math.max(0, typeof next === "function" ? next(current.pendingUploads) : next),
    }));
  }, [context.updateDraft, taskId]);
  return {
    text: draft.text,
    attachments: draft.attachments,
    pendingUploads: draft.pendingUploads,
    setText,
    setAttachments,
    setPendingUploads,
  };
}
