import { useCallback, useEffect, useState } from "react";
import type { ScmDiffTarget } from "../scm/scmModel.ts";

/**
 * 中间那一栏里「文件」这一块的开关：同一时刻要么摊一份文件全文，要么摊一份 diff。
 *
 * 之所以是一个 hook 而不是两个各管各的 `useState`：这两块内容**互为对方的另一种读法**。
 * 文件树里有颜色（git 有改动）的文件一律用对比打开——那是用户点它时真正想看的东西——
 * 但「看全文」不能因此没了入口，所以 diff 摊开时要记住回头路，两边互相能切。单飞任务和
 * 团队调度台的中间栏是同一套规矩，逻辑放在这儿，两边各自只接线。
 */
type FileViewState = {
  filePath: string | null;
  diff: ScmDiffTarget | null;
  /**
   * 从 diff 切到全文时留下的回头路。存整份 target 而不只是路径：同一个文件在暂存侧和
   * 工作树侧是两份不同的 diff，光有路径切不回原来那一份。
   */
  behind: ScmDiffTarget | null;
};

const CLOSED: FileViewState = { filePath: null, diff: null, behind: null };

export function useFileView(taskId: string) {
  const [state, setState] = useState<FileViewState>(CLOSED);

  useEffect(() => setState(CLOSED), [taskId]);

  // 全部走函数式更新，回调才能一直是同一个引用 —— 调用方会把它们塞进 effect 依赖和
  // inspector 的 context 里。
  const openFile = useCallback((path: string) => setState({ filePath: path, diff: null, behind: null }), []);
  const openDiff = useCallback((target: ScmDiffTarget) => setState({ filePath: null, diff: target, behind: null }), []);
  /** diff 视图里的「查看文件全文」。 */
  const showFile = useCallback(() => setState((current) => (
    current.diff ? { filePath: current.diff.path, diff: null, behind: current.diff } : current
  )), []);
  /** 全文视图里的「查看改动」，回到刚才那份 diff。 */
  const showDiff = useCallback(() => setState((current) => (
    current.behind ? { filePath: null, diff: current.behind, behind: null } : current
  )), []);
  const close = useCallback(() => setState(CLOSED), []);

  return {
    filePath: state.filePath,
    diff: state.diff,
    /** 文件树和改动列表里该高亮哪一行——摊的是 diff 还是全文，对它们来说是同一个文件。 */
    activePath: state.filePath ?? state.diff?.path ?? null,
    /** 全文视图能不能切回 diff：只有「从 diff 切过来的」那次才有回头路。 */
    canShowDiff: state.behind !== null,
    openFile,
    openDiff,
    showFile,
    showDiff,
    close,
  };
}

export type FileView = ReturnType<typeof useFileView>;
