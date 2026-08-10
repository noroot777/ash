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
};

type TaskReplyDraftContextValue = {
  drafts: Record<string, TaskReplyDraft>;
  updateDraft: (taskId: string, update: (current: TaskReplyDraft) => TaskReplyDraft) => void;
};

const EMPTY_DRAFT: TaskReplyDraft = { text: "", attachments: [] };
const TaskReplyDraftContext = createContext<TaskReplyDraftContextValue | null>(null);

export function TaskReplyDraftProvider({ children }: { children: ReactNode }) {
  const [drafts, setDrafts] = useState<Record<string, TaskReplyDraft>>({});
  const updateDraft = useCallback((taskId: string, update: (current: TaskReplyDraft) => TaskReplyDraft) => {
    setDrafts((current) => {
      const previous = current[taskId] ?? EMPTY_DRAFT;
      const next = update(previous);
      if (!next.text && next.attachments.length === 0) {
        if (!(taskId in current)) return current;
        const { [taskId]: _removed, ...remaining } = current;
        return remaining;
      }
      if (next.text === previous.text && next.attachments === previous.attachments) return current;
      return { ...current, [taskId]: next };
    });
  }, []);
  const value = useMemo(() => ({ drafts, updateDraft }), [drafts, updateDraft]);
  return <TaskReplyDraftContext.Provider value={value}>{children}</TaskReplyDraftContext.Provider>;
}

export function useTaskReplyDraft(taskId: string): {
  text: string;
  attachments: UploadAttachment[];
  setText: Dispatch<SetStateAction<string>>;
  setAttachments: Dispatch<SetStateAction<UploadAttachment[]>>;
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
  return { text: draft.text, attachments: draft.attachments, setText, setAttachments };
}
