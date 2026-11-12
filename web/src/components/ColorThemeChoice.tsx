import { useRef, useState } from "react";
import type { ColorTheme } from "@ash/shared";
import { Check, Desktop, Moon, Sun } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import { useColorTheme } from "../lib/useColorTheme.ts";
import { useDismissable } from "../lib/useDismissable.ts";
import { useRovingChoice } from "../lib/useRovingChoice.ts";
import { HoverTip, useHoverTip } from "./HoverTip.tsx";

// 深浅色的三档。设置页「外观」卡摆一排分段（ColorThemeChoice），侧栏最底下那一行摆一颗
// 画着当前那一档的图标、点开三选一（ColorThemeMenu）—— 长相两副，档位和存法共用这一份：
// 两处各写一遍的话，迟早一处改了档位另一处没跟上。
//
// 自己读、自己存，不从上面传值：偏好本来就是全站一份(lib/theme.ts),点下去由
// settingsSync 立刻把在途的那一档推给 theme.ts,页面当场翻面;保存失败时它退回服务端
// 确认过的那一档，这颗开关跟着退，所以这里不另设「保存中」。

export const COLOR_THEME_CHOICES: { value: ColorTheme; label: string; icon: typeof Sun }[] = [
  { value: "system", label: "跟随系统", icon: Desktop },
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
];
const VALUES = COLOR_THEME_CHOICES.map((choice) => choice.value);

function useColorThemePick(notify: (message: string) => void) {
  const { preference } = useColorTheme();
  const pick = (next: ColorTheme) => {
    if (next === preference) return;
    api.patchSettings({ colorTheme: next }).catch((error) =>
      notify(error instanceof Error ? error.message : "配色保存失败"));
  };
  return { preference, pick };
}

export function ColorThemeChoice({ notify, className }: {
  notify: (message: string) => void;
  className?: string;
}) {
  const { preference, pick } = useColorThemePick(notify);
  const { groupProps, itemProps } = useRovingChoice(VALUES, preference, pick);
  return (
    <div className={`ui-tabs color-theme-choice${className ? ` ${className}` : ""}`} {...groupProps} aria-label="配色">
      {COLOR_THEME_CHOICES.map(({ value, label, icon: Icon }) => (
        <button key={value} type="button" {...itemProps(value)} onClick={() => pick(value)}>
          <Icon size={13} aria-hidden="true" />
          {label}
        </button>
      ))}
    </div>
  );
}

// 一颗图标键，画的是现在选的那一档；点开往上弹一列三选一。选了就收（只是换个面，
// 不像项目下拉里那样还要接着对比），Esc、点别处、再点一次这颗键都收。
export function ColorThemeMenu({ notify, buttonClassName }: {
  notify: (message: string) => void;
  buttonClassName: string;
}) {
  const { preference, pick } = useColorThemePick(notify);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const tip = useHoverTip({ placement: "above" });
  useDismissable({ enabled: open, containerRef: root, onClose: () => setOpen(false), restoreFocusRef: trigger });
  const current = COLOR_THEME_CHOICES.find((choice) => choice.value === preference) ?? COLOR_THEME_CHOICES[0]!;
  const CurrentIcon = current.icon;
  return (
    <span className="color-theme-menu-host" ref={root}>
      <button
        ref={trigger}
        className={buttonClassName}
        type="button"
        aria-label={`配色：${current.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        {...tip.anchorProps}
        onClick={() => { tip.hide(); setOpen((value) => !value); }}
      >
        <CurrentIcon size={15} aria-hidden="true" />
      </button>
      {!open && <HoverTip at={tip.at}>配色：{current.label}</HoverTip>}
      {open && (
        <div className="color-theme-menu" role="menu" aria-label="配色">
          {COLOR_THEME_CHOICES.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={value === preference}
              autoFocus={value === preference}
              onClick={() => { setOpen(false); trigger.current?.focus(); pick(value); }}
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                event.preventDefault();
                const items = [...(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
                const at = items.indexOf(event.currentTarget);
                items[(at + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
              }}
            >
              <Icon size={14} aria-hidden="true" />
              <span>{label}</span>
              {value === preference && <Check size={13} weight="bold" aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
