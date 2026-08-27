import type { UploadAttachment } from "./Attachments.tsx";
import { attachmentView } from "./utils.ts";

/**
 * 撤回一条待发送消息时，怎么把它的内容放回对话框。
 *
 * 撤回不等于清空重来：用户完全可能在消息排队期间又往输入框里写了新东西，所以这里
 * 一律做**合并**——撤回的内容排在前面（它是先写的），已有草稿原样留在后面，附件按
 * 路径去重。纯函数放这里，托盘与两处对话框（普通任务 / 团队调度台）共用同一份语义。
 */

/** 撤回的正文接回草稿：两边都有内容时空一行隔开，谁为空就用另一边。 */
export function joinDraftText(restored: string, current: string): string {
  const left = restored.trim();
  if (!left) return current;
  if (!current.trim()) return left;
  return `${left}\n\n${current}`;
}

/**
 * 把消息里存的附件路径还原成对话框里的附件卡片。
 *
 * 服务端只记路径，字节数无从得知（`size` 因此留空，卡片不显示大小）；不在
 * `data/uploads/` 下的路径没有可访问 URL，只能当普通文件显示——但路径本身照样能
 * 跟着下一次发送原样送回去，这正是撤回要保住的东西。
 */
export function attachmentsFromPaths(paths: string[]): UploadAttachment[] {
  const seen = new Set<string>();
  const restored: UploadAttachment[] = [];
  for (const raw of paths) {
    const path = raw.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const view = attachmentView(path);
    restored.push({ url: view.url, path, name: view.name, kind: view.image ? "image" : "file" });
  }
  return restored;
}

/** 撤回的附件并回草稿：撤回的排前面，同一路径只留一份（草稿里那份优先保留其大小等信息）。 */
export function mergeAttachments(
  restored: UploadAttachment[],
  current: UploadAttachment[],
): UploadAttachment[] {
  const currentPaths = new Set(current.map((attachment) => attachment.path));
  return [...restored.filter((attachment) => !currentPaths.has(attachment.path)), ...current];
}
