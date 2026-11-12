import { createContext, useContext, useEffect, useRef } from "react";

/**
 * 面板里的东西要「切到别的格」时用的那条线：信息格里那行改动统计点了去「改动」，工作流里
 * 一行审查点了去「审查」并展开那一轮。宿主（InspectorHost）把自己的 openTab 放进来，
 * 面板里任意深度的组件都拿得到，不用一层层往下传回调。
 *
 * `request` 是这次打开要带给那一格的话（比如 `{ round: 3 }`：展开第 3 轮）。它只说一次：
 * 那一格用 {@link useInspectorRequest} 收，收下就由宿主清掉——切走再切回来，那一格重挂时
 * 不会把旧请求再执行一遍。
 */
export type InspectorRequest = Readonly<Record<string, unknown>>;

export interface InspectorNav {
  openTab: (id: string, request?: InspectorRequest) => void;
  /** 最近一次带着话的打开：给哪一格、说了什么、第几次。 */
  request: { id: string; params: InspectorRequest; seq: number } | null;
  /** 那一格收下了第 seq 份请求。 */
  consume: (seq: number) => void;
}

const NavContext = createContext<InspectorNav | null>(null);

export const InspectorNavProvider = NavContext.Provider;

/** 面板被单独渲染（没有宿主）时拿到的是 null：调用方自己决定退路。 */
export function useInspectorNav(): InspectorNav | null {
  return useContext(NavContext);
}

/**
 * 收「给 `id` 这一格」的请求：每来一份就调一次 `handle`，然后告诉宿主收下了。挂载时已经有
 * 一份（刚被 openTab 切过来）也照收。
 */
export function useInspectorRequest(id: string, handle: (params: InspectorRequest) => void) {
  const nav = useInspectorNav();
  const handleRef = useRef(handle);
  handleRef.current = handle;
  const request = nav?.request;
  const consume = nav?.consume;
  useEffect(() => {
    if (!request || request.id !== id) return;
    handleRef.current(request.params);
    consume?.(request.seq);
  }, [consume, id, request]);
}
