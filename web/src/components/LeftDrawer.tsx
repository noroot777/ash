import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { SideDrawer } from "./SideDrawer.tsx";

/**
 * 读全文的那一屉：审查报告、辩论的完整记录。从左边推出来——跟子智能体、团队执行者详情同一个
 * 位置（SideDrawer），右边的审查格照样看得见、点得着；够宽时不盖会话，把中间那一栏往右挤（side-drawer.css），
 * 读着报告也能接着在回复框里说话。
 *
 * 宿主是视图的主区容器（TaskDetail / TeamView），开它的人散在各处：会话里的气泡、Inspector 里
 * 的审查格。所以这里只是一个按视图共享的「槽」：谁 `open` 谁占住它，前一个让位；宿主自己的
 * 子智能体 / 执行者抽屉经 `onOpen` 跟它互斥，同一时刻左边只有一屉。
 *
 * `body` 存的是开的那一刻交过来的元素，渲染在宿主的位置上（不在开它的那颗键下面）：开它的
 * 那一格被收起、切走了，抽屉照样在。所以要跟着长的内容（辩论中那份记录）由 body 组件自己按
 * 身份订阅，不靠开的人把新数据推进来。
 */
export type LeftDrawerEntry = {
  /** 装的是谁。同一个 key 再开 = 换停的位置，不重播推出动画。 */
  key: string;
  /** 抽屉头上那一小块：「审查报告」「辩论」。 */
  kind: ReactNode;
  title: ReactNode;
  ariaLabel: string;
  closeLabel: string;
  body: ReactNode;
  /** 抽屉头上关闭键前面的键（可以派出去的活那一屉的「改」）。 */
  actions?: ReactNode;
  /** 贴着底边的那一段（报告的截图证据）：正文单独滚动，截图再多也不挤掉报告。 */
  footer?: ReactNode;
};

export type LeftDrawerApi = {
  open: (entry: LeftDrawerEntry) => void;
  close: () => void;
  /** 此刻开着的是谁；开它的那颗键据此画「按下」。 */
  activeKey: string | null;
};

const LeftDrawerContext = createContext<LeftDrawerApi | null>(null);

/** 这一处有没有左侧抽屉可开：只读的会话视图、没有主区容器的地方拿到 null。 */
export function useLeftDrawer(): LeftDrawerApi | null {
  return useContext(LeftDrawerContext);
}

export function LeftDrawerProvider({ value, children }: { value: LeftDrawerApi; children: ReactNode }) {
  return <LeftDrawerContext.Provider value={value}>{children}</LeftDrawerContext.Provider>;
}

/**
 * 宿主那一侧：拿到 `api` 交给 Provider、`drawer` 摆进主区容器（它以那一层为定位基准）。
 * `resetKey` 换了（切到别的任务）就关；`onOpen` 给宿主收起它自己那几屉。
 */
export function useLeftDrawerHost({ resetKey, onOpen }: { resetKey: string; onOpen?: () => void }) {
  const [entry, setEntry] = useState<LeftDrawerEntry | null>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  useEffect(() => setEntry(null), [resetKey]);
  const close = useCallback(() => setEntry(null), []);
  const open = useCallback((next: LeftDrawerEntry) => {
    onOpenRef.current?.();
    setEntry(next);
  }, []);
  const activeKey = entry?.key ?? null;
  const api = useMemo<LeftDrawerApi>(() => ({ open, close, activeKey }), [activeKey, close, open]);
  const drawer = entry ? (
    <SideDrawer
      variant="reading"
      contentKey={entry.key}
      kind={entry.kind}
      title={entry.title}
      ariaLabel={entry.ariaLabel}
      closeLabel={entry.closeLabel}
      actions={entry.actions}
      onClose={close}
    >
      <div className="side-drawer__scroll">{entry.body}</div>
      {entry.footer && <div className="side-drawer__footer">{entry.footer}</div>}
    </SideDrawer>
  ) : null;
  return { api, drawer, close };
}
