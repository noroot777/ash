import type { UploadAttachment } from "./Attachments.tsx";
import { attachmentView } from "./utils.ts";
import { createClientId } from "../lib/clientId.ts";

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

/** 上一次「改了再发」放回的是哪一条（`source`），放完草稿是什么样（正文 + 附件那一份数组）。 */
export type ReuseMark = { source: string; text: string; attachments: UploadAttachment[] };

/**
 * 发过的一句放回草稿再改（气泡上「改了再发」）：跟撤回同样是合并，只多一条——**同一条**
 * 刚放回过、之后草稿正文和附件都没动，就是连点，原样返回不再放一遍。
 *
 * 判据是「哪一条 + 草稿版本」，不看草稿里有没有这几个字：放回「继续」时草稿写着「不要继续」，
 * 那是另一句意思相反的话，不是放回过的结果（第 1 轮审查实测，子串判断把它吞掉了）。附件按
 * 数组身份比：发送结算、增删附件都会换一份新数组，引用相同 ⇔ 放回之后没人碰过。
 */
export function reuseDraft(
  input: { source: string; text: string; paths: readonly string[] },
  current: { text: string; attachments: UploadAttachment[] },
  last: ReuseMark | null,
): ReuseMark {
  if (last && last.source === input.source && last.text === current.text && last.attachments === current.attachments) return last;
  return {
    source: input.source,
    text: joinDraftText(input.text, current.text),
    attachments: mergeAttachments(attachmentsFromPaths([...input.paths]), current.attachments),
  };
}

/**
 * 把消息里存的附件路径还原成对话框里的附件卡片。
 *
 * 服务端只记路径，字节数无从得知（`size` 因此留空，卡片不显示大小）；不在
 * `data/uploads/` 下的路径没有可访问 URL，只能当普通文件显示——但路径本身照样能
 * 跟着下一次发送原样送回去，这正是撤回要保住的东西。
 *
 * 每一份都带一个新的选择记号：放回就是又选了一次，在途那次发送摘不到它（见 dropSentAttachments）。
 */
export function attachmentsFromPaths(paths: string[]): UploadAttachment[] {
  const seen = new Set<string>();
  const restored: UploadAttachment[] = [];
  for (const raw of paths) {
    const path = raw.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const view = attachmentView(path);
    restored.push({ url: view.url, path, name: view.name, kind: view.image ? "image" : "file", selection: createClientId() });
  }
  return restored;
}

/**
 * 撤回的附件并回草稿：撤回的排前面，同一路径只留一份。草稿里已有的那份保留其大小等信息，
 * 但换上这一次的选择记号——用户刚又选了它，正在飞的那次发送结算时就不该把它当成自己的摘走。
 */
export function mergeAttachments(
  restored: UploadAttachment[],
  current: UploadAttachment[],
): UploadAttachment[] {
  const again = new Map(restored.map((attachment) => [attachment.path, attachment]));
  const currentPaths = new Set(current.map((attachment) => attachment.path));
  return [
    ...restored.filter((attachment) => !currentPaths.has(attachment.path)),
    ...current.map((attachment) => {
      const chosen = again.get(attachment.path);
      return chosen ? { ...attachment, selection: chosen.selection } : attachment;
    }),
  ];
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

/** 一次发送提交时带走的是哪几次选择：路径 + 选择记号。可以落进 localStorage（侧聊的发送请求）。 */
export type SentSelection = { path: string; selection?: string };

export function sentSelections(attachments: readonly UploadAttachment[]): SentSelection[] {
  return attachments.map(({ path, selection }) => (selection ? { path, selection } : { path }));
}

/**
 * 附件按**提交时的那几次选择**摘：路径和选择记号都对上才算「刚发出去的那一份」。
 *
 * 只认路径不够：发送在飞时用户又把同一张图放回草稿（撤回、「改了再发」），路径一模一样，
 * 旧发送一结算就把新放回的那张一起摘了（「改了再发」第 2 轮审查实测，迟到的远端确认同样如此）。
 * 选择记号是确定的身份，不用猜，在途期间新加进来、又选了一次的都原样留着。
 */
export function dropSentAttachments(
  current: UploadAttachment[],
  sent: readonly SentSelection[],
): UploadAttachment[] {
  const key = (attachment: SentSelection) => `${attachment.path}\u0000${attachment.selection ?? ""}`;
  const gone = new Set(sent.map(key));
  return current.filter((attachment) => !gone.has(key(attachment)));
}
