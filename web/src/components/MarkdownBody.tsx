import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CaretDown, X } from "@phosphor-icons/react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReviewConclusion } from "@ash/shared";
import { ImagePreviewGroup, PreviewableImage, PreviewableImageLink } from "./ImagePreview.tsx";
import { splitReviewReport } from "./reviewReportSections.ts";
import { useEvidenceNames } from "./useEvidenceNames.ts";
import {
  imageOriginLabel,
  imagePreviewTarget,
  isLocalImageReference,
  unavailableImageOrigin,
  localOpenUrl,
  openLocalPath,
  remarkSoftBreaks,
  reviewFileTarget,
  sameOriginUrl,
  evidenceListingUrl,
  siblingResolverForUrl,
  type MarkdownFileResolver,
  type ReviewFileTarget,
} from "./markdownPolicy.ts";

/**
 * 正文里的一张图。**站内取不到字节就整个消失**，绝不留一个裂开的图标。
 *
 * 必要性：解析器只能判断「这个地址站内服务得了」，判断不了「那个文件此刻还在不在」。
 * 工作目录被清掉、文件被 agent 删掉、证据目录被删，地址都还拼得出来，但请求是 404 ——
 * 画出来就是用户 2026-10-21 报的那一幕：一个裂图标配一行标题，读起来像「这个功能坏了」。
 * 看不到那张图是事实，但那是「图没了」，不该长成「页面坏了」。
 *
 * **只收站内的**：同源地址是我们自己服务的，取不到就等于那个文件真没了；站外地址取不到
 * 可能只是此刻连不上（要翻墙、要内网），这时候浏览器拿 alt 文字画出来的那个占位反而是
 * 更诚实的交代，不归这条收。
 *
 * 按 src 记而不是一个布尔：同一个位置换了地址（重渲染、换任务）要重新试一次。
 */
/**
 * 取不到的那张图留一行小字，而不是悄悄消失。
 *
 * 为什么要有它：裂图标会被读成「这个功能坏了」，所以这里一度是 `return null` —— 整张图
 * 连带 agent 写的那句「看这张」一起无声蒸发，用户只能得出同一个结论，而且连「哪个文件
 * 取不到」都看不见（审查第 1 轮非阻塞项：存/读失败时任务内没有任何可见提示）。
 *
 * 只写**事实**，不猜原因：同一行小字下面可能是「服务端没存下副本」「工作目录被清掉了」
 * 「文件后来被删了」「关联不可信所以不敢画」，渲染点分不出是哪一种（`onError` 连状态码
 * 都拿不到）。所以只报「取不到」加上 agent 原文写的那个地址 —— 那是唯一能让人自己去核
 * 实的东西。
 */
function MissingImage({ origin, alt }: { origin: string; alt?: string }) {
  return (
    <span className="task-markdown-image-missing">
      <span className="task-markdown-image-missing-tag">图取不到</span>
      <code>{alt ? `${alt} · ${imageOriginLabel(origin)}` : imageOriginLabel(origin)}</code>
    </span>
  );
}

function MarkdownImage({ alt, origin, chain }: {
  alt: string;
  /** agent 在正文里写的原地址（`chain` 里的可能已经被改写成站内接口），小字里报的是它。 */
  origin: string;
  /** 按顺序试的几个地址（见 markdownPolicy 的 ImagePreviewTarget.fallback），至少一个。 */
  chain: { url: string; name?: string }[];
}) {
  const [failed, setFailed] = useState<string[]>([]);
  const current = chain.find((candidate) => !failed.includes(candidate.url));
  if (!current) return <MissingImage origin={origin} alt={alt} />;
  return (
    <PreviewableImage
      className="task-markdown-image"
      src={current.url}
      alt={alt}
      label={alt || current.name}
      // 站外地址失败照旧交给浏览器自己的 alt：那是对面站点的事，报「取不到」帮不上忙，
      // 也不该据此去试下一个地址（下一个是本机根的解释，跟站外那张没关系）。
      onError={() => { if (sameOriginUrl(current.url)) setFailed([...failed, current.url]); }}
    />
  );
}

