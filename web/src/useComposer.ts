import { useCallback, useState } from "react";
import type { ComposerMode } from "./composer/modes";
import type { NoteTaskDraft } from "./NotesModal";

export type ComposerState = {
  // 重新播种用的 key：只有真的换了一份种子正文才 +1，否则重挂会把用户填的东西冲掉。
  seq: number;
  mode: ComposerMode;
  draft: NoteTaskDraft | null;
  // 打开 composer 前选中的任务；取消时切回去。
  returnTo: string | null;
};

// 内嵌新建面板的开关与种子内容。抽出来是因为它有三条入口（按钮/C 键、⌘K 新建辩论、
// 随手记合并建任务），三条都要遵守同一条规矩：**已经开着时绝不冲掉用户填的内容**，
// 只换模式（切 tab 本身不丢正文），除非来的是一份新的种子正文。
export function useComposer() {
  const [composer, setComposer] = useState<ComposerState | null>(null);

  const openComposer = useCallback(
    (mode: ComposerMode, opts?: { draft?: NoteTaskDraft; returnTo?: string | null }) =>
      setComposer((cur) => {
        if (!cur) return { seq: 0, mode, draft: opts?.draft ?? null, returnTo: opts?.returnTo ?? null };
        if (!opts?.draft) return cur.mode === mode ? cur : { ...cur, mode };
        return { seq: cur.seq + 1, mode, draft: opts.draft, returnTo: cur.returnTo };
      }),
    [],
  );
  const setComposerMode = useCallback(
    (mode: ComposerMode) => setComposer((cur) => (cur ? { ...cur, mode } : cur)),
    [],
  );
  const closeComposer = useCallback(() => setComposer(null), []);
  // 种子随手记只该回链第一个任务：开着「再建一个」时后面几个不再重复关联。
  const clearComposerDraft = useCallback(
    () => setComposer((cur) => (cur && cur.draft ? { ...cur, draft: null } : cur)),
    [],
  );

  return { composer, openComposer, setComposerMode, closeComposer, clearComposerDraft };
}
