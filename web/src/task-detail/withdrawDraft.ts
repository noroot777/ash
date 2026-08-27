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
 * 一条消息发出去之后，草稿该不该清。
 *
 * 判据只有一条：**当前草稿逐字还是发送时的那一份吗**。是就清掉（常态：点了发送就没再
 * 碰输入框）；只要动过一个字符，就整份留着，一个字都不删。
 *
 * 为什么不去草稿里找「发出去的那一段」再摘掉：字符串里没有版本，也没有编辑来源。
 * 发送时草稿是「方案」，用户在途中全选重写成「新方案细节」，任何形式的子串搜索都会
 * 把中间那两个字当成旧的那一份删掉，把用户刚写的句子改成「新细节」——静默、且他根本
 * 不知道自己丢了什么（2026-08-27 审查实测）。搜不到就留着还不够，**搜得到也可能是错的**，
 * 所以这里干脆不搜。
 *
 * 那「发送在途时撤回另一条消息」怎么办？靠顺序而不是靠猜：撤回等这一次发送结算完再
 * 回填（见 ReplyBox / TeamView 的 withdraw），清空发生在合并之前，两边都不用推断。
 */
export function clearSentDraft(current: string, draftAtSend: string): string {
  return current === draftAtSend ? "" : current;
}

/**
 * 附件按路径摘：路径是附件的唯一标识，「这一个是不是刚发出去的那一个」有确定答案，
 * 不像正文那样要猜——所以这里可以精确减，在途期间新加进来的原样留着。
 */
export function dropSentAttachments(
  current: UploadAttachment[],
  sentPaths: string[],
): UploadAttachment[] {
  const sent = new Set(sentPaths);
  return current.filter((attachment) => !sent.has(attachment.path));
}
