import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ImagePreviewGroup, PreviewableImage } from "./ImagePreview.tsx";

export function MarkdownBody({ text }: { text: string }) {
  return (
    <ImagePreviewGroup>
      <div className="task-markdown">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
            img: ({ src, alt }) => (
              <PreviewableImage className="task-markdown-image" src={typeof src === "string" ? src : ""} alt={alt ?? ""} />
            ),
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
    </ImagePreviewGroup>
  );
}
