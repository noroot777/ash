import type { PreviewServiceState } from "@ash/shared/preview";
import { browserPreviewUrl } from "../lib/previewUrl.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowsClockwise, Copy, Terminal, X } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import { useDismissable } from "../lib/useDismissable.ts";

/**
 * 预览的启动日志。
 *
 * 在这之前，预览起不来时用户能拿到的只有一句一闪而过的 toast：命令是哪条、端口借的
 * 是哪个、maven 卡在下载什么、vite 报的什么错，全都留在服务端一个他看不见的文件里。
 * 「起不来」和「不知道为什么起不来」是两个问题，后者更难受。
 *
 * 两条判据决定了这扇窗的行为：
 *  ① **起失败的那一次也要能看**。日志文件在 spawn 之前就写了 banner，所以入口按
 *     `hasLog` 给，不是按 `running` 给。
 *  ② 还在跑的时候要自己刷新。dev server 是边跑边吐字的，一份静态快照等于让人一直点。
 *     「还在跑」包含**还在启动**那一段（后端的 `starting`）—— 那一段最长两分钟，Maven
 *     在下依赖、前端在冷编译，正是这扇窗唯一有用的时候。只按「预览已就绪」轮询的话，
 *     它就退化成事后查看器了。
 *
 *     光看后端那个标记还不够：`starting` 是 `startPreview` 真的开跑之后才有的，而按钮在
 *     POST 发出的那一刻就亮了。中间隔着解析工作区、解析命令这几步，用户手快的话第一次
 *     GET 会落在这个窗口里，拿到一份「没在跑」——**而轮询只在第一次响应说在跑时才建立**，
 *     于是它再也不会去看第二眼，弹窗就永远停在「还没有预览日志」上，页面那边启动 POST
 *     其实还挂着。所以调用方把「我这会儿正等一个启动请求」也告诉它（awaitingStart），
 *     两个条件任一成立就续读。
 */
export function PreviewLogDialog({ taskId, onClose, notify, awaitingStart = false }: {
  taskId: string;
  onClose: () => void;
  notify: (message: string) => void;
  /** 调用方正等着一个启动请求返回：即便后端还没报 starting，也得续读。 */
  awaitingStart?: boolean;
}) {
  const scrim = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLPreElement>(null);
  const requestVersion = useRef(0);
  const [serviceId, setServiceId] = useState<string | undefined>();
  const [services, setServices] = useState<PreviewServiceState[]>([]);
  const [text, setText] = useState("");
  const [meta, setMeta] = useState<{ running: boolean; starting: boolean; truncated: boolean; command: string | null; url: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // 人往上翻的时候不能被新日志拽回底部（跟会话贴底一个道理）。
  const [stick, setStick] = useState(true);
  useDismissable({ enabled: true, containerRef: scrim, onClose });

  const load = useCallback(async () => {
    const version = requestVersion.current;
    try {
      const log = await api.freePreviewLog(taskId, serviceId);
      if (version !== requestVersion.current) return;
      setServices(log.services ?? []);
      setText(log.exists ? log.text : "");
      setMeta({ running: log.running, starting: log.starting, truncated: log.truncated, command: log.command, url: log.url });
      setError(null);
    } catch (fail) {
      if (version !== requestVersion.current) return;
      setError(fail instanceof Error ? fail.message : "读取预览日志失败");
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [taskId, serviceId]);

  useEffect(() => {
    setLoading(true); setText("");
    void load();
    return () => { requestVersion.current += 1; };
  }, [load]);
  // 还在跑（含还在启动）就每 2 秒续一次。都停了才不再轮询——日志已经不会再长了。
  const live = !!meta?.starting || awaitingStart;
  useEffect(() => {
    if (!meta?.running && !live) return;
    const timer = setInterval(() => { void load(); }, 2000);
    return () => clearInterval(timer);
  }, [meta?.running, live, load]);
  useEffect(() => {
    if (stick && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [text, stick]);

  const copy = async () => {
    try { await navigator.clipboard.writeText(text); notify("预览日志已复制"); }
    catch { notify("复制失败，可以手动选中日志文本"); }
  };

  return createPortal(
    <div className="task-modal-scrim" ref={scrim} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className="preview-log-dialog" role="dialog" aria-modal="true" aria-labelledby="preview-log-title" tabIndex={-1}>
        <header>
          <span><Terminal size={17} weight="bold" /></span>
          <div>
            <h2 id="preview-log-title">预览日志</h2>
            <p data-testid="preview-log-state">
              {live
                ? "预览正在启动，日志每 2 秒自动续上。"
                : meta?.running
                  ? "预览正在运行，日志每 2 秒自动续上。"
                  : "这是最近一次预览留下的输出（起失败的那次也在）。"}
              {meta?.truncated ? "太长了，只显示尾部。" : ""}
            </p>
          </div>
          <button type="button" aria-label="关闭预览日志" onClick={onClose}><X size={15} /></button>
        </header>
        {services.length > 1 && <div className="preview-service-tabs" role="group" aria-label="服务日志">
          <button type="button" aria-pressed={!serviceId} onClick={() => setServiceId(undefined)}>全部</button>
          {services.map((s) => <button type="button" key={s.id} aria-pressed={serviceId === s.id} onClick={() => setServiceId(s.id)}>{s.name} · {{ starting: "启动中", ready: "运行中", failed: "失败", stopped: "已停止" }[s.status]}</button>)}
        </div>}
        {meta?.command && (
          <div className="preview-log-meta">
            <code className="mono">{meta.command}</code>
            {meta.url && <a href={browserPreviewUrl(meta.url)} target="_blank" rel="noreferrer">{browserPreviewUrl(meta.url)}</a>}
          </div>
        )}
        <pre
          className="preview-log-body mono"
          ref={body}
          tabIndex={0}
          onScroll={(event) => {
            const el = event.currentTarget;
            setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
          }}
        >
          {error ?? (loading
            ? "正在读取…"
            : text || (live
              ? "预览正在启动，还没有输出。"
              : "这个任务还没有预览日志——点一次「打开预览」就有了。"))}
        </pre>
        <footer>
          <span>{stick ? "" : "已暂停自动滚动，翻到底部恢复"}</span>
          <button type="button" onClick={() => void load()}><ArrowsClockwise size={13} />刷新</button>
          <button type="button" disabled={!text} onClick={() => void copy()}><Copy size={13} />复制</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
