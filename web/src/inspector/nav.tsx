import { createContext, useContext, useEffect, useRef, useState } from "react";

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
 * 那一格处理一份请求的结果：`void` = 找到了、办成了；`"wait"` = 数据还没读到，先别清；
 * `"missing"` = 读到的那一份里没有要找的那条。
 */
export type InspectorRequestOutcome = void | "wait" | "missing";

/**
 * 一份请求确认办不成：还留着它说了什么，「重试」原样再发一次。它只属于**那一份**请求：之后
 * 又来了一份（点了别的），它就跟着撤掉——旧提示的「重试」不能把人带回上一个目标。
 */
export type InspectorRequestMiss = { params: InspectorRequest; retry: () => void; dismiss: () => void };

/**
 * 收「给 `id` 这一格」的请求：每来一份就调一次 `handle`，**办成或者确认办不成才告诉宿主收下**。
 * 挂载时已经有一份（刚被 openTab 切过来）也照收。
 *
 * 切到那一格不等于办成了，手里有数据也不等于找过了：刚挂上的那一格往往还在读；读到的也可能
 * 是点之前的旧快照（新一场审查刚结束、缓存里还没有它）。所以：
 *   - `"wait"`：`version`（那一格的数据，以及读没读完、读失败没有）里任何一样一变就再交给它
 *     一次——只盯数据的话，第一次就读失败时数据一直是空的，这份请求会一声不响地挂着；
 *   - `"missing"`：先 `refresh` 一次——拿一份**这份请求之后才发起**的新数据再认；还没有，或者
 *     压根没给 `refresh`，才算确认办不成。办不成不悄悄吞掉：返回值是这份请求，那一格把它
 *     说出来、给一个「重试」（见 RequestMissNote）。
 */
export function useInspectorRequest(
  id: string,
  handle: (params: InspectorRequest) => InspectorRequestOutcome,
  // version 的长度对同一处调用要固定（它直接进 effect 的依赖）。
  { version = [], refresh }: { version?: readonly unknown[]; refresh?: () => Promise<unknown> } = {},
): InspectorRequestMiss | null {
  const nav = useInspectorNav();
  const handleRef = useRef(handle);
  handleRef.current = handle;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const request = nav?.request;
  const consume = nav?.consume;
  const openTab = nav?.openTab;
  // 哪一份请求已经为它重读过一次、那一趟落地没有。
  const refreshed = useRef<{ seq: number; settled: boolean } | null>(null);
  const [landed, setLanded] = useState(0);
  const [missed, setMissed] = useState<{ seq: number; params: InspectorRequest } | null>(null);
  // 最近交到这一格的那一份请求：只有它的失败提示还作数。
  const latest = useRef(0);
  useEffect(() => {
    if (!request || request.id !== id) return;
    latest.current = request.seq;
    // 新的一份来了：上一份的失败提示（连同它的「重试」）当场作废，不等这一份办出结果。
    setMissed((current) => (current && current.seq !== request.seq ? null : current));
    const outcome = handleRef.current(request.params);
    if (outcome === "wait") return;
    if (outcome === "missing") {
      const attempt = refreshed.current?.seq === request.seq ? refreshed.current : null;
      const reload = refreshRef.current;
      if (!attempt && reload) {
        const mine = { seq: request.seq, settled: false };
        refreshed.current = mine;
        // 读失败也算这一趟落地了：再认一次还没有，就是办不成（那一格自己会说读失败）。
        void reload().catch(() => {}).finally(() => {
          mine.settled = true;
          if (refreshed.current === mine) setLanded((value) => value + 1);
        });
        return;
      }
      if (attempt && !attempt.settled) return;
      setMissed({ seq: request.seq, params: request.params });
    } else {
      setMissed(null);
    }
    consume?.(request.seq);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version 是调用方给的一组依赖，按项展开
  }, [consume, id, request, landed, ...version]);
  if (!missed) return null;
  const { seq, params } = missed;
  const stale = () => latest.current !== seq;
  return {
    params,
    retry: () => {
      setMissed(null);
      if (!stale()) openTab?.(id, params);
    },
    dismiss: () => setMissed((current) => (current?.seq === seq ? null : current)),
  };
}
