import { useState, type KeyboardEvent, type RefObject } from "react";
import type { SkillEntry } from "@navi/shared";
import { isMenuPickKeyEvent } from "../lib/sendKey.ts";
import { useCaret } from "../lib/useCaret.ts";
import { mergeSlashItems, removeSlashToken, slashPickAt, slashQuery, slashSendsAsTyped, type SlashItem } from "../lib/useSkills.ts";
import { callCommandVerb, type CallVerb } from "./replyCall.ts";

/**
 * 回复框的斜杠菜单：按**光标前**那个斜杠认（开头、句中、引用块后面、文末都弹），叫人的命令（`/讨论`、`/派`）
 * 和技能、原生命令同一张菜单。从 ReplyBox 拆出来守它的 700 行。
 *
 * 选中技能 / 原生命令：只换掉那个 token，前后的字原样留着（技能是补全，server 运行前据此注入 SKILL.md）。
 * 选中叫人的命令：**只拿掉命令本身**，前后的话和引用都留着，交给 `onCall` 叫人。文中敲全了 `/派` 却没从菜单里
 * 选、接着往下写的，是普通正文——用户会在话里提到这个命令，那句话得能原样发出去。
 */
export function useReplySlash({ value, setValue, navi, skills, blocked, sendable = true, inputRef, onCall }: {
  value: string;
  setValue: (next: string) => void;
  navi: SlashItem[];
  skills: SkillEntry[];
  /** 此刻不弹（框被借用着、答题卡盖着）。 */
  blocked: boolean;
  /** 框里这些字此刻发得出去；发不出去时敲全了的原生命令回车也只是补全，好接着写参数。 */
  sendable?: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** 选中叫人的命令：`text` 是拿掉命令之后的正文，光标该停在 `caret`。 */
  onCall: (verb: CallVerb, text: string, caret: number) => void;
}) {
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const caret = useCaret(value);
  const query = blocked || dismissed || caret.at === null ? null : slashQuery(value, caret.at);
  const candidates = mergeSlashItems(navi, skills, query);
  const open = candidates.length > 0;
  const selectedIndex = Math.min(index, Math.max(0, candidates.length - 1));
  const selected = candidates[selectedIndex];
  // 回车做什么：原生命令已经敲全就直接发（它本来就是发给 CLI 的一句话）；技能和原生命令补全进正文；叫人的命令叫人。
  const sends = open && sendable && slashSendsAsTyped(selected, value);
  const completes = open && !sends && selected?.kind !== "navi";
  const reset = () => {
    setIndex(0);
    setDismissed(false);
  };

  const pick = (item: SlashItem) => {
    reset();
    const verb = item.kind === "navi" ? callCommandVerb(item.command) : null;
    if (verb) {
      const next = query ? removeSlashToken(value, query) : { text: value, caret: value.length };
      onCall(verb, next.text, next.caret);
      return;
    }
    const next = slashPickAt(value, item.command, caret.at ?? value.length);
    setValue(next.text);
    caret.place(inputRef.current, next.text, next.caret);
  };

  /** 菜单开着时的按键；接走了给 true。`send` = 回车直接发，`clear` = 整个框只有这个命令时 Esc 清掉它。 */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>, send: () => void, clear: () => void): boolean => {
    if (!open) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setIndex((selectedIndex + (event.key === "ArrowDown" ? 1 : candidates.length - 1)) % candidates.length);
      return true;
    }
    if (isMenuPickKeyEvent(event)) {
      event.preventDefault();
      if (sends) send();
      else pick(selected!);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      // 斜杠接在已写好的正文里时只收起菜单：那是在给这句话点技能，整段清空等于把用户写的话扔了。
      if (query?.leading && !value.slice(query.end).trim()) clear();
      setDismissed(true);
      return true;
    }
    return false;
  };

  return { open, candidates, selectedIndex, selected, sends, completes, setIndex, pick, onKeyDown, reset, token: query?.token ?? null, caret };
}
