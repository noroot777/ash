import { Fragment, useEffect, useRef } from "react";
import { SOURCE_LABEL, type SlashItem } from "../lib/useSkills.ts";

// 输入框敲 `/` 弹出来的那张菜单：回复框和新建任务共用一份。
//
// 排序是刻意的：**harness 自己的命令永远在最上面**，中间一条分隔线，下面才是这个
// CLI 已装的技能。前者换的是「谁来干这件事」（派生一个团队、一场讨论），后者只是
// 给当前这轮加一句提示词——点错的代价差着量级，不能让某个 CLI 装了个叫 team 的
// 技能就把它挤下去。
export function SlashMenu({
  className,
  ariaLabel,
  hint,
  items,
  selectedIndex,
  emptyText,
  onHover,
  onPick,
}: {
  className: string;
  ariaLabel: string;
  hint: string;
  items: SlashItem[];
  selectedIndex: number;
  emptyText?: string;
  onHover?: (index: number) => void;
  onPick: (item: SlashItem) => void;
}) {
  const firstSkillIndex = items.findIndex((item) => item.kind === "skill");
  const selectedRef = useRef<HTMLButtonElement>(null);
  // 技能多的机器上这张菜单是滚动的（本机 57 条），↑↓ 走到视野外必须自己跟着滚，
  // 否则选中项看不见 = 回车发出去的是什么全靠猜。
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  return (
    <div className={className} role="listbox" aria-label={ariaLabel}>
      <small>{hint}</small>
      {!items.length && emptyText && <p className="slash-menu-empty">{emptyText}</p>}
      {items.map((item, index) => (
        <Fragment key={`${item.kind}:${item.command}`}>
          {index === firstSkillIndex && firstSkillIndex > 0 && (
            <small className="slash-menu-divider">已装技能 · 发送时自动调用</small>
          )}
          <button
            ref={index === selectedIndex ? selectedRef : undefined}
            type="button"
            role="option"
            aria-selected={index === selectedIndex}
            onMouseEnter={() => onHover?.(index)}
            onClick={() => onPick(item)}
          >
            <b>{item.command}</b>
            {item.kind === "harness"
              ? <span>{item.label}</span>
              : <em>{item.label}</em>}
            {item.hint && <em>{item.hint}</em>}
            {item.source && <i className="slash-menu-tag">{SOURCE_LABEL[item.source]}</i>}
            {!!item.alsoIn?.length && (
              <i className="slash-menu-tag">{item.alsoIn.join("/")} 也有</i>
            )}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
