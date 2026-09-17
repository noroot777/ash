import type { CSSProperties, ReactNode } from "react";
import { CaretDown, CaretRight, ListBullets, TreeStructure } from "@phosphor-icons/react";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { SCM_FILE_LAYOUT_ACTION, useScmFileLayout, type ScmFileLayout } from "./scmFileTree.ts";

// 平铺/目录树这两种摆法共用的那点界面：切换按钮、目录行、缩进。
// 数据侧（偏好存取、建树）在 `scmFileTree.ts`。

/**
 * 切换按钮。
 *
 * 图标画的是**按下去会变成的那种**（VSCode 工具栏的 View as Tree/List 也是这个约定）：
 * 当前是平铺就画树、当前是树就画列表，配合指上去那句话，不用先认出「现在是哪种」再推断。
 *
 * 自己拿偏好而不是从上面传：偏好本来就是全局一份，面板里两处入口各自用这个组件，靠
 * `useScmFileLayout` 的广播保持一致（见那边的注释）。
 */
export function ScmFileLayoutToggle({ className }: { className?: string }) {
  const [layout, setLayout] = useScmFileLayout();
  const tip = useHoverTip();
  const next: ScmFileLayout = layout === "tree" ? "flat" : "tree";
  const label = SCM_FILE_LAYOUT_ACTION[next];
  return (
    <>
      <button
        type="button"
        className={className ? `scm-layout-toggle ${className}` : "scm-layout-toggle"}
        aria-label={label}
        {...tip.anchorProps}
        onClick={() => { tip.hide(); setLayout(next); }}
      >
        {next === "tree" ? <TreeStructure size={13} /> : <ListBullets size={13} />}
      </button>
      <HoverTip at={tip.at}>{label}</HoverTip>
    </>
  );
}

/** 缩进走 CSS 变量而不是内联 padding：每一节的基准内边距不同（上半截 9px、已提交那节 4px）。 */
export function indentStyle(depth: number): CSSProperties {
  return { "--scm-indent": `${depth * 11}px` } as CSSProperties;
}

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
          {collapsed ? <CaretRight size={10} weight="bold" /> : <CaretDown size={10} weight="bold" />}
          <span className="scm-row__folder">{label}</span>
          <span className="scm-row__folder-count">{count}</span>
        </button>
        {children}
      </div>
    </li>
  );
}
