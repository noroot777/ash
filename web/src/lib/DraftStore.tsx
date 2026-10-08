import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { UploadAttachment, UploadingFile } from "../task-detail/Attachments.tsx";
import type { ScreenshotDraft } from "../page-annotation/model.ts";

// 「还没发出去的那份东西」统一放这里：对话框的回复草稿、主工作区新建任务框里的草稿，
// 都是同一件事 —— 组件卸载（切任务、去设置、开聊天）不该把用户敲的字和粘的图弄丢。
// 存活范围是**这一次会话**（provider 挂在 App 上），刷新页面即清空，跟对话框一致。
// Draft 对象是**不可变**的:updateDraft 对任何实际变化都返回新对象、没变化保留原
// 对象引用(见下方判等)。对象引用因此可以当「这份草稿的版本标识」用——异步收尾
// 拿提交时刻的引用对比此刻的,引用相同 ⇔ 期间任何字段(正文、附件、在途上传、
// 回链、截图)都没动过,改过又改回也算动过。clearIfUnchanged 靠这一点做原子的
// 归属裁决。
export type Draft = {
  screenshot?: ScreenshotDraft | null;
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
  readDraft: (key: string) => Draft;
};

const EMPTY_DRAFT: Draft = { text: "", attachments: [], pendingUploads: [], noteIds: [] };
const DraftContext = createContext<DraftContextValue | null>(null);

/** 一条草稿的存放位置。任务回复按任务分，新建任务框按项目分 —— 两边不会互相盖。 */
export const replyDraftKey = (taskId: string) => `reply:${taskId}`;
export const composerDraftKey = (projectId: string) => `composer:${projectId}`;

export function DraftProvider({ children }: { children: ReactNode }) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  // 异步提交的收尾(发送/创建完成)读「此刻」的草稿,不能用发起那一刻的闭包值:
  // 组件可能早已卸载、草稿可能已被后来打开的面板改写。ref 镜像给 readDraft 用。
  const draftsRef = useRef(drafts);
  useEffect(() => { draftsRef.current = drafts; }, [drafts]);
  const readDraft = useCallback((key: string) => draftsRef.current[key] ?? EMPTY_DRAFT, []);
  const updateDraft = useCallback((key: string, update: (current: Draft) => Draft) => {
    setDrafts((current) => {
      const previous = current[key] ?? EMPTY_DRAFT;
      const next = update(previous);
      if (!next.text && next.attachments.length === 0 && next.pendingUploads.length === 0
        && next.noteIds.length === 0 && !next.screenshot) {
        if (!(key in current)) return current;
        const { [key]: _removed, ...remaining } = current;
        return remaining;
      }
      if (next.text === previous.text
        && next.attachments === previous.attachments
        && next.pendingUploads === previous.pendingUploads
        && next.noteIds === previous.noteIds
        && next.screenshot === previous.screenshot) return current;
      return { ...current, [key]: next };
    });
  }, []);
  const value = useMemo(() => ({ drafts, updateDraft, readDraft }), [drafts, updateDraft, readDraft]);
  return <DraftContext.Provider value={value}>{children}</DraftContext.Provider>;
}

export type DraftHandle = {
  screenshot: ScreenshotDraft | null;
  setScreenshot: Dispatch<SetStateAction<ScreenshotDraft | null>>;
  text: string;
  attachments: UploadAttachment[];
  pendingUploads: UploadingFile[];
  noteIds: string[];
  setText: Dispatch<SetStateAction<string>>;
  setAttachments: Dispatch<SetStateAction<UploadAttachment[]>>;
  setPendingUploads: Dispatch<SetStateAction<UploadingFile[]>>;
  setNoteIds: Dispatch<SetStateAction<string[]>>;
  /** 此刻这份草稿的不可变对象(引用即版本标识,提交时捕获、收尾时对比归属)。 */
  value: Draft;
  /**
   * 只有草稿自提交那一刻起**完全没动过**(对象引用相同)才整份丢掉——异步创建的
   * 收尾在面板卸载后用它,任何字段变化(附件增删、在途上传、正文改过又改回)都让
   * 旧提交失去清空资格(第 10 轮审查:只比正文和回链漏掉了附件)。判定与清空在
   * Store 更新处一次完成,纯函数,无竞态窗口。不掐在途上传:提交门禁保证提交时
   * 没有在途,引用没变 ⇒ 此刻也没有。
   */
  clearIfUnchanged: (submitted: Draft) => void;
  /** 整份丢掉（发送/创建成功，或用户自己按了「清空」）。 */
  clear: () => void;
};

export function useDraft(key: string): DraftHandle {
  const context = useContext(DraftContext);
  if (!context) throw new Error("useDraft must be used inside DraftProvider");
  const draft = context.drafts[key] ?? EMPTY_DRAFT;
  const { updateDraft, readDraft } = context;
  const setScreenshot = useCallback<Dispatch<SetStateAction<ScreenshotDraft | null>>>((next) => {
    updateDraft(key, (current) => ({
      ...current,
      screenshot: typeof next === "function" ? next(current.screenshot ?? null) : next,
    }));
  }, [key, updateDraft]);
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
  const clearIfUnchanged = useCallback((submitted: Draft) => {
    updateDraft(key, (current) => (current === submitted ? EMPTY_DRAFT : current));
  }, [key, updateDraft]);
  // 在途上传一并掐掉：清空之后那几张图再传完也没有地方落，进度条却还挂在别处跑。
  // 按 Store 此刻的在途清单掐,不是 handle 创建那一刻的——clear 常在异步收尾里被调。
  const clear = useCallback(() => {
    for (const pending of readDraft(key).pendingUploads) pending.abort();
    updateDraft(key, () => EMPTY_DRAFT);
  }, [key, readDraft, updateDraft]);
  return {
    screenshot: draft.screenshot ?? null,
    setScreenshot,
    text: draft.text,
    attachments: draft.attachments,
    pendingUploads: draft.pendingUploads,
    noteIds: draft.noteIds,
    setText,
    setAttachments,
    setPendingUploads,
    setNoteIds,
    value: draft,
    clearIfUnchanged,
    clear,
  };
}

export function useTaskReplyDraft(taskId: string): DraftHandle {
  return useDraft(replyDraftKey(taskId));
}
