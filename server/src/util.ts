import { nanoid } from "nanoid";

export const id = () => nanoid(12);
export const now = () => new Date().toISOString();

// Agents read attachments off disk, not stdin. Append the absolute paths of any
// pasted images/files as a trailing block so the agent knows to Read them
// (Read renders images and reads files alike).
export const attachmentsPrompt = (attachments?: string[]): string =>
  attachments?.length
    ? `\n\n[用户附带的文件，请用 Read 工具查看以下本地文件]\n${attachments.map((p) => `- ${p}`).join("\n")}`
    : "";
