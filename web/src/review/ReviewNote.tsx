// 派审时写的附言是**这一轮审查的输入**：它决定了审查者被要求重点看什么。所以它必须
// 出现在「读结论」的地方——报告抽屉正文之上、会话流审查卡正文之上——用户才能拿它对着
// 结论核对「我要的那一点他看了没有」。派审对话框里的那个 textarea 只是写入口，写完关掉
// 就再也翻不到，不算「看得到」。
export function ReviewNote({ text, label = "派审附言" }: { text: string; label?: string }) {
  const note = text.trim();
  if (!note) return null;
  return (
    <div className="review-note">
      <b>{label}</b>
      <p>{note}</p>
    </div>
  );
}
