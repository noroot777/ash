import { useEffect, useState } from "react";
import { useNarrowScreen } from "../lib/useNarrowScreen.ts";

/**
 * 窄屏（手机、飞书里点开 ash 链接）一次只给侧栏列表和主区内容里的一样（workspace.css 的 is-narrow-*）：
 * 主区有东西（选中的任务、对话、助手、建任务）就给内容，「‹ 列表」回到列表；在列表上再点任何东西又回到内容。
 * contentKey = 主区此刻摆的是什么（null = 什么都没选，只给列表）；换了一样就自动回到内容。
 */
export function useNarrowPane(contentKey: string | null) {
  const narrow = useNarrowScreen();
  const [listShown, setListShown] = useState(false);
  useEffect(() => { setListShown(false); }, [contentKey]);
  const pane: "both" | "list" | "content" = !narrow ? "both" : contentKey && !listShown ? "content" : "list";
  return {
    narrow,
    pane,
    showList: () => setListShown(true),
    /** 包一层侧栏上的入口：点了就回到内容（点的就是眼下这一样时 contentKey 不变，得手动切）。 */
    toContent: <Args extends unknown[]>(open: (...args: Args) => void) => (...args: Args) => {
      setListShown(false);
      open(...args);
    },
  };
}
