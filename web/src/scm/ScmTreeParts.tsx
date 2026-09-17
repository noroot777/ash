import type { ReactNode } from "react";
import { FolderCaret } from "../components/FileLayoutToggle.tsx";
import { indentStyle } from "../lib/fileLayout.ts";

// SCM 面板（任务 inspector 的「改动」）里的目录行。通用的那半——偏好、建树、切换按钮——
// 在 `lib/fileLayout.ts` 和 `components/FileLayoutToggle.tsx`，几处清单共用。

/**
 * 一行目录。右侧 `children` 留给各清单自己——工作区分组摆整目录的批量操作，「已提交的
 * 改动」摆这个目录下的加减行数合计。
 */
export function ScmDirRow({
  label,
  count,
  depth,
  collapsed,
  onToggle,
  children,
}: {
  label: string;
  count: number;
  depth: number;
  collapsed: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  return (
    <li>
      <div className="scm-row scm-row--dir" style={indentStyle(depth)}>
        <button
          type="button"
          className="scm-row__open"
          aria-expanded={!collapsed}
          aria-label={`${label}（${count} 个文件）`}
          onClick={onToggle}
        >
          <FolderCaret collapsed={collapsed} />
          <span className="scm-row__folder">{label}</span>
          <span className="scm-row__folder-count">{count}</span>
        </button>
        {children}
      </div>
    </li>
  );
}
