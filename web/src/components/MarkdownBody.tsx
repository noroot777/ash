import { useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { CaretDown, X } from "@phosphor-icons/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ImagePreviewGroup, PreviewableImage, PreviewableImageLink } from "./ImagePreview.tsx";
import { splitReviewReport } from "./reviewReportSections.ts";
import {
  imagePreviewTarget,
  isLocalDiskImagePath,
  localOpenUrl,
  openLocalPath,
  remarkSoftBreaks,
  reviewFileTarget,
  type ReviewFileTarget,
} from "./markdownPolicy.ts";

function MarkdownDocument({ text, onReviewReport, onActionError }: {
  text: string;
  onReviewReport: (target: ReviewFileTarget) => void;
  onActionError: (message: string | null) => void;
}) {
  return (
    <div className="task-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkSoftBreaks]}
        components={{
          a: ({ node: _node, href, onClick, ...props }) => {
            const reviewFile = reviewFileTarget(href);
            const reviewMarkdown = reviewFile !== null && /\.md$/i.test(reviewFile.name);
            const localOpen = localOpenUrl(href);
            // 指向图片的链接跟内嵌图走同一个灯箱（也就跟同一条消息里的其它图编在一组，
            // 能左右翻）。按住 ⌘/Ctrl/Shift 或中键仍然是浏览器原来那套「新标签页打开」，
            // 由 PreviewableImageLink 自己让路。
            const image = imagePreviewTarget(href);
            if (image) {
              return (
                <PreviewableImageLink
                  {...props}
                  src={image.url}
                  href={image.url}
                  alt={image.name}
                  label={image.name}
                  onClick={onClick}
                />
              );
            }
            return (
              <a
                {...props}
                href={reviewFile?.url ?? localOpen ?? href}
                target={localOpen || reviewMarkdown ? undefined : "_blank"}
                rel={localOpen || reviewMarkdown ? undefined : "noreferrer"}
                onClick={(event) => {
                  onClick?.(event);
                  if (event.defaultPrevented) return;
                  if (reviewMarkdown) {
                    event.preventDefault();
                    onReviewReport(reviewFile);
                    return;
                  }
                  if (!localOpen) return;
                  event.preventDefault();
                  onActionError(null);
                  void openLocalPath(href || localOpen).catch((reason: unknown) => {
                    onActionError(reason instanceof Error ? reason.message : String(reason));
                  });
                }}
              />
            );
          },
          img: ({ src, alt }) => {
            const raw = typeof src === "string" ? src : "";
            const image = imagePreviewTarget(raw);
            if (!image && isLocalDiskImagePath(raw)) return null;
            return (
              <PreviewableImage
                className="task-markdown-image"
                src={image?.url ?? raw}
                alt={alt ?? ""}
                label={alt || image?.name}
              />
            );
          },
          table: ({ children, ...props }) => (
            <div className="task-markdown-table">
              <table {...props}>{children}</table>
            </div>
          ),
          pre: ({ children }) => <pre className="task-code-block">{children}</pre>,
          code: ({ children, className }) => <code className={className}>{children}</code>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/**
 * 审查报告正文：摘要段铺开，技术明细收进开关。拆不动（存量报告不合契约）就整篇铺开，
 * 不会把内容藏掉——判据和理由见 `reviewReportSections.ts`。
 *
 * 明细用条件渲染而不是 `hidden`：折叠着的那半截里的截图不该混进 `ImagePreviewGroup`
 * 的灯箱队列，否则左右翻会翻到屏幕上根本没有的图。
 */
function ReviewReportSplit({ text, onReviewReport, onActionError }: {
  text: string;
  onReviewReport: (target: ReviewFileTarget) => void;
  onActionError: (message: string | null) => void;
}) {
  const { summary, detail } = useMemo(() => splitReviewReport(text), [text]);
  const [open, setOpen] = useState(false);
  const detailId = useId();
  if (!detail) return <MarkdownDocument text={text} onReviewReport={onReviewReport} onActionError={onActionError} />;
  return (
    <>
      <MarkdownDocument text={summary} onReviewReport={onReviewReport} onActionError={onActionError} />
      <button
        type="button"
        className={`review-report-more${open ? " is-open" : ""}`}
        aria-expanded={open}
        aria-controls={open ? detailId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <CaretDown size={11} weight="bold" aria-hidden="true" />
        {open ? "收起技术明细" : "展开技术明细（验证过程、证据、清场记录）"}
      </button>
      {open && (
        <div id={detailId} className="review-report-detail">
          <MarkdownDocument text={detail} onReviewReport={onReviewReport} onActionError={onActionError} />
        </div>
      )}
    </>
  );
}

/** 跟 `MarkdownBody` 同构，只是正文走上面的拆分。报告以外的地方别用它。 */
export function ReviewReportBody({ text }: { text: string }) {
  const [reviewReport, setReviewReport] = useState<ReviewFileTarget | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  return (
    <ImagePreviewGroup>
      <ReviewReportSplit text={text} onReviewReport={setReviewReport} onActionError={setActionError} />
      {actionError && <p className="markdown-action-error" role="status">本地文件打开失败：{actionError}</p>}
      {reviewReport && (
        <ReviewReportDialog target={reviewReport} onReviewReport={setReviewReport} onClose={() => setReviewReport(null)} />
      )}
    </ImagePreviewGroup>
  );
}

export function ReviewReportDialog({ target, onReviewReport, onClose }: {
  target: ReviewFileTarget;
  onReviewReport: (target: ReviewFileTarget) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setText(null);
    setError(null);
    setActionError(null);
    void fetch(target.url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`);
        return response.text();
      })
      .then(setText)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => controller.abort();
  }, [target.url]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    document.addEventListener("keydown", close, true);
    return () => document.removeEventListener("keydown", close, true);
  }, [onClose]);

  return createPortal(
    <div
      className="markdown-report-scrim"
      role="presentation"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="markdown-report-dialog" role="dialog" aria-modal="true" aria-labelledby="markdown-report-title">
        <header>
          <div><span>审查报告</span><h2 id="markdown-report-title">{target.name}</h2></div>
          <button type="button" autoFocus aria-label="关闭审查报告" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="markdown-report-body">
          {text !== null ? (
            <ImagePreviewGroup isolated>
              <ReviewReportSplit text={text} onReviewReport={onReviewReport} onActionError={setActionError} />
            </ImagePreviewGroup>
          ) : error ? (
            <p className="markdown-report-error">审查报告加载失败：{error}</p>
          ) : (
            <p className="markdown-report-loading">正在加载审查报告…</p>
          )}
          {actionError && <p className="markdown-action-error" role="status">本地文件打开失败：{actionError}</p>}
        </div>
      </section>
    </div>,
    document.body,
  );
}

export function MarkdownBody({ text }: { text: string }) {
  const [reviewReport, setReviewReport] = useState<ReviewFileTarget | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  return (
    <ImagePreviewGroup>
      <MarkdownDocument text={text} onReviewReport={setReviewReport} onActionError={setActionError} />
      {actionError && <p className="markdown-action-error" role="status">本地文件打开失败：{actionError}</p>}
      {reviewReport && (
        <ReviewReportDialog target={reviewReport} onReviewReport={setReviewReport} onClose={() => setReviewReport(null)} />
      )}
    </ImagePreviewGroup>
  );
}
