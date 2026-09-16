import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * 面板头带（标题 ── 关闭）里留给当前面板的一块动作位。
 *
 * 头带是每个 inspector 面板都已经占着的那条 34px。面板若再自己横一条工具栏，就是同一
 * 块窄栏里的第二条常驻横带——它一直占着竖向空间，而放进去的往往只有两三个图标按钮。
 * 面板把「切换 / 新建 / 说明」这类入口挂到这里，头带那条本来就空着的中段被用起来，
 * 列表和输入框各多拿回一截高度。
 *
 * 宿主在渲染面板内容时把插槽元素放进 context，面板里任意深度的组件都能 portal 过去。
 */
const HeadSlotContext = createContext<HTMLElement | null>(null);

export const InspectorHeadSlotProvider = HeadSlotContext.Provider;

export function InspectorHeadActions({ children }: { children: ReactNode }) {
  const slot = useContext(HeadSlotContext);
  // 面板被单独渲染（没有宿主头带）时就地铺开：入口可以挪位置，但不能凭空消失。
  return slot ? createPortal(children, slot) : <>{children}</>;
}
