// 附件块的**读端**。写端是 server/src/util.ts 的 `attachmentsPrompt()`：它把用户挑的
// 文件拼成一段固定格式的纯文本塞进 prompt（agent 只认文本，没有别的通道）。读端要把这段
// 文本从正文里摘回来，才能在界面上重新变成缩略图。
//
// 两端必须逐字对得上，所以读端住在 shared —— server（侧边栏铺开时的「最后一条消息」）和
// web-next（会话气泡、悬浮全文卡片）用的是同一份，不会各自漂。
const ATTACHMENT_HEADER = /^\s*\[用户附带的文件[^\]]*\]\s*$/;
const ATTACHMENT_PATH = /^\s*-\s+(.+?)\s*$/;

export function parseAttachmentText(text: string): { body: string; paths: string[] } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const body: string[] = [];
  const paths: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!ATTACHMENT_HEADER.test(lines[index] ?? "")) {
      body.push(lines[index] ?? "");
      continue;
    }
    let cursor = index + 1;
    while (cursor < lines.length && !(lines[cursor] ?? "").trim()) cursor += 1;
    const block: string[] = [];
    while (cursor < lines.length) {
      const match = ATTACHMENT_PATH.exec(lines[cursor] ?? "");
      if (!match) break;
      block.push(match[1]!);
      cursor += 1;
    }
    if (!block.length) {
      body.push(lines[index] ?? "");
      continue;
    }
    paths.push(...block);
    index = cursor - 1;
  }
  return { body: body.join("\n").trim(), paths };
}
