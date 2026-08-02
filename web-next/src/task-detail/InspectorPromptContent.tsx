import { MessageAttachments } from "./Attachments.tsx";
import { parseAttachmentText } from "./utils.ts";

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
  const paths = [...parsed.paths, ...attachments];
  const body = parsed.body || (!paths.length ? emptyText : "");

  return (
    <>
      {body && <pre>{body}</pre>}
      <MessageAttachments paths={paths} imagesAsLinks />
    </>
  );
}
