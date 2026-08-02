import { PreviewableImageLink } from "../components/ImagePreview.tsx";
import { attachmentView, parseAttachmentText } from "./utils.ts";

export function InspectorPromptContent({
  text,
  attachments = [],
  emptyText,
}: {
  text: string;
  attachments?: string[];
  emptyText: string;
}) {
  const parsed = parseAttachmentText(text);
  const paths = [...new Set([...parsed.paths, ...attachments].map((path) => path.trim()).filter(Boolean))];
  const body = parsed.body || (!paths.length ? emptyText : "");

  return (
    <>
      {body && <pre>{body}</pre>}
      {paths.length > 0 && (
        <div className="task-inspector-attachment-links">
          <span>附件</span>
          {paths.map((path) => {
            const view = attachmentView(path);
            if (view.image && view.url) {
              return (
                <PreviewableImageLink
                  className="task-inspector-attachment-link"
                  src={view.url}
                  href={view.url}
                  alt={view.name}
                  label={view.name}
                  key={path}
                >
                  {view.name}
                </PreviewableImageLink>
              );
            }
            if (view.url) {
              return (
                <a className="task-inspector-attachment-link" href={view.url} target="_blank" rel="noreferrer" key={path}>
                  {view.name}
                </a>
              );
            }
            return <span className="task-inspector-attachment-missing" key={path}>{view.name}</span>;
          })}
        </div>
      )}
    </>
  );
}
