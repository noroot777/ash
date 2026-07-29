import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "./api";
import { PreviewableMarkdownImage } from "./ImagePreview";
import { Modal } from "./Modal";
import { toast } from "./toast";

const REVIEW_FILE_PATH = /\/data\/runs\/([\w-]+)\/review\/round-(\d+)\/([^/]+)$/;

type ReviewFileTarget = {
  name: string;
  url: string;
};

function reviewFileTarget(path?: string): ReviewFileTarget | null {
  if (!path) return null;
  const match = path.match(REVIEW_FILE_PATH);
  if (!match) return null;
  const [, taskId, round, encodedName] = match;
  let name = encodedName;
  try {
    // react-markdown URL-encodes non-ASCII characters and spaces before handing
    // destinations to renderers. Decode once so taskReviewFileUrl can encode the
    // actual filename exactly once for the review-file endpoint.
    name = decodeURIComponent(encodedName);
  } catch {
    // Keep malformed percent escapes unchanged; the server remains the final
    // authority for allowed filenames and path safety.
  }
  return { name, url: api.taskReviewFileUrl(taskId, Number(round), name) };
}

// open-local 链接只认 pathname——agent 写链接时可能带 localhost / tailnet 任一 host,
// 统一改写到当前 origin 请求,避免「在 tailnet 页面点到 localhost 链接」这类跨 host 失效。
function isLocalOpenHref(href?: string): href is string {
  if (!href) return false;
  try {
    return new URL(href, window.location.origin).pathname === "/api/open-local";
  } catch {
    return false;
  }
}

async function openLocalPath(href: string) {
  const url = new URL(href, window.location.origin);
  const r = await fetch(`/api/open-local?${url.searchParams.toString()}`);
  if (!r.ok) throw new Error(await r.text());
}

// 单个换行在标准 markdown 里会被当成软换行(渲染成空格),但这里的正文——随手记、
// agent 输出、辩论发言——都是「聊天体」文本:用户/模型敲的回车就是想换行,原样保留
// 才对得上编辑时看到的样子。等价于 remark-breaks,自己写是为了不为二十行逻辑加依赖。
type MdNode = { type: string; value?: string; children?: MdNode[] };

function hardenSoftBreaks(node: MdNode) {
  if (!node.children) return;
  const out: MdNode[] = [];
  for (const child of node.children) {
    // 代码块/行内代码是 code / inlineCode 节点(没有 children),天然不会走进这一支
    if (child.type === "text" && child.value?.includes("\n")) {
      child.value.split("\n").forEach((part, i) => {
        if (i) out.push({ type: "break" });
        if (part) out.push({ type: "text", value: part });
      });
    } else {
      hardenSoftBreaks(child);
      out.push(child);
    }
  }
  node.children = out;
}

const remarkSoftBreaks = () => hardenSoftBreaks;

function ReviewReportModal({
  name,
  url,
  onClose,
}: ReviewFileTarget & { onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setText(null);
    setError(null);
    void fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          const detail = await response.text();
          throw new Error(detail || `HTTP ${response.status}`);
        }
        return response.text();
      })
      .then(setText)
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        const message = reason instanceof Error ? reason.message : String(reason);
        setError(message);
        toast(`审查报告加载失败：${message}`);
      });
    return () => controller.abort();
  }, [url]);

  return (
    <Modal
      title={`审查报告 · ${name}`}
      onClose={onClose}
      width={880}
      contentClassName="overflow-y-auto p-4"
    >
      {text !== null ? (
        <Markdown text={text} />
      ) : error ? (
        <p className="text-[13px] text-red-700">审查报告加载失败：{error}</p>
      ) : (
        <p className="text-[13px] text-faint">正在加载审查报告…</p>
      )}
    </Modal>
  );
}

// Render agent/debate output as GitHub-flavored markdown, styled with the app's
// design tokens (no typography plugin). Used inside chat bubbles (§12).
export function Markdown({ text }: { text: string }) {
  const [reviewReport, setReviewReport] = useState<ReviewFileTarget | null>(null);
  return (
    <div className="text-[13px] leading-relaxed text-ink">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkSoftBreaks]}
        components={{
          h1: (p) => <h1 className="mb-1 mt-2 text-[15px] font-semibold first:mt-0" {...p} />,
          h2: (p) => <h2 className="mb-1 mt-2 text-[14px] font-semibold first:mt-0" {...p} />,
          h3: (p) => <h3 className="mb-1 mt-2 text-[13px] font-semibold first:mt-0" {...p} />,
          h4: (p) => <h4 className="mb-1 mt-2 text-[13px] font-medium first:mt-0" {...p} />,
          p: (p) => <p className="my-1.5 wrap-anywhere first:mt-0 last:mb-0" {...p} />,
          ul: (p) => <ul className="my-1.5 list-disc pl-5" {...p} />,
          ol: (p) => <ol className="my-1.5 list-decimal pl-5" {...p} />,
          li: (p) => <li className="my-0.5 wrap-anywhere" {...p} />,
          strong: (p) => <strong className="font-semibold text-ink" {...p} />,
          em: (p) => <em className="italic" {...p} />,
          img: ({ src, ...p }) => {
            const reviewFile = reviewFileTarget(src);
            return <PreviewableMarkdownImage src={reviewFile?.url ?? src} {...p} />;
          },
          a: ({ node: _n, href, onClick, ...p }) => {
            const reviewFile = reviewFileTarget(href);
            const reviewMarkdown = reviewFile !== null && /\.md$/i.test(reviewFile.name);
            const localOpen = isLocalOpenHref(href);
            return (
              <a
                className="break-all text-accent underline underline-offset-2 hover:text-accent-hover"
                href={reviewFile?.url ?? href}
                target={localOpen || reviewMarkdown ? undefined : "_blank"}
                rel={localOpen || reviewMarkdown ? undefined : "noreferrer"}
                onClick={(e) => {
                  onClick?.(e);
                  if (e.defaultPrevented) return;
                  if (reviewMarkdown) {
                    e.preventDefault();
                    setReviewReport(reviewFile);
                  } else if (localOpen) {
                    e.preventDefault();
                    void openLocalPath(href).catch((err) => toast(err instanceof Error ? err.message : String(err)));
                  }
                }}
                {...p}
              />
            );
          },
          blockquote: (p) => (
            <blockquote className="my-1.5 border-l-2 border-line2 pl-3 text-muted" {...p} />
          ),
          hr: () => <hr className="my-2.5 border-line" />,
          pre: ({ children }) => <pre className="my-1.5 overflow-x-auto">{children}</pre>,
          code: ({ className, children, ...p }) => {
            const block = (className ?? "").includes("language-");
            return block ? (
              <code
                className="block rounded-md border border-line bg-raised px-2.5 py-2 font-mono text-[12px] leading-snug"
                {...p}
              >
                {children}
              </code>
            ) : (
              <code className="break-all rounded bg-overlay px-1 py-0.5 font-mono text-[12px]" {...p}>
                {children}
              </code>
            );
          },
          table: (p) => (
            <div className="my-1.5 overflow-x-auto">
              <table className="w-full border-collapse text-[12px]" {...p} />
            </div>
          ),
          th: (p) => <th className="border border-line px-2 py-1 text-left font-medium" {...p} />,
          td: (p) => <td className="border border-line px-2 py-1 align-top wrap-anywhere" {...p} />,
        }}
      >
        {text}
      </ReactMarkdown>
      {reviewReport && <ReviewReportModal {...reviewReport} onClose={() => setReviewReport(null)} />}
    </div>
  );
}
