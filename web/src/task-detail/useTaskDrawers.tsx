// 普通任务详情页左边那几屉：子智能体执行详情、读全文（审查报告、辩论记录）、派出的任务。
//
// 三屉在同一个位置（盖住中间那一栏，右侧 Inspector 仍然看得见、点得着），**同一时刻只有一屉**：
// 谁推出来，谁先把另外两屉收起。接线集中在这里而不是散在 TaskDetail 里，一是守 700 行，二是
// 这条互斥能被回归测试按原样挂起来测（scripts/fixtures/task-drawers.tsx），不用在夹具里抄一份。
//
// **整页只有一屉，不只是一个 TaskDetail 里只有一屉**：派出的任务那一屉里装的是完整的 TaskDetail
// （抽屉模式），它自己也有这三屉。各管各的话，往下一层看就是抽屉里再推一屉，越叠越窄。所以
// 最外层那一页把「摆抽屉的位置」经 PageDrawersContext 交给它那一屉里的 TaskDetail：
//   · 里层再点一条派出的任务 = 外层那一屉换成那一条（往下一层看是替换，不叠）；
//   · 里层推子智能体 / 读全文 = 画在外层那一屉的位置上、一样宽，外层那一屉先让出来（藏起来，
//     不卸载 —— 里层那一屉的内容就长在它里面），关上之后它原样露回来。
// 团队执行者抽屉里的 TaskDetail 不在这层关系里（团队页这一轮不动），照旧各管各。
//
// **那一屉里得摆得下一整页**（会话 + 回复框；回复框那一行有附件、派审查、预览、接力、执行器
// 胶囊、发送键）。在真实页面上量过：抽屉不到 340px 胶囊被挤出去点不着，420px 起智能体、模型的名字
// 才看得清 —— 下限取 420。保证分三处，都只在这一层（团队执行者抽屉、页面自己那两屉不在里面）：
//   · 外壳：平时只盖中间那一栏、宽度跟着那一栏走（78%，最宽 680）；那样摆不出 420 时（窗口窄、
//     右侧 Inspector 又开着），改盖整个详情区（连 Inspector，92%），跟窄屏下 Inspector 盖在内容上
//     同一种做法。算在 useDrawerArea 一处，经 CSS 变量交给样式，比例不在两边各写一份。
//   · 里面那一页自己的 Inspector：抽屉最宽 680，减掉 Inspector 至少 300 就到不了 420，所以在这
//     一屉里它**一律盖在内容上**（关上回到内容），从不并排挤内容（dispatched.css）。
//   · 换位置不换宿主：这一层开着时一直挂在同一个容器（.inspector-layout）里，窗口跨过上面那条线
//     只改位置和宽度，里面那一页（连同它里层推出来的读全文）不重挂、不丢状态。
import { createContext, useContext, useLayoutEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Task, TaskListItem } from "@ash/shared";
import { useLeftDrawerHost } from "../components/LeftDrawer.tsx";
import type { useConversation } from "../lib/useConversation.ts";
import { useDispatched, type DispatchedState } from "./dispatched/useDispatched.tsx";
import { useTaskInspectorStack } from "./useTaskInspectorStack.ts";

type PageDrawers = {
  /** 最外层那一页摆抽屉的位置。 */
  layer: HTMLElement | null;
  /** 外层那一屉换成另一条派出的任务。 */
  openDispatched: (taskId: string) => void;
  /** 里层推出了自己的一屉：外层那一屉先让出来。 */
  setCovered: (covered: boolean) => void;
};

const PageDrawersContext = createContext<PageDrawers | null>(null);

// 实测：抽屉到这个宽，回复框那一行（连执行器胶囊里的名字）才摆得开。
const MIN_DRAWER_WIDTH = 420;
const MAX_DRAWER_WIDTH = 680;

type DrawerArea = { host: HTMLElement; wide: boolean; style: CSSProperties };

/**
 * 派出的任务这一层摆在哪、多宽。`anchor` 所在那一栏是中间那一栏（.task-detail），`host` 是包住它和
 * Inspector 的那一层：这一层始终挂在 host 里，只按量出来的尺寸决定盖中间那一栏还是整个详情区。
 * 只在开着时量（active），跟着窗口、Inspector 宽度实时变。
 */