function MarkdownDocument({ text, resolveFile, onReviewReport, onActionError }: {
  text: string;
  /** 这份正文里的相对路径按哪儿解（见 markdownPolicy 的 MarkdownFileResolver）。 */
  resolveFile?: MarkdownFileResolver;
  onReviewReport: (target: ReviewFileTarget) => void;
  onActionError: (message: string | null) => void;
}) {
  return (
    <div className="task-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkSoftBreaks]}
        // 图片地址**原样交给我们自己判**:react-markdown 默认会把它不认的协议整个清空,
        // 于是没来得及被改写的 `file:///…/shot.png` 到 img 这里只剩空串 —— 既画不出来,也
        // 报不出「哪个文件取不到」(连路径都没了,审查第 2 轮 F2 的失败分支)。img 的 src
        // 不会被当成可执行地址,分类与越界判定全在 markdownPolicy + 服务端那道门禁;链接
        // (href)仍走默认清理,那条才是 `javascript:` 的入口。
        urlTransform={(url, key) => (key === "src" ? url : defaultUrlTransform(url))}
        components={{
          a: ({ node: _node, href, onClick, ...props }) => {
            const reviewFile = reviewFileTarget(href) ?? resolveFile?.(href ?? "") ?? null;
            const reviewMarkdown = reviewFile !== null && /\.md$/i.test(reviewFile.name);
            const localOpen = localOpenUrl(href);
            // 指向图片的链接跟内嵌图走同一个灯箱（也就跟同一条消息里的其它图编在一组，
            // 能左右翻）。按住 ⌘/Ctrl/Shift 或中键仍然是浏览器原来那套「新标签页打开」，
            // 由 PreviewableImageLink 自己让路。
            const image = imagePreviewTarget(href, resolveFile);
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
            // 空地址也**一个字都不画**：react-markdown 的 urlTransform 会把它不认的协议
            // （`file:` 就是一个）整个清空，画出来就是一张没有 src 的裂图（审查第 1 轮 F2）。
            if (!raw) return null;
            // 作废标记:归属不可信那一处,任何 resolver 都不许再把它救活成当前文件
            // (审查第 2 轮 F1)。必须在解析之前就认掉。
            const unavailable = unavailableImageOrigin(raw);
            if (unavailable) return <MissingImage origin={unavailable} alt={alt} />;
            const image = imagePreviewTarget(raw, resolveFile);
            // 解不出来的本机路径（agent 自己机器上的地址，浏览器一个都取不到）报一行小字。
            if (!image && isLocalImageReference(raw)) return <MissingImage origin={raw} alt={alt} />;
            const chain = image
              ? [{ url: image.url, name: image.name }, ...(image.fallback ? [image.fallback] : [])]
              : [{ url: raw }];
            return <MarkdownImage chain={chain} alt={alt ?? ""} origin={raw} />;
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
 * 报告照格式写了、问题却超过 5 条时，摘要**自己再折一层**（`sections.more`）：前 5 条铺开，
 * 其余收进「展开其余 N 条问题」，第四栏「不拦验收、但你该知道的」跨过这一层继续留在首屏。
 * 两个折叠完全独立——各自的 state、各自的 `aria-controls`、各自的文案，里面那个装的是问题，
 * 绝不许套用技术明细那句承诺。中段同样是条件渲染，理由跟明细一样。
 *
 * 换一份报告就**硬复位成折叠**：侧栏的轮次抽屉在同一个位置换报告，组件不会重新挂载，
 * 独立 `useState` 会把上一轮展开着的状态串给下一轮——换一轮报告一打开就是满屏命令输出，
 * 恰好是这个改动要消灭的东西。**两个折叠都得复位**，漏一个就是漏一个。
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
function ReviewReportSplit({ text, reportKey, conclusion, resolveFile, onReviewReport, onActionError }: {
  text: string;
  reportKey: string;
  conclusion: ReviewConclusion;
  resolveFile?: MarkdownFileResolver;
  onReviewReport: (target: ReviewFileTarget) => void;
  onActionError: (message: string | null) => void;
}) {
  const { summary, more, rest, aside, detail, kind } = useMemo(
    () => splitReviewReport(text, conclusion),
    [text, conclusion],
  );
  const [open, setOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [shown, setShown] = useState({ key: reportKey, text });
  const [tall, setTall] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const detailId = useId();
  const moreId = useId();
  if (shown.key !== reportKey || shown.text !== text) {
    setShown({ key: reportKey, text });
    setOpen(false);
    setMoreOpen(false);
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
            <MarkdownDocument text={text} resolveFile={resolveFile} onReviewReport={onReviewReport} onActionError={onActionError} />
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
  // 按钮只能照 `kind` 说话，而 `kind` 只由权威结论 `conclusion` 决定（见
  // `reviewReportSections.ts`）。权威结论说这一轮通过、切点又落在报告自己的结论节之后，
  // 折叠里就不可能有拦验收的问题；其余一切情况折的是报告余下的全部内容，**问题可能就在
  // 里面**，所以一个字都不许替它宣称。`kind` 万一漏了一档，落到不作承诺的那句上。
  const label = kind === "contract"
    ? { open: "收起技术明细", closed: "展开技术明细（验证过程、证据、清场记录）" }
    : { open: "收起完整报告", closed: "展开完整报告" };
  const part = (section: string) => (
    <MarkdownDocument text={section} resolveFile={resolveFile} onReviewReport={onReviewReport} onActionError={onActionError} />
  );
  return (
    <>
      {part(summary)}
      {/* 中段那个折叠装的是**问题**，不是技术记录。按钮照实说它有几条——名字就是内容，
          所以它跟权威结论无关，`verified` 与否都照折照说。 */}
      {more && (
        <>
          <button
            type="button"
            className={`review-report-more${moreOpen ? " is-open" : ""}`}
            aria-expanded={moreOpen}
            aria-controls={moreOpen ? moreId : undefined}
            onClick={() => setMoreOpen((value) => !value)}
          >
            <CaretDown size={11} weight="bold" aria-hidden="true" />
            {moreOpen ? `收起其余 ${rest} 条问题` : `展开其余 ${rest} 条问题`}
          </button>
          {moreOpen && (
            <div id={moreId} className="review-report-detail review-report-rest">
              {part(more)}
            </div>
          )}
        </>
      )}
      {aside && part(aside)}
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
          {part(detail)}
        </div>
      )}
    </>
  );
}

/**
 * 跟 `MarkdownBody` 同构，只是正文走上面的拆分。报告以外的地方别用它。
 *
 * `reportKey` 必填：它是这份报告的身份（哪一次审查的第几轮），折叠状态靠它复位。
 * `conclusion` 是这一轮的权威结论，决定折叠按钮敢不敢说折叠里装着什么；拿不到就传
 * `null`（按钮跟着什么都不说）。
 */
export function ReviewReportBody({ text, reportKey, conclusion, resolveFile }: {
  text: string;
  reportKey: string;
  conclusion: ReviewConclusion;
  /** 报告里的 `![](shot.png)` 指的是**证据目录里**那张截图，调用点必须把那个目录交代清楚。 */
  resolveFile?: MarkdownFileResolver;
}) {
  const [reviewReport, setReviewReport] = useState<ReviewFileTarget | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  return (
    <ImagePreviewGroup>
      <ReviewReportSplit
        text={text}
        reportKey={reportKey}
        conclusion={conclusion}
        resolveFile={resolveFile}
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
  // 这一轮证据目录里服务得了的文件清单：地址从报告自己的地址推出来（run/round 都在里面）。
  const listing = evidenceListingUrl(target.url);
  const evidenceNames = useEvidenceNames(
    listing ? () => fetch(listing).then((r) => r.ok ? r.json() as Promise<{ names?: string[] }> : null).then((body) => body?.names ?? []) : null,
    listing ?? "",
  );

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
              {/* 这个弹窗打开的是一份**孤立的报告文件**（正文里的 report.md 链接），手上
                  没有它属于哪一轮，也就拿不到权威结论——按钮跟着什么都不宣称。 */}
              {/* 相对路径按**这份报告自己所在的目录**解：弹窗手上只有它的地址，run/round 都没有。
                  文档根归属仍然按清单算（清单地址也从这个地址推出来，见 evidenceListingUrl）——
                  这里曾经是唯一一处只能靠「第一个地址加载失败再换」的表面。 */}
              <ReviewReportSplit text={text} reportKey={target.url} conclusion={null} resolveFile={siblingResolverForUrl(target.url, evidenceNames)} onReviewReport={onReviewReport} onActionError={setActionError} />
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

export function MarkdownBody({ text, resolveFile }: { text: string; resolveFile?: MarkdownFileResolver }) {
  const [reviewReport, setReviewReport] = useState<ReviewFileTarget | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  return (
    <ImagePreviewGroup>
      <MarkdownDocument text={text} resolveFile={resolveFile} onReviewReport={setReviewReport} onActionError={setActionError} />
      {actionError && <p className="markdown-action-error" role="status">本地文件打开失败：{actionError}</p>}
      {reviewReport && (
        <ReviewReportDialog target={reviewReport} onReviewReport={setReviewReport} onClose={() => setReviewReport(null)} />
      )}
    </ImagePreviewGroup>
  );
}
