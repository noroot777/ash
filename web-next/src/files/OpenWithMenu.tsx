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

/**
 * 「用其他应用打开」。
 *
 * 清单是**点开菜单时才去探的**：探一次要读几十个应用包的 Info.plist，挂在文件打开
 * 路径上会让每次点文件都白等一下，而大多数时候用户只是想看看内容。换文件后清空缓存
 * 重探（同一个应用对不同类型的文件排序不一样）。
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
  const [probe, setProbe] = useState<OpenerProbe | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useDismissable({
    enabled: open,
    containerRef: root,
    onClose: () => setOpen(false),
    restoreFocusRef: trigger,
  });

  useEffect(() => {
    setOpen(false);
    setProbe(null);
    setError(null);
  }, [path, taskId]);

  useEffect(() => {
    if (!open || probe || loading) return;
    let alive = true;
    setLoading(true);
    api.taskFileOpeners(taskId, path)
      .then((result) => { if (alive) setProbe(result); })
      .catch((reason) => { if (alive) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [loading, open, path, probe, taskId]);

  const launch = async (app: AppOpener | null) => {
    setOpen(false);
    try {
      await api.openTaskFile(taskId, path, app?.id ?? null);
      notify(app ? `已用 ${app.name} 打开` : "已用系统默认方式打开");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <div className="file-openwith" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="file-viewer__action"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <ArrowSquareOut size={13} aria-hidden="true" />
        打开方式
        <CaretDown size={9} weight="bold" aria-hidden="true" />
      </button>
      {open && (
        <Menu className="file-openwith__menu">
          <MenuItem onClick={() => void launch(null)}>系统默认方式</MenuItem>
          <MenuSeparator />
          {loading && <p className="file-openwith__hint">正在查本机装了哪些应用…</p>}
          {error && <p className="file-openwith__hint is-error">{error}</p>}
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
