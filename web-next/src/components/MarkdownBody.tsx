import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownBody({
  text,
  onPreview,
}: {
  text: string;
  onPreview?: (url: string, name: string) => void;
}) {
  return (
    <div className="task-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
          img: ({ src, alt }) => {
            const url = typeof src === "string" ? src : "";
            if (!onPreview) return <img src={url} alt={alt ?? ""} />;
            return (
              <button className="task-markdown-image" type="button" onClick={() => onPreview(url, alt ?? "图片")}>
                <img src={url} alt={alt ?? ""} />
              </button>
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
