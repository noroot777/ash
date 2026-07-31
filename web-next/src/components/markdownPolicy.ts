import { api } from "../lib/api.ts";

const REVIEW_FILE_PATH = /\/data\/runs\/([\w-]+)\/review\/round-(\d+)\/([^/]+)$/;

export type ReviewFileTarget = {
  name: string;
  url: string;
};

export function reviewFileTarget(path?: string): ReviewFileTarget | null {
  if (!path) return null;
  const match = path.match(REVIEW_FILE_PATH);
  if (!match) return null;
  const [, taskId, round, encodedName] = match;
  let name = encodedName;
  try {
    name = decodeURIComponent(encodedName);
  } catch {
    // Keep malformed escapes unchanged; the server remains the authority for
    // allowed review filenames and path safety.
  }
  return { name, url: api.taskReviewFileUrl(taskId, Number(round), name) };
}

export function isLocalOpenHref(href?: string): href is string {
  if (!href) return false;
  try {
    return new URL(href, window.location.origin).pathname === "/api/open-local";
  } catch {
    return false;
  }
}

export function currentOriginOpenLocalUrl(href: string): string {
  const source = new URL(href, window.location.origin);
  const target = new URL("/api/open-local", window.location.origin);
  target.search = source.search;
  return target.toString();
}

export async function openLocalPath(href: string): Promise<void> {
  const response = await fetch(currentOriginOpenLocalUrl(href));
  if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`);
}

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
};

function hardenSoftBreaks(node: MarkdownNode): void {
  if (!node.children) return;
  const children: MarkdownNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && child.value?.includes("\n")) {
      child.value.split("\n").forEach((part, index) => {
        if (index) children.push({ type: "break" });
        if (part) children.push({ type: "text", value: part });
      });
      continue;
    }
    hardenSoftBreaks(child);
    children.push(child);
  }
  node.children = children;
}

// Conversation-like Markdown treats a single authored newline as visible.
// Code and inlineCode nodes have no children, so their content stays untouched.
export const remarkSoftBreaks = () => hardenSoftBreaks;
