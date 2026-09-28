import { useEffect, useMemo, useState } from "react";
import {
  ArrowSquareOut,
  CaretLeft,
  CaretRight,
  Code,
  Copy,
  FolderOpen,
  GitDiff,
  SpinnerGap,
  Trash,
  Warning,
  X,
} from "@phosphor-icons/react";
import { api, type FileContent } from "../lib/api.ts";
import { useZoomLayer, ZoomToggle } from "../lib/zoomLayer.tsx";
import { formatSize, isImageName } from "./fileModel.ts";
import { OpenWithMenu } from "./OpenWithMenu.tsx";
import { useDeleteEntry } from "./useDeleteEntry.tsx";

function TextBody({ file }: { file: FileContent }) {
  const lines = useMemo(() => (file.text ?? "").split("\n"), [file.text]);
  return (
    <div className="file-viewer__code">
      <div className="file-viewer__gutter" aria-hidden="true">
        {lines.map((_line, index) => <span key={index}>{index + 1}</span>)}
      </div>
      <pre className="file-viewer__text"><code>{file.text}</code></pre>
    </div>
  );
}

const VIDEO_PATTERN = /\.(?:mp4|m4v|mov|webm|mkv|ogv)$/i;
const AUDIO_PATTERN = /\.(?:mp3|wav|m4a|aac|flac|ogg|opus|aiff)$/i;

/**
 * 任务做出来的网页，就地渲染。
 *
 * `sandbox` 里**故意没有 `allow-same-origin`**：这些 html 是 agent 现写的，给了它就等于
 * 让页面以 ash 自己的源跑脚本，读得到登录态、能带着 cookie 调 ash 的接口。服务端那条
 * `/tasks/:id/page/<令牌>/*` 还会再压一道同样的 CSP，直接在地址栏打开也照样被钉住。
 *
 * 地址由服务端随文件内容一起发（`pageUrl`），前端不自己拼：里面那段令牌是挡住第三方
 * 站点的那一道。根路径资源（`/assets/…`）的改写也在服务端做。
 *
 * 跑不全的那一类由服务端在 `pageNotice` 里说明（模块脚本在沙箱里加载不了——给它放行
 * 就等于把工作区文件交给页面读）。加上页面在**打包后的 JS 里** `fetch("/api/…")` 这种
 * 改不动的地址，所以头上那颗「在浏览器中打开」是**兜底出口**，不是冗余入口。
 */
function PageBody({ url, path }: { url: string; path: string }) {
  return (
    <iframe
      className="file-viewer__page"
      src={url}
      sandbox="allow-scripts allow-forms allow-popups allow-modals"
      aria-label={`${path} 页面预览`}
    />
  );
}

function Body({
  taskId,
  file,
  pageUrl,
  showSource,
}: {
  taskId: string;
  file: FileContent;
  pageUrl: string | null;
  showSource: boolean;
}) {
  const rawUrl = api.taskFileRawUrl(taskId, file.path);
  if (file.kind === "image") {
    return (
      <div className="file-viewer__media">
        <img src={rawUrl} alt={file.name} />
      </div>
    );
  }
  if (file.kind === "pdf") {
    // iframe 的无障碍名用 aria-label 而不是 title：原生 title 在这个仓库是受管控的存量。
    return <iframe className="file-viewer__pdf" src={rawUrl} aria-label={`${file.name} 预览`} />;
  }
  if (pageUrl && !showSource) return <PageBody url={pageUrl} path={file.path} />;
  if (VIDEO_PATTERN.test(file.path)) {
    return (
      <div className="file-viewer__media">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- 任务产出的视频没有字幕轨可挂 */}
        <video className="file-viewer__video" src={rawUrl} controls preload="metadata" />
      </div>
    );
  }
  if (AUDIO_PATTERN.test(file.path)) {
    return (
      <div className="file-viewer__media">
        <audio className="file-viewer__audio" src={rawUrl} controls preload="metadata" />
      </div>
    );
  }
  if (file.kind === "binary") {
    return (
      <div className="file-viewer__placeholder">
        <b>这是一个二进制文件</b>
        <p>网页里没法有意义地显示它的内容。用上方的「打开方式」交给本机的应用，或者在文件夹中查看。</p>
      </div>
    );
  }
  return <TextBody file={file} />;
}

const EDITABLE = "input, textarea, select, [contenteditable='true'], [contenteditable='']";

/**
 * 左右方向键翻上一张/下一张。
 *
 * **只在图片上接管这两个键**：文本全文和网页源码是横向滚得动的，PDF 与音视频里箭头本来
 * 就有意思（翻页、快进），抢过来等于把人家的键掰坏了。顶栏那两颗按钮不受这条限制——它
 * 们不跟任何东西抢。
 *
 * 挂在冒泡阶段：大图浮层（`ImagePreview`）在捕获阶段拦这两个键翻它自己的那一组，浮层开
 * 着时它先 `stopImmediatePropagation`，这里就收不到——层叠顺序对的那一头赢。
 */
