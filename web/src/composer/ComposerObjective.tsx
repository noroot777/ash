import { useLayoutEffect, type ClipboardEventHandler, type KeyboardEvent, type RefObject } from "react";
import type { TaskMode } from "@ash/shared";
import { SlashMenu } from "../components/SlashMenu.tsx";
import { isMenuPickKeyEvent, isSendKeyEvent } from "../lib/sendKey.ts";
import type { SlashItem } from "../lib/useSkills.ts";

export function ComposerObjective({ body, mode, textareaRef, autoFocus = true, onEscape, onChange, onPaste, items, selected, token, onSelect, onPick, onDismiss, onSubmit, mention }: {
  body: string;
  autoFocus?: boolean;
  /** 没有菜单开着时的 Esc（首页拿它把光标交还给页面）。 */
  onEscape?: () => void;
  mode: TaskMode;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
  onPaste: ClipboardEventHandler<HTMLTextAreaElement>;
  items: SlashItem[];
  selected: number;
  token: string | null;
  onSelect: (index: number) => void;
  onPick: (item: SlashItem) => void;
  onDismiss: () => void;
  onSubmit: () => void;
  /** `@` 引用项目文件那一套：菜单自己画，键盘先给它过一手（返回 true = 已被吃掉）。 */
  mention?: { menu: React.ReactNode; onKeyDown: (event: KeyboardEvent) => boolean };
}) {
  // 起步三行，随内容长高（上限由样式的 max-height 管，到顶后框内滚动）。先清成 auto 再量，
  // 删字时才缩得回来。
  useLayoutEffect(() => {
    const area = textareaRef.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${area.scrollHeight}px`;
  }, [body, textareaRef]);
  return <div className="composer-objective">
    <textarea ref={textareaRef} autoFocus={autoFocus} rows={3} aria-label="任务目标" value={body} onPaste={onPaste}
      onChange={(event) => onChange(event.target.value)}
      placeholder={mode === "team" ? "想让团队完成什么？\n\n写下目标，剩下的交给团队。"
        : mode === "duet" ? "有什么想一起讨论？\n\n写下背景、方案，或一个还没想清楚的问题。" : "想完成什么？\n\n一个问题、一个想法，或一个完整的目标。"}
      onKeyDown={(event) => {
        // `/` 菜单开着时它优先（那是刚敲下的第一个字符）；否则交给 `@` 引用。
        if (!items.length && mention?.onKeyDown(event)) return;
        if (items.length) {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            onSelect((selected + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
            return;
          }
          if (isMenuPickKeyEvent(event)) {
            event.preventDefault(); onPick(items[selected]!); return;
          }
          if (event.key === "Escape") {
            event.preventDefault(); event.stopPropagation(); onDismiss(); return;
          }
        }
        if (isSendKeyEvent(event)) {
          event.preventDefault(); onSubmit();
          return;
        }
        if (event.key === "Escape" && onEscape && !event.nativeEvent.isComposing) {
          event.preventDefault(); onEscape();
        }
      }} />
    {!!items.length && <SlashMenu className="composer-slash-menu" ariaLabel="斜杠命令与技能"
      hint="↑↓ 选择，回车确认，Esc 关闭" items={items} selectedIndex={selected} token={token} onHover={onSelect} onPick={onPick} />}
    {!items.length && mention?.menu}
  </div>;
}
