import { useState, type KeyboardEvent } from "react";
import type { SkillEntry } from "@ash/shared";
import { mergeSlashItems, slashToken, type SlashItem } from "./useSkills.ts";

// 输入框的 `/` 补全状态机。ReplyBox 和新建任务面板各有一堆自己的分支（派生命令、
// @召唤、定时发送），它们自己接；剩下那些「只是一个 textarea」的表面用这个，
// 免得把同一套 ↑↓/回车/Esc 抄第三遍第四遍。
//
// 只做补全：选中一条就是把 `/名字 ` 写进正文，ash 不改写、不截走。
export function useSlashCompletion({
  value,
  setValue,
  skills,
  ash = [],
  disabled,
}: {
  value: string;
  setValue: (next: string) => void;
  skills: SkillEntry[];
  ash?: SlashItem[];
  disabled?: boolean;
}) {
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  const token = disabled || dismissed ? null : slashToken(value);
  const items = mergeSlashItems(ash, skills, token);
  const selectedIndex = Math.min(index, Math.max(0, items.length - 1));
  const open = items.length > 0;

  const pick = (item: SlashItem) => {
    setValue(`${item.command} `);
    setIndex(0);
    setDismissed(false);
  };

  /** 接在 textarea 的 onChange 里：正文一变就重新判断要不要弹。 */
  const onValueChange = () => {
    setIndex(0);
    setDismissed(false);
  };

  /** 返回 true = 这个按键已经被菜单吃掉了，调用方不要再处理。 */
  const onKeyDown = (event: KeyboardEvent): boolean => {
    if (!open) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setIndex((selectedIndex + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
      return true;
    }
    if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      pick(items[selectedIndex]!);
      return true;
    }
    if (event.key === "Escape") {
      // 只关菜单。外层可能挂着「Esc 关闭整个面板」，别让它一起吃了。
      event.preventDefault();
      event.stopPropagation();
      setDismissed(true);
      return true;
    }
    return false;
  };

  return { open, items, selectedIndex, setIndex, pick, onKeyDown, onValueChange, token };
}
