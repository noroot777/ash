import type { UploadAttachment } from "./Attachments.tsx";
import { attachmentView } from "./utils.ts";

/**
 * 对话框草稿的加减法：撤回一条待发送消息时怎么把内容放回去，发送成功后又该摘掉哪些。
 *
 * 撤回不等于清空重来：用户完全可能在消息排队期间又往输入框里写了新东西，所以这里
 * 一律做**合并**——撤回的内容排在前面（它是先写的），已有草稿原样留在后面，附件按
 * 路径去重。发送后的清理同理，是**减法**而不是清零：只摘掉这次真发出去的那份。
 * 纯函数放这里，托盘与两处对话框（普通任务 / 团队调度台）共用同一份语义。
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

/**
 * 一条消息发出去之后，从草稿里**只**摘掉发出去的那一段。
 *
 * 不能无条件清空：发送是异步的，请求在途的那一两秒里草稿可能已经变了——用户又打了
 * 几个字，或者撤回了另一条待发送消息把正文和附件并了回来。请求一回来就 `setValue("")`
 * 会连这些一起抹掉，而被撤回的那条消息在服务端已经取消，内容再也找不回来。
 *
 * 认不出发出去的那段（用户自己改过）时宁可原样留着：多一句待发的话，用户看得见也删得掉；
 * 少一段刚撤回来的内容，他连自己丢了什么都不知道。
 */
export function dropSentText(current: string, sent: string): string {
  if (!sent) return current;
  if (current.trim() === sent) return "";
  const index = current.lastIndexOf(sent);
  if (index < 0) return current;
  const before = current.slice(0, index).trimEnd();
  const after = current.slice(index + sent.length).trimStart();
  return before && after ? `${before}\n\n${after}` : before || after;
}

/** 同理，附件只摘掉这次真发出去的那几个路径，请求在途期间新加进来的留着。 */
export function dropSentAttachments(
  current: UploadAttachment[],
  sentPaths: string[],
): UploadAttachment[] {
  const sent = new Set(sentPaths);
  return current.filter((attachment) => !sent.has(attachment.path));
}
