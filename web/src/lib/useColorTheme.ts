// 配色给 React 用的那一面:选的是哪一档、此刻实际是深是浅，变了会重渲染。
//
// 判据本体在 `theme.ts`(它不认识 React);这里只做订阅。保存走 `api.patchSettings`,
// 由 settingsSync 把在途的选择立刻推给 theme.ts,所以这里不另管「保存中」的显示。
import { useEffect, useState } from "react";
import type { ColorTheme } from "@ash/shared";
import { colorTheme, onColorThemeChange, resolvedTheme, type ResolvedTheme } from "./theme.ts";

export function useColorTheme(): { preference: ColorTheme; resolved: ResolvedTheme } {
  const read = () => ({ preference: colorTheme(), resolved: resolvedTheme() });
  const [state, setState] = useState(read);
  useEffect(() => {
    // 订阅之前这一档可能已经翻过(任何一次读设置都会推一份过来)。
    setState(read());
    return onColorThemeChange(() => setState(read()));
  }, []);
  return state;
}
