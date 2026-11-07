import type { ColorTheme } from "@ash/shared";
import { Desktop, Moon, Sun } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import { useColorTheme } from "../lib/useColorTheme.ts";
import { useRovingChoice } from "../lib/useRovingChoice.ts";

// 深浅色的三档开关。设置页「外观」卡和项目下拉里各摆一颗，长相与存法共用这一份 ——
// 两处各写一遍的话，迟早一处改了档位另一处没跟上。
//
// 自己读、自己存，不从上面传值：偏好本来就是全站一份(lib/theme.ts),点下去由
// settingsSync 立刻把在途的那一档推给 theme.ts,页面当场翻面;保存失败时它退回服务端
// 确认过的那一档，这颗开关跟着退，所以这里不另设「保存中」。

const CHOICES: { value: ColorTheme; label: string; icon: typeof Sun }[] = [
  { value: "system", label: "跟随系统", icon: Desktop },
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
];
const VALUES = CHOICES.map((choice) => choice.value);

export function ColorThemeChoice({ notify, className }: {
  notify: (message: string) => void;
  className?: string;
}) {
  const { preference } = useColorTheme();
  const pick = (next: ColorTheme) => {
    if (next === preference) return;
    api.patchSettings({ colorTheme: next }).catch((error) =>
      notify(error instanceof Error ? error.message : "配色保存失败"));
  };
  const { groupProps, itemProps } = useRovingChoice(VALUES, preference, pick);
  return (
    <div className={`ui-tabs color-theme-choice${className ? ` ${className}` : ""}`} {...groupProps} aria-label="配色">
      {CHOICES.map(({ value, label, icon: Icon }) => (
        <button key={value} type="button" {...itemProps(value)} onClick={() => pick(value)}>
          <Icon size={13} aria-hidden="true" />
          {label}
        </button>
      ))}
    </div>
  );
}