function useDrawerArea(anchor: HTMLElement | null, active: boolean): DrawerArea | null {
  const center = anchor?.parentElement ?? null;
  const host = anchor?.closest<HTMLElement>(".inspector-layout") ?? center;
  const [measured, setMeasured] = useState<{ wide: boolean; style: CSSProperties; key: string } | null>(null);
  useLayoutEffect(() => {
    if (!active || !center || !host) return;
    const measure = () => {
      const c = center.getBoundingClientRect();
      const h = host.getBoundingClientRect();
      const wide = host !== center && Math.min(MAX_DRAWER_WIDTH, c.width * 0.78) < MIN_DRAWER_WIDTH;
      const area = wide
        ? { left: 0, top: 0, width: h.width, height: h.height }
        : { left: c.left - h.left, top: c.top - h.top, width: c.width, height: c.height };
      const drawer = Math.min(MAX_DRAWER_WIDTH, area.width * (wide ? 0.92 : 0.78));
      const style = {
        "--page-area-left": `${area.left}px`,
        "--page-area-top": `${area.top}px`,
        "--page-area-width": `${area.width}px`,
        "--page-area-height": `${area.height}px`,
        "--page-drawer-width": `${drawer}px`,
      } as CSSProperties;
      const key = `${wide}:${Object.values(style).join(",")}`;
      setMeasured((prev) => (prev?.key === key ? prev : { wide, style, key }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(center);
    observer.observe(host);
    return () => observer.disconnect();
  }, [active, center, host]);
  if (!active || !host || !measured) return null;
  return { host, wide: measured.wide, style: measured.style };
}

export function useTaskDrawers({ task, allTasks, conversation, onOpenTask, renderTask }: {
  task: Task;
  allTasks: TaskListItem[];
  conversation: ReturnType<typeof useConversation>;
  onOpenTask: (taskId: string) => void;
  /** 派出的任务那一屉里画什么（TaskDetail 自己，抽屉模式）。由宿主给，免得这里反过来引它。 */
  renderTask: (task: Task) => ReactNode;
}) {
  // 有值 = 这一页本身就装在外层的「派出的任务」那一屉里。
  const page = useContext(PageDrawersContext);
  const leftDrawer = useLeftDrawerHost({ resetKey: task.id, onOpen: () => { stack.subagents.closeAgent(); dispatched.close(); } });
  // Inspector 栈（哪几格存在、默认开哪几格）整块在 useTaskInspectorStack.ts。
  const stack = useTaskInspectorStack(task, allTasks, conversation, () => { leftDrawer.close(); dispatched.close(); });
  const dispatched = useDispatched({
    taskId: task.id, allTasks, onOpen: () => { stack.subagents.closeAgent(); leftDrawer.close(); }, onGo: onOpenTask, render: renderTask,
  });
  // 中间那一栏换内容时（审查、文件、diff、预览），左边开着的那一屉跟着收起来 —— 它盖在主区上面，
  // 不收的话用户点了别的只会看到原来那份详情。
  const closeDrawers = () => { stack.subagents.closeAgent(); leftDrawer.close(); dispatched.close(); };

  // 外层：给自己那一屉里的 TaskDetail 递位置；里层推出东西时这一屉让出来。
  const [layer, setLayer] = useState<HTMLElement | null>(null);
  const [covered, setCovered] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const area = useDrawerArea(page ? null : anchor, !!dispatched.drawer);
  const openHere = dispatched.state.open;
  const pageValue = useMemo<PageDrawers>(() => ({ layer, openDispatched: openHere, setCovered }), [layer, openHere]);

  // 里层：自己那两屉开没开，告诉外层。卸载（外层换了一条、关了）时一并撤回。用 layout effect：
  // 外层那一屉得在同一帧里让出来，不然会先闪一帧两屉同时在。
  const ownOpen = !!stack.subagents.drawer || !!leftDrawer.drawer;
  useLayoutEffect(() => {
    if (!page) return;
    page.setCovered(ownOpen);
    return () => page.setCovered(false);
  }, [ownOpen, page]);
  const dispatchedState = useMemo<DispatchedState>(
    () => (page ? { ...dispatched.state, open: page.openDispatched } : dispatched.state),
    [dispatched.state, page],
  );

  const own = <>{stack.subagents.drawer}{leftDrawer.drawer}</>;
  const drawers = page
    ? (page.layer ? createPortal(own, page.layer) : own)
    : (
      <>
        {own}
        <span className="page-drawer-anchor" ref={setAnchor} hidden />
        {area && createPortal(
          <div className={`page-drawer-host${area.wide ? " is-wide" : ""}`} style={area.style}>
            {pageLayer(pageValue, covered, dispatched.drawer, setLayer)}
          </div>,
          area.host,
        )}
      </>
    );
  return { ...stack, leftDrawer, dispatched: { ...dispatched, state: dispatchedState }, closeDrawers, drawers };
}

/** 派出的任务那一屉 + 里层推出来的那一屉摆的位置（位置和宽度由外面那层 .page-drawer-host 的变量定）。 */
function pageLayer(value: PageDrawers, covered: boolean, drawer: ReactNode, setLayer: (node: HTMLElement | null) => void) {
  return (
    <>
      <PageDrawersContext.Provider value={value}>
        <div className={`page-drawer-slot${covered ? " is-covered" : ""}`}>{drawer}</div>
      </PageDrawersContext.Provider>
      <div className="page-drawer-layer" ref={setLayer} />
    </>
  );
}
