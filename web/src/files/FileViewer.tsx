import { useEffect, useMemo, useState } from "react";
import { ArrowSquareOut, Code, Copy, FolderOpen, GitDiff, SpinnerGap, Trash, Warning, X } from "@phosphor-icons/react";
import { api, type FileContent } from "../lib/api.ts";
import { useZoomLayer, ZoomToggle } from "../lib/zoomLayer.tsx";
import { formatSize } from "./fileModel.ts";
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

/**
 * 会话区里的文件查看器。
 *
 * 摆在中间那一栏而不是另开弹层：看文件时通常要对着 agent 说话，弹层会把回复框盖住。
 * 关掉它就回到会话，跟审查工作区是同一套「中间区换一块内容」的做法。
 */
export function FileViewer({
  taskId,
  path,
  zoomed = false,
  onToggleZoom,
  onExitZoom,
  onOpenDiff,
  onClose,
  notify,
}: {
  taskId: string;
  path: string;
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
