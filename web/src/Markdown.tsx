import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Render agent/debate output as GitHub-flavored markdown, styled with the app's
// design tokens (no typography plugin). Used inside chat bubbles (§12).
export function Markdown({ text }: { text: string }) {
  return (
    <div className="text-[13px] leading-relaxed text-ink">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (p) => <h1 className="mb-1 mt-2 text-[15px] font-semibold first:mt-0" {...p} />,
          h2: (p) => <h2 className="mb-1 mt-2 text-[14px] font-semibold first:mt-0" {...p} />,
          h3: (p) => <h3 className="mb-1 mt-2 text-[13px] font-semibold first:mt-0" {...p} />,
          h4: (p) => <h4 className="mb-1 mt-2 text-[13px] font-medium first:mt-0" {...p} />,
          p: (p) => <p className="my-1.5 break-words first:mt-0 last:mb-0" {...p} />,
          ul: (p) => <ul className="my-1.5 list-disc pl-5" {...p} />,
          ol: (p) => <ol className="my-1.5 list-decimal pl-5" {...p} />,
          li: (p) => <li className="my-0.5 break-words" {...p} />,
          strong: (p) => <strong className="font-semibold text-ink" {...p} />,
          em: (p) => <em className="italic" {...p} />,
          a: ({ node: _n, ...p }) => (
            <a className="text-accent underline underline-offset-2 hover:text-accent-hover" target="_blank" rel="noreferrer" {...p} />
          ),
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
              <code className="rounded bg-overlay px-1 py-0.5 font-mono text-[12px]" {...p}>
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
          td: (p) => <td className="border border-line px-2 py-1 align-top" {...p} />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
