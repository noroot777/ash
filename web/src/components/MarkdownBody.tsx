import { useEffect, useId, useMemo, useRef, useState } from "react";
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
 * 认不出摘要时，首屏最多铺这么高（px），余下的收进「展开完整报告」。
 *
 * 这个数只写在这里，CSS 不重复——`max-height` 由行内样式给，两边没法漂。判「要不要收」
 * 不看行数、不看 `kind`，量的是**渲染出来到底多高**。
 *
 * `WHOLE_SLACK` 是「值不值得给这个按钮」的门槛：夹住得真省下东西。全库整篇铺开的 4 份
 * 真实报告按对话栏宽度量，是 844 / 993 / 1993 / 2015px——844 那份（34 行）只比上限高
 * 200px，夹了它等于让人为了 200px 多点一下；993 行往上才是用户说的「几十行合规证明糊
 * 一脸」。所以只有**藏起来的比小半屏还多**时才夹。
 */
const WHOLE_CLAMP = 640;
const WHOLE_SLACK = 240;

/**
 * 审查报告正文：铺开一半、收起一半。分两档——按契约拆的报告折的是技术明细，认不出契约的
 * 存量报告折的是「第一个 `##` 起的全部内容」，按钮文案跟着换。判据和理由见
 * `reviewReportSections.ts`。
 *
 * 第三档是**拆不动**（解析器认不出摘要边界）：这时一个字都不敢往折叠里放——问题可能写在
 * 任何一节里，按结构猜拆点会把它藏掉。但「认不出」不等于「活该糊人一脸」：`_wWMPNIsrXF7`
 * 那份 111 行的真实报告先写任务元数据、再写编译记录，`## 2. 高优先级缺陷` 在第 24 行往后，
 * 按首节拆会把 P1～P3 全藏起来，不拆又要用户先滚过几十行验证记录。所以这一档换个折法：
 * **不猜边界，按高度夹**——铺的仍是报告自己的开头，一个字没被重排，按钮也还是什么都不
 * 宣称的「展开完整报告」。用户点名要的结构保证（「不会被 46 行合规证明糊一脸」）这才对
 * 所有报告都成立，而不是只对解析得出摘要的那些。
 *
 * 明细用条件渲染而不是 `hidden`：折叠着的那半截里的截图不该混进 `ImagePreviewGroup`
 * 的灯箱队列，否则左右翻会翻到屏幕上根本没有的图。夹住的那一档是例外——它整篇都在 DOM
 * 里，只是视觉上截断，所以灯箱队列本来就是全的。
 *
 * 换一份报告就**硬复位成折叠**：侧栏的轮次抽屉在同一个位置换报告，组件不会重新挂载，
 * 独立 `useState` 会把上一轮展开着的状态串给下一轮——换一轮报告一打开就是满屏命令输出，
 * 恰好是这个改动要消灭的东西。
 *
 * 判「换了没有」要用 `reportKey` 而不是正文：**正文相同不等于同一份报告**。两轮报告一字
 * 不差是会发生的（同一处没修好、原样重报一遍），那时按正文判就认不出换过轮，上一轮展开
 * 的明细直接留在新轮次的标题底下。`reportKey` 因此是必填的——多一个调用点忘了传，得当场
 * 编译不过，而不是等下一份一字不差的报告来暴露。正文也一起比：同一轮的报告在写入过程中
 * 被刷新时，宁可收起来重看，也别让人对着半截明细读。
 *
 * 复位写在渲染期（React 官方的「prop 变了就调整 state」写法）而不是 `useEffect`：effect
 * 要等提交后才跑，中间会闪一帧展开态。也不要改成「记住展开过哪一份」那种派生写法——
 * 那样切走再切回来它又自己展开了，于是「打开报告第一眼是结论」这个保证会带一个取决于
 * 不可见历史的例外。回到一份读过的报告，行为必须跟第一次打开它完全一样。
 */
function ReviewReportSplit({ text, reportKey, onReviewReport, onActionError }: {
  text: string;
  reportKey: string;
  onReviewReport: (target: ReviewFileTarget) => void;
  onActionError: (message: string | null) => void;
}) {
  const { summary, detail, kind } = useMemo(() => splitReviewReport(text), [text]);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState({ key: reportKey, text });
  const [tall, setTall] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const detailId = useId();
  if (shown.key !== reportKey || shown.text !== text) {
    setShown({ key: reportKey, text });
    setOpen(false);
  }
  // 量的是**没被夹住的自然高度**：夹子挂在外层，这个 ref 指着里层，所以展开与否都量得准。
  // 图片是后到的，高度会变，所以挂 `ResizeObserver` 而不是只量一次——量早了会漏画按钮。
  useEffect(() => {
    const node = body.current;
    if (!node) {
      setTall(false);
      return;
    }
    const measure = () => setTall(node.scrollHeight > WHOLE_CLAMP + WHOLE_SLACK);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text, detail]);

  if (!detail) {
    const clamped = tall && !open;
    return (
      <>
        <div
          id={detailId}
          className={`review-report-whole${clamped ? " is-clamped" : ""}`}
          style={clamped ? { maxHeight: WHOLE_CLAMP } : undefined}
        >
          <div ref={body}>
            <MarkdownDocument text={text} onReviewReport={onReviewReport} onActionError={onActionError} />
          </div>
        </div>
        {tall && (
          <button
            type="button"
            className={`review-report-more${open ? " is-open" : ""}`}
            aria-expanded={open}
            aria-controls={detailId}
            onClick={() => setOpen((value) => !value)}
          >
            <CaretDown size={11} weight="bold" aria-hidden="true" />
            {open ? "收起完整报告" : "展开完整报告"}
          </button>
        )}
      </>
    );
  }
  // 按钮只能照 `kind` 说话。按契约拆的那一档能担保折叠里只有技术记录；降级那一档折的是
  // 报告余下的全部内容，**问题可能就在里面**，所以一个字都不许替它宣称。`kind` 万一漏了
  // 一档，落到不作承诺的那句上——猜错方向的代价不对称。
  const label = kind === "contract"
    ? { open: "收起技术明细", closed: "展开技术明细（验证过程、证据、清场记录）" }
    : { open: "收起完整报告", closed: "展开完整报告" };
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
        {open ? label.open : label.closed}
      </button>
      {open && (
        <div id={detailId} className="review-report-detail">
          <MarkdownDocument text={detail} onReviewReport={onReviewReport} onActionError={onActionError} />
        </div>
      )}
    </>
  );
}

/**
 * 跟 `MarkdownBody` 同构，只是正文走上面的拆分。报告以外的地方别用它。
 *
 * `reportKey` 必填：它是这份报告的身份（哪一次审查的第几轮），折叠状态靠它复位。
 */
export function ReviewReportBody({ text, reportKey }: { text: string; reportKey: string }) {
  const [reviewReport, setReviewReport] = useState<ReviewFileTarget | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  return (
    <ImagePreviewGroup>
      <ReviewReportSplit
        text={text}
        reportKey={reportKey}
        onReviewReport={setReviewReport}
        onActionError={setActionError}
      />
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
              <ReviewReportSplit text={text} reportKey={target.url} onReviewReport={onReviewReport} onActionError={setActionError} />
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
