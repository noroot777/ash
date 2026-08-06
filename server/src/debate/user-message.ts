// 收敛门里人说的那一句的**成稿**：辩手收到的 prompt 和时间线上的气泡是同一份文本，
// 所以拼装只此一处——两边分别拼，界面上迟早会出现「用户明明发了图，气泡里却没有」。
//
// 只贴一张图不打字也算数（截图往往就是全部要说的话），所以空文本要有兜底句：
// 没有它，prompt 末尾只剩一串本地路径，辩手不知道要拿这些文件干什么。
import { attachmentsPrompt } from "../util.js";

export function gateUserMessage(text: string, attachments?: string[]): string {
  const said = text.trim();
  const body = said || (attachments?.length ? "请看我附上的文件/截图。" : "");
  return body + attachmentsPrompt(attachments);
}