function useReelKeys(enabled: boolean, onStep: ((delta: number) => void) | undefined) {
  useEffect(() => {
    if (!enabled || !onStep) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (event.target instanceof Element && event.target.closest(EDITABLE)) return;
      event.preventDefault();
      onStep(event.key === "ArrowLeft" ? -1 : 1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled, onStep]);
}

/** 顶栏那一组「‹ 3 / 13 ›」。位置紧挨着文件名：翻的是哪一串，看的就是这个名字在变。 */
function ReelControl({
  index,
  total,
  unit,
  onStep,
}: {
  index: number;
  total: number;
  unit: string;
  onStep: (delta: number) => void;
}) {
  return (
    <span className="file-viewer__reel">
      <button
        type="button"
        className="file-viewer__action"
        aria-label={`上一${unit}`}
        onClick={() => onStep(-1)}
      >
        <CaretLeft size={13} weight="bold" aria-hidden="true" />
      </button>
      <small aria-label={`这一组里的第 ${index + 1} 个，共 ${total} 个`}>{index + 1} / {total}</small>
      <button
        type="button"
        className="file-viewer__action"
        aria-label={`下一${unit}`}
        onClick={() => onStep(1)}
      >
        <CaretRight size={13} weight="bold" aria-hidden="true" />
      </button>
    </span>
  );
}

/**
 * 会话区里的文件查看器。
 *
 * 摆在中间那一栏而不是另开弹层：看文件时通常要对着 agent 说话，弹层会把回复框盖住。
 * 关掉它就回到会话，跟审查工作区是同一套「中间区换一块内容」的做法。
 */
export function FileViewer({
  taskId,
  path,
  reel,
  onStep,
  zoomed = false,
  onToggleZoom,
  onExitZoom,
  onOpenDiff,
  onClose,
  notify,
}: {
  taskId: string;
  path: string;
  /**
   * 这份文件是从哪一串里点开的（同一组生成物、同一层文件），按页面上的先后排。给了就能
   * 在这儿直接翻下一张，不用每看一张都回侧栏点一次——十几张截图的任务这是常态。
   */
  reel?: readonly string[] | null;
  onStep?: (delta: number) => void;
  /** 放大态。由 `useFileView` 持有，全文与 diff 互切时才不会掉。 */
  zoomed?: boolean;
  onToggleZoom?: () => void;
  onExitZoom?: () => void;
  /** 「查看改动」：从 diff 切过来的那次才有，点回去还是刚才那一份 diff。 */
  onOpenDiff?: () => void;
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const [file, setFile] = useState<FileContent | null>(null);
  /** 网页预览地址（带令牌，服务端随内容发下来）。不是网页就一直是 null。 */
  const [pageUrl, setPageUrl] = useState<string | null>(null);
  /** 这份网页在沙箱里跑不全时的说明，同样由服务端判定（前端没法知道它加载了什么）。 */
  const [pageNotice, setPageNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revealing, setRevealing] = useState(false);
  // 网页默认渲染、可切回源码。默认摊开渲染那一面：点开一份 html 十有八九是想看它长什么样，
  // 想读源码的人按一下就有；换文件时重置，不然上一个文件选的「源码」会跟着带到下一个。
  const [showSource, setShowSource] = useState(false);
  useEffect(() => setShowSource(false), [path]);
  const zoom = useZoomLayer({
    zoomed,
    onExit: () => onExitZoom?.(),
    label: `放大查看文件：${path}`,
    className: "zoom-layer--file",
  });
  // 删完这个文件就没得看了，跟着关掉这块内容回到会话。
  const deletion = useDeleteEntry({ taskId, notify, onDeleted: () => onClose() });

  const reelIndex = reel ? reel.indexOf(path) : -1;
  // 那一串里得真有这一份、且不止一份，才谈得上翻。`indexOf` 每次渲染都算一遍：十几到
  // 上千个路径的数组，比多存一份索引再操心它跟 path 对不对得上便宜。
  const step = onStep && reel && reel.length > 1 && reelIndex >= 0 ? onStep : null;
  // 认「是不是图」先看文件名、再认服务端给的 kind：内容要等一趟请求回来，而翻页键必须在
  // 图还在路上时就管用——连按两下箭头本来就是翻图时最常见的手势，等 kind 回来第一下就丢了。
  const imageish = isImageName(path) || file?.kind === "image";
  useReelKeys(imageish, step ?? undefined);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api.taskFile(taskId, path)
      .then((result) => {
        if (!alive) return;
        setFile(result.file);
        setPageUrl(result.pageUrl);
        setPageNotice(result.pageNotice);
      })
      .catch((reason) => {
        if (!alive) return;
        setFile(null);
        setPageUrl(null);
        setPageNotice(null);
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [path, taskId]);

  const [openingExternally, setOpeningExternally] = useState(false);
  const openExternally = async () => {
    setOpeningExternally(true);
    try {
      await api.openTaskFile(taskId, path, null);
      notify("已交给本机浏览器打开");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setOpeningExternally(false);
    }
  };

  const reveal = async () => {
    setRevealing(true);
    try {
      await api.revealTaskFile(taskId, path);
      notify("已在文件管理器中定位");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRevealing(false);
    }
  };

  return zoom.render(
    <div className="file-viewer" aria-label="文件查看">
      <header className="file-viewer__bar">
        <div className="file-viewer__title">
          <b>{file?.name ?? path.split("/").pop()}</b>
          <small>{path}{file ? ` · ${formatSize(file.size)}` : ""}</small>
        </div>
        {step && reel && (
          <ReelControl
            index={reelIndex}
            total={reel.length}
            unit={imageish ? "张" : "个"}
            onStep={step}
          />
        )}
        {pageUrl && (
          <button
            type="button"
            className="file-viewer__action"
            aria-pressed={showSource}
            onClick={() => setShowSource((current) => !current)}
          >
            <Code size={13} aria-hidden="true" />
            {showSource ? "看页面" : "看源码"}
          </button>
        )}
        {/* 沙箱预览做不到完全保真（打包后的 JS 里 fetch("/api/…") 改不动），所以网页多给一颗
            直达按钮，而不是让用户到「打开方式」菜单里翻。 */}
        {pageUrl && (
          <button
            type="button"
            className="file-viewer__action"
            disabled={openingExternally}
            onClick={() => void openExternally()}
          >
            <ArrowSquareOut size={13} aria-hidden="true" />
            在浏览器中打开
          </button>
        )}
        {onOpenDiff && (
          <button type="button" className="file-viewer__action" onClick={onOpenDiff}>
            <GitDiff size={13} aria-hidden="true" />
            查看改动
          </button>
        )}
        <button
          type="button"
          className="file-viewer__action"
          disabled={revealing}
          onClick={() => void reveal()}
        >
          <FolderOpen size={13} aria-hidden="true" />
          在文件夹中查看
        </button>
        <OpenWithMenu taskId={taskId} path={path} notify={notify} />
        <button
          type="button"
          className="file-viewer__action"
          aria-label="复制文件的完整路径"
          disabled={!file}
          onClick={async () => {
            if (!file) return;
            try {
              await navigator.clipboard.writeText(file.absPath);
              notify("已复制文件路径");
            } catch {
              notify("浏览器不允许写剪贴板");
            }
          }}
        >
          <Copy size={13} aria-hidden="true" />
        </button>
        {/* 删除单独成组：跟「关闭」之间隔一道竖线，避免顺手点到。真正的防线是那个确认框。 */}
        <span className="file-viewer__danger-group">
          <button
            type="button"
            className="file-viewer__action is-danger"
            aria-label={`删除文件 ${path}`}
            disabled={!!deletion.preparing}
            onClick={() => void deletion.ask(path)}
          >
            <Trash size={13} aria-hidden="true" />
            {deletion.preparing ? "准备中…" : "删除"}
          </button>
          {onToggleZoom && <ZoomToggle zoomed={zoomed} onToggle={onToggleZoom} className="file-viewer__action" />}
          <button type="button" className="file-viewer__action" aria-label="关闭文件，回到会话" onClick={onClose}>
            <X size={13} aria-hidden="true" />
          </button>
        </span>
      </header>

      {file?.truncated && (
        <p className="file-viewer__notice">
          <Warning size={12} aria-hidden="true" />
          文件超过 2 MB，只显示了前面一部分。要看全文请用本机应用打开。
        </p>
      )}

      {/* 跑不全的网页当面说清楚，并把外部打开摆在话旁边——不让用户对着一个空壳猜是不是坏了。 */}
      {pageNotice && !showSource && (
        <p className="file-viewer__notice">
          <Warning size={12} aria-hidden="true" />
          {pageNotice}
          <button
            type="button"
            className="file-viewer__notice-action"
            disabled={openingExternally}
            onClick={() => void openExternally()}
          >
            在浏览器中打开
          </button>
        </p>
      )}

      <div className="file-viewer__body">
        {loading && <p className="file-viewer__state"><SpinnerGap size={14} aria-hidden="true" />正在读取…</p>}
        {error && <p className="file-viewer__state is-error"><Warning size={14} aria-hidden="true" />{error}</p>}
        {!loading && !error && file && (
          <Body taskId={taskId} file={file} pageUrl={pageUrl} showSource={showSource} />
        )}
      </div>
      {deletion.dialog}
    </div>,
  );
}
