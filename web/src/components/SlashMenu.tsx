import { Fragment, useEffect, useRef } from "react";
import { SOURCE_LABEL, type SlashItem } from "../lib/useSkills.ts";
import { slashMatchIndex } from "../lib/slashMatch.ts";

// 输入框敲 `/` 弹出来的那张菜单：回复框和新建任务共用一份。
//
// 排序是刻意的：**ash 自己的命令永远在最上面**，中间一条分隔线，下面才是这个
// CLI 已装的技能。前者换的是「谁来干这件事」（派生一个团队、一场讨论），后者只是
// 给当前这轮加一句提示词——点错的代价差着量级，不能让某个 CLI 装了个叫 team 的
// 技能就把它挤下去。

/** 命中的那几个字标出来：子串匹配下命中常在名字中段，不标就看不出这条为什么在列表里。 */
function CommandText({ command, token }: { command: string; token?: string | null }) {
  const needle = token ? token.replace(/^\/+/, "") : "";
  const at = needle ? slashMatchIndex(command, token!) : -1;
  // 匹配是在剥掉斜杠的串上算的，画回原串要把斜杠补回去。
  const start = at < 0 ? -1 : at + command.length - command.replace(/^\/+/, "").length;
  if (start < 0) return <b className="slash-menu-command">{command}</b>;
  return (
    <b className="slash-menu-command">
      {command.slice(0, start)}
      <mark className="slash-menu-hit">{command.slice(start, start + needle.length)}</mark>
      {command.slice(start + needle.length)}
    </b>
  );
}

export function SlashMenu({
  className,
  ariaLabel,
  hint,
  items,
  selectedIndex,
  token,
  onHover,
  onPick,
}: {
  className: string;
  ariaLabel: string;
  hint: string;
  items: SlashItem[];
  selectedIndex: number;
  /** 正在敲的斜杠 token，用来标出命中的那几个字；不给就不标。 */
  token?: string | null;
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
            <CommandText command={item.command} token={token} />
            {item.kind === "ash"
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
