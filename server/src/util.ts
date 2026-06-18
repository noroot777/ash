import { nanoid } from "nanoid";

export const id = () => nanoid(12);
export const now = () => new Date().toISOString();

// Agents read images off disk, not stdin. Append the absolute paths of any
// pasted images as a trailing block so the agent knows to Read them.
export const imagesPrompt = (images?: string[]): string =>
  images?.length ? `\n\n[用户附带的图片，请用 Read 工具查看以下本地文件]\n${images.map((p) => `- ${p}`).join("\n")}` : "";
