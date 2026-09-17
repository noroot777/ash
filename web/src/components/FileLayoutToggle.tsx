import { CaretDown, CaretRight, ListBullets, TreeStructure } from "@phosphor-icons/react";
import { HoverTip, useHoverTip } from "./HoverTip.tsx";
import { FILE_LAYOUT_ACTION, useFileListLayout, type FileListLayout } from "../lib/fileLayout.ts";

// 平铺/目录树这对摆法在界面上共用的那点东西：切换按钮，和目录行左边那颗折叠角标。
// 数据侧（偏好存取、建树）在 `lib/fileLayout.ts`；各处清单的行长什么样，由各处自己画。

/**
 * 切换按钮。
 *
 * 图标画的是**按下去会变成的那种**（VSCode 工具栏的 View as Tree/List 也是这个约定）：
 * 当前是平铺就画树、当前是树就画列表，配合指上去那句话，不用先认出「现在是哪种」再推断。
 *
 * 自己拿偏好而不是从上面传：偏好本来就是全局一份，几处清单各摆一颗，靠
 * `useFileListLayout` 的广播保持一致（见那边的注释）。`className` 交给各处对齐自家的按钮
 * 尺寸——这颗按钮在窄面板、工作台工具条、审查页标题栏上长得并不一样。
 */
export function FileLayoutToggle({ className, size = 13 }: { className?: string; size?: number }) {
  const [layout, setLayout] = useFileListLayout();
  const tip = useHoverTip();
  const next: FileListLayout = layout === "tree" ? "flat" : "tree";
  const label = FILE_LAYOUT_ACTION[next];
  return (
    <>
      <button
        type="button"
        className={className ? `file-layout-toggle ${className}` : "file-layout-toggle"}
        aria-label={label}
        {...tip.anchorProps}
        onClick={() => { tip.hide(); setLayout(next); }}
      >
        {next === "tree" ? <TreeStructure size={size} /> : <ListBullets size={size} />}
      </button>
      <HoverTip at={tip.at}>{label}</HoverTip>
    </>
  );
}

/** 目录行左边那颗角标。展开/折叠两态各用一个图标，省一段只为转 90° 的 CSS。 */
export function FolderCaret({ collapsed, size = 10 }: { collapsed: boolean; size?: number }) {
  return collapsed
    ? <CaretRight size={size} weight="bold" aria-hidden="true" />
    : <CaretDown size={size} weight="bold" aria-hidden="true" />;
}
