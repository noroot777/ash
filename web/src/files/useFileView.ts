import { useCallback, useEffect, useState } from "react";
import type { ScmDiffTarget } from "../scm/scmModel.ts";

/**
 * 中间那一栏里「文件」这一块的开关：同一时刻摊一份文件全文、一份 diff，或者一个文件夹的
 * 详情。
 *
 * 之所以是一个 hook 而不是三个各管各的 `useState`：这几块内容**互为对方的另一种读法**。
 * 文件树里有颜色（git 有改动）的文件一律用对比打开——那是用户点它时真正想看的东西——
 * 但「看全文」不能因此没了入口，所以 diff 摊开时要记住回头路，两边互相能切；文件夹详情
 * 跟它们抢的是同一块位置（点开一个文件夹，上一份文件就该收起来）。单飞任务和团队调度台
 * 的中间栏是同一套规矩，逻辑放在这儿，两边各自只接线。
 */
type FileViewState = {
  filePath: string | null;
  /**
   * 这份文件是从哪一串里点开的（生成物的一组、文件夹或文件树里同一层的文件），按它在
   * 页面上的先后排。有它才翻得了上一张/下一张——看图本来就是一张接一张地看，而点开
   * 那一刻用户眼前是哪一串，只有点它的那个面板知道，所以由调用方随 `openFile` 一起给。
   *
   * 存的是**点开那一刻的快照**：生成物面板 8 秒轮询一次，跟着它变会让「3 / 13」在手底下
   * 跳号。要翻到新出现的那张，回列表里点一下就是新的一串。
   */
  reel: readonly string[] | null;
  /** 摊开的文件夹详情（`FolderViewer`）。和上面两个互斥。 */
  folderPath: string | null;
  diff: ScmDiffTarget | null;
  /**
   * 从 diff 切到全文时留下的回头路。存整份 target 而不只是路径：同一个文件在暂存侧和
   * 工作树侧是两份不同的 diff，光有路径切不回原来那一份。
   */
  behind: ScmDiffTarget | null;
  /**
   * 放大：铺满窗口、只让开右边的 inspector。挂在这儿而不是各自组件里，因为全文和 diff 是
   * 同一块内容的两种读法，互切时组件会换一个，状态留在组件里就会掉。放大态下右边的文件树
   * 照样点得到，所以换一个文件也接着放大；关掉这一块内容才退出。
   */
  zoomed: boolean;
};

const CLOSED: FileViewState = { filePath: null, reel: null, folderPath: null, diff: null, behind: null, zoomed: false };

export function useFileView(taskId: string) {
  const [state, setState] = useState<FileViewState>(CLOSED);

  useEffect(() => setState(CLOSED), [taskId]);

  // 全部走函数式更新，回调才能一直是同一个引用 —— 调用方会把它们塞进 effect 依赖和
  // inspector 的 context 里。
  const openFile = useCallback((path: string, reel?: readonly string[]) => setState((current) => (
    { filePath: path, reel: reel && reel.length > 1 ? reel : null, folderPath: null, diff: null, behind: null, zoomed: current.zoomed }
  )), []);
  const openFolder = useCallback((path: string) => setState((current) => (
    { filePath: null, reel: null, folderPath: path, diff: null, behind: null, zoomed: current.zoomed }
  )), []);
  const openDiff = useCallback((target: ScmDiffTarget) => setState((current) => (
    { filePath: null, reel: null, folderPath: null, diff: target, behind: null, zoomed: current.zoomed }
  )), []);
  /**
   * 在那一串里翻一格（左右箭头、顶栏的两颗按钮）。到头绕回另一端：翻图时「已经是最后
   * 一张了」不值得用一颗点不动的按钮去说，绕回去再翻一遍反而是大家都熟的手感。
   *
   * 留在 hook 里而不是让查看器自己 `openFile(下一张)`：那样每翻一格都要把整串再传一遍，
   * 传丢了就翻不动了。
   */
  const stepFile = useCallback((delta: number) => setState((current) => {
    const reel = current.reel;
    if (!current.filePath || !reel?.length) return current;
    const at = reel.indexOf(current.filePath);
    if (at < 0) return current;
    const next = reel[(at + delta % reel.length + reel.length) % reel.length];
    if (!next || next === current.filePath) return current;
    // `behind`（切回 diff 的回头路）是上一份文件的，翻走就不成立了。
    return { ...current, filePath: next, behind: null };
  }), []);
  /** diff 视图里的「查看文件全文」。 */
  const showFile = useCallback(() => setState((current) => (
    current.diff
      ? { filePath: current.diff.path, reel: null, folderPath: null, diff: null, behind: current.diff, zoomed: current.zoomed }
      : current
  )), []);
  /** 全文视图里的「查看改动」，回到刚才那份 diff。 */
  const showDiff = useCallback(() => setState((current) => (
    current.behind
      ? { filePath: null, reel: null, folderPath: null, diff: current.behind, behind: null, zoomed: current.zoomed }
      : current
  )), []);
  const toggleZoom = useCallback(() => setState((current) => ({ ...current, zoomed: !current.zoomed })), []);
  const exitZoom = useCallback(() => setState((current) => (current.zoomed ? { ...current, zoomed: false } : current)), []);
  const close = useCallback(() => setState(CLOSED), []);

  return {
    filePath: state.filePath,
    /** 当前这份文件所在的那一串（同一组生成物、同一层文件）；只有一个的时候是 null。 */
    reel: state.reel,
    folderPath: state.folderPath,
    diff: state.diff,
    /** 文件树和改动列表里该高亮哪一行——摊的是 diff、全文还是文件夹，对它们来说是同一个路径。 */
    activePath: state.filePath ?? state.diff?.path ?? state.folderPath ?? null,
    /** 全文视图能不能切回 diff：只有「从 diff 切过来的」那次才有回头路。 */
    canShowDiff: state.behind !== null,
    zoomed: state.zoomed,
    openFile,
    openFolder,
    openDiff,
    stepFile,
    showFile,
    showDiff,
    toggleZoom,
    exitZoom,
    close,
  };
}

export type FileView = ReturnType<typeof useFileView>;
