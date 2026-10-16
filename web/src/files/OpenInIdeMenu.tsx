import { useRef, useState } from "react";
import { ArrowsClockwise, CaretDown, Code } from "@phosphor-icons/react";
import { Menu, MenuItem, MenuSeparator } from "../components/ui.tsx";
import { api, type IdeApp, type IdeProbe } from "../lib/api.ts";
import { useDismissable } from "../lib/useDismissable.ts";

const LAST_IDE_KEY = "ash.open-in-ide";

function readLastIde(): string | null {
  try {
    return localStorage.getItem(LAST_IDE_KEY);
  } catch {
    return null; // 隐私模式 / 禁了存储：记不住上次用哪个而已，不影响打开
  }
}

function rememberIde(id: string): void {
  try {
    localStorage.setItem(LAST_IDE_KEY, id);
  } catch {
    // 同上，写不进去就算了
  }
}

type ProbeState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; probe: IdeProbe }
  | { status: "error"; message: string };

/** 上次用过的那个排最前——一个人常用的 IDE 基本不换，别让他每次都在十几行里找。 */
function ordered(ides: readonly IdeApp[], last: string | null): IdeApp[] {
  if (!last) return [...ides];
  const index = ides.findIndex((ide) => ide.id === last);
  if (index < 0) return [...ides];
  return [ides[index]!, ...ides.slice(0, index), ...ides.slice(index + 1)];
}

/**
 * 「用 IDE 打开这个文件夹」。
 *
 * 跟「打开方式」（`OpenWithMenu`）分开，因为问的不是同一件事：那个问的是系统文件关联，
 * 对一个文件夹问出来的是访达和解压工具；「编程 IDE」系统里没有这个概念，只能由服务端
 * 按一张清单去本机找（server/src/openers/ide-catalog.ts）。
 *
 * 探测同样是**点开菜单时才发起**，理由和 `OpenWithMenu` 顶部那段一模一样：请求由点击
 * 直接发出，不放进 effect（放进去就要拿 state 当守卫，而那个 state 一进依赖数组，
 * `setState(loading)` 自己会触发重跑，在途响应被 cleanup 作废，菜单永远停在「正在查…」）。
 */
export function OpenInIdeMenu({
  taskId,
  path,
  notify,
  variant = "label",
}: {
  taskId: string;
  /** 工作区内的相对路径；空字符串就是工作目录本身。 */
  path: string;
  notify: (message: string) => void;
  /** `icon` 给文件树头部那排 24px 方钮，`label` 给中间栏带文字的工具条。 */
  variant?: "icon" | "label";
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ProbeState>({ status: "idle" });
  const [last, setLast] = useState<string | null>(() => readLastIde());
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // 已经发过一次就别再发；关掉菜单不作废在途请求，所以重开也不会卡住。
  const requested = useRef(false);

  useDismissable({
    enabled: open,
    containerRef: root,
    onClose: () => setOpen(false),
    restoreFocusRef: trigger,
  });

  const probeOnce = (force = false) => {
    if (requested.current && !force) return;
    requested.current = true;
    setState({ status: "loading" });
    api.ides(force).then(
      (probe) => setState({ status: "ready", probe }),
      (reason) => setState({
        status: "error",
        message: reason instanceof Error ? reason.message : String(reason),
      }),
    );
  };

  const launch = async (ide: IdeApp) => {
    setOpen(false);
    rememberIde(ide.id);
    setLast(ide.id);
    try {
      await api.openTaskPathInIde(taskId, path, ide.id);
      notify(`已用 ${ide.name} 打开`);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const probe = state.status === "ready" ? state.probe : null;
  const ides = probe ? ordered(probe.ides, last) : [];

  return (
    // `is-rail` 让菜单改以整条头部为锚（窄面板里定宽右对齐会被削边，见 files.css）。
    <div className={`file-ide${variant === "icon" ? " is-rail" : ""}`} ref={root}>
      <button
        ref={trigger}
        type="button"
        className={variant === "icon" ? "file-tree__action" : "file-viewer__action"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={variant === "icon" ? "用编程 IDE 打开这个文件夹" : undefined}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) probeOnce();
        }}
      >
        <Code size={13} aria-hidden="true" />
        {variant === "label" && (
          <>
            用 IDE 打开
            <CaretDown size={9} weight="bold" aria-hidden="true" />
          </>
        )}
      </button>
      {open && (
        <Menu className="file-openwith__menu">
          {state.status === "loading" && <p className="file-openwith__hint">正在看本机装了哪些 IDE…</p>}
          {state.status === "error" && <p className="file-openwith__hint is-error">{state.message}</p>}
          {probe?.note && <p className="file-openwith__hint">{probe.note}</p>}
          {ides.map((ide) => (
            <MenuItem key={ide.id} onClick={() => void launch(ide)}>
              <span className="file-openwith__app">
                <b>{ide.name}{ide.id === last && <em>上次用的</em>}</b>
                <small>{ide.detail}</small>
              </span>
            </MenuItem>
          ))}
          {probe && (
            <>
              <MenuSeparator />
              {/* 刚装上一个 IDE 的人会立刻来点这里。服务端那半分钟的缓存由 refresh 作废。 */}
              <MenuItem onClick={() => probeOnce(true)}>
                <span className="file-openwith__app">
                  <b><ArrowsClockwise size={11} aria-hidden="true" />重新探测本机 IDE</b>
                </span>
              </MenuItem>
            </>
          )}
        </Menu>
      )}
    </div>
  );
}
