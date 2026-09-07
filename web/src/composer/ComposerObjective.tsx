import type { ClipboardEventHandler, RefObject } from "react";
import type { TaskMode } from "@ash/shared";
import { SlashMenu } from "../components/SlashMenu.tsx";
import type { SlashItem } from "../lib/useSkills.ts";

export function ComposerObjective({ body, mode, textareaRef, onChange, onPaste, items, selected, token, onSelect, onPick, onDismiss, onSubmit }: {
  body: string;
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
}) {
  return <div className="composer-objective">
    <textarea ref={textareaRef} autoFocus aria-label="任务目标" value={body} onPaste={onPaste}
      onChange={(event) => onChange(event.target.value)}
      placeholder={mode === "team" ? "给调度者的目标…（可输入 /single 或 /duet 切换）"
        : mode === "duet" ? "要讨论并形成结论的议题…" : "想完成什么？\n\n可以描述一个问题，也可以交代一个完整目标。输入 / 调用技能。"}
      onKeyDown={(event) => {
        if (items.length) {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            onSelect((selected + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
            return;
          }
          if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
            event.preventDefault(); onPick(items[selected]!); return;
          }
          if (event.key === "Escape") {
            event.preventDefault(); event.stopPropagation(); onDismiss(); return;
          }
        }
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault(); onSubmit();
        }
      }} />
    {!!items.length && <SlashMenu className="composer-slash-menu" ariaLabel="斜杠命令与技能"
      hint="↑↓ 选择，回车确认，Esc 关闭" items={items} selectedIndex={selected} token={token} onHover={onSelect} onPick={onPick} />}
  </div>;
}
