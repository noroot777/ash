import { useCallback, useState } from "react";
import { api, type FileEntryOverview } from "../lib/api.ts";
import { DeleteEntryDialog } from "./DeleteEntryDialog.tsx";
import { fileTreeChanged } from "./fileModel.ts";

/**
 * 「按下删除」到「东西真没了」之间的那段流程，文件视图和文件夹详情页共用。
 *
 * 为什么点下去才拉 overview：确认框里要说的每一句（多大、几个未跟踪、此刻有没有人在写
 * 这个目录）都是**会变的**，提前拉一份放着，用户点的时候它已经旧了。一次点击等一下
 * 值得，何况按钮上会显示在准备。
 *
 * 只读（归档 / 回落主仓 / 预览实例）不弹框，直接把后端那句理由说出来——让用户在框里点到
 * 一半才发现不能删，比一开始就说更难受。
 */
export function useDeleteEntry({
  taskId,
  notify,
  onDeleted,
}: {
  taskId: string;
  notify: (message: string) => void;
  /** 删成功了：调用方负责把这块内容收起来（被删的东西没了，不能继续摊着）。 */
  onDeleted: (result: { path: string; kind: "dir" | "file" }) => void;
}) {
  const [preparing, setPreparing] = useState<string | null>(null);
  const [overview, setOverview] = useState<FileEntryOverview | null>(null);

  const ask = useCallback(async (path: string) => {
    setPreparing(path);
    try {
      const fresh = await api.taskFileOverview(taskId, path);
      if (fresh.readOnly) {
        notify(fresh.readOnly);
        return;
      }
      setOverview(fresh);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPreparing(null);
    }
  }, [notify, taskId]);

  const dialog = overview ? (
    <DeleteEntryDialog
      taskId={taskId}
      overview={overview}
      onClose={() => setOverview(null)}
      onDeleted={(result) => {
        const path = overview.target.path;
        setOverview(null);
        // 树上那一行必须当场消失，不等 5 秒轮询。
        fileTreeChanged(taskId);
        const scope = result.kind === "dir"
          ? `${result.name}/（${result.files.toLocaleString()} 个文件）`
          : result.name;
        notify(result.mode === "trash" ? `已把 ${scope} 移到废纸篓` : `已删除 ${scope}`);
        onDeleted({ path, kind: result.kind });
      }}
    />
  ) : null;

  return { ask, preparing, dialog };
}
