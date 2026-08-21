import { useEffect, useRef, useState } from "react";
import { ArrowSquareOut, CaretDown, Star } from "@phosphor-icons/react";
import { Menu, MenuItem, MenuSeparator } from "../components/ui.tsx";
import { api, type AppOpener, type OpenerProbe } from "../lib/api.ts";
import { useDismissable } from "../lib/useDismissable.ts";

const MATCH_LABEL: Record<AppOpener["match"], string> = {
  extension: "支持这种扩展名",
  type: "支持这种文件类型",
  generic: "可打开任意文件",
};

type ProbeState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; probe: OpenerProbe }
  | { status: "error"; message: string };

/**
 * 「用其他应用打开」。
 *
 * 清单是**点开菜单时才去探的**：探一次要读几十个应用包的 Info.plist，挂在文件打开
 * 路径上会让每次点文件都白等一下，而大多数时候用户只是想看看内容。换文件后清空缓存
 * 重探（同一个应用对不同类型的文件排序不一样）。
 *
 * 这一次请求由**点击直接发起**，不放在 effect 里。放 effect 里必然要拿某个 state 当
 * 「别重复请求」的守卫，而那个 state 一进依赖数组，`setLoading(true)` 自己就会触发
 * 重跑 → 先执行 cleanup → 把在途请求的 `alive` 置 false → 响应回来谁都不写、loading
 * 也不复位，菜单永远停在「正在查…」（StrictMode 的双跑同理）。请求是点击的后果，就
 * 从点击发出；换文件靠 token 作废在途响应，不靠取消。
 */
export function OpenWithMenu({
  taskId,
  path,
  notify,
}: {
  taskId: string;
  path: string;
  notify: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ProbeState>({ status: "idle" });
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // 换文件时自增，在途响应带着旧号回来就丢掉。
  const generation = useRef(0);
  // 已经发过一次就别再发；关掉菜单不作废在途请求，所以重开也不会卡住。
  const requested = useRef(false);

  useDismissable({
    enabled: open,
    containerRef: root,
    onClose: () => setOpen(false),
    restoreFocusRef: trigger,
  });

  useEffect(() => {
    generation.current += 1;
    requested.current = false;
    setOpen(false);
    setState({ status: "idle" });
  }, [path, taskId]);

  const probeOnce = () => {
    if (requested.current) return;
    requested.current = true;
    const mine = generation.current;
    const settle = (next: ProbeState) => {
      if (generation.current === mine) setState(next);
    };
    setState({ status: "loading" });
    api.taskFileOpeners(taskId, path).then(
      (probe) => settle({ status: "ready", probe }),
      (reason) => settle({
        status: "error",
        message: reason instanceof Error ? reason.message : String(reason),
      }),
    );
  };

  const launch = async (app: AppOpener | null) => {
    setOpen(false);
    try {
      await api.openTaskFile(taskId, path, app?.id ?? null);
      notify(app ? `已用 ${app.name} 打开` : "已用系统默认方式打开");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const probe = state.status === "ready" ? state.probe : null;

  return (
    <div className="file-openwith" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="file-viewer__action"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) probeOnce();
        }}
      >
        <ArrowSquareOut size={13} aria-hidden="true" />
        打开方式
        <CaretDown size={9} weight="bold" aria-hidden="true" />
      </button>
      {open && (
        <Menu className="file-openwith__menu">
          <MenuItem onClick={() => void launch(null)}>系统默认方式</MenuItem>
          <MenuSeparator />
          {state.status === "loading" && <p className="file-openwith__hint">正在查本机装了哪些应用…</p>}
          {state.status === "error" && <p className="file-openwith__hint is-error">{state.message}</p>}
          {probe?.note && <p className="file-openwith__hint">{probe.note}</p>}
          {probe && !probe.note && probe.apps.length === 0 && (
            <p className="file-openwith__hint">没找到声明支持这种文件的应用</p>
          )}
          {probe?.apps.map((app) => (
            <MenuItem key={app.id} onClick={() => void launch(app)}>
              <span className="file-openwith__app">
                <b>
                  {app.name}
                  {app.isDefault && <Star size={9} weight="fill" aria-label="系统默认" />}
                </b>
                <small>{MATCH_LABEL[app.match]}</small>
              </span>
            </MenuItem>
          ))}
        </Menu>
      )}
    </div>
  );
}
