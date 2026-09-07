// 收敛门里人说的那一句的**成稿**：讨论者收到的 prompt 和时间线上的气泡是同一份文本，
// 所以拼装只此一处——两边分别拼，界面上迟早会出现「用户明明发了图，气泡里却没有」。
//
// 只贴一张图不打字也算数（截图往往就是全部要说的话），所以空文本要有兜底句：
// 没有它，prompt 末尾只剩一串本地路径，讨论者不知道要拿这些文件干什么。
import { attachmentsPrompt } from "../util.js";

export function gateUserMessage(text: string, attachments?: string[]): string {
  const said = text.trim();
  const body = said || (attachments?.length ? "请看我附上的文件/截图。" : "");
  return body + attachmentsPrompt(attachments);
}

// 议题的成稿，跟上面那句同一套规矩（同一个兜底句、同一段附件块）。
//
// 为什么议题得自己拼一遍：附件是追加在 `task.body` 末尾的一段文本，而**直接创建**的
// 讨论只读 `duet.topic`、不读 body（duet/index.ts `loadBase`：只有派生讨论才把 body
// 顶替成议题）。少了这一句，用户在新建面板贴的图就静默留在 body 里，两位讨论者的开场
// prompt 里根本没有它——传了等于没传。
export function duetTopicText(topic: string, attachments?: string[]): string {
  return gateUserMessage(topic, attachments);
}
