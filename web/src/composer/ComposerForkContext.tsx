import type { ConversationFork } from "../task-detail/conversationFork.ts";
import { useState } from "react";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import "./composerFork.css";

export function ComposerForkContext({ fork }: { fork: ConversationFork }) {
  const [expanded, setExpanded] = useState(false);
  return <details className="composer-fork-context">
    <summary>从「{fork.sourceTitle}」派生 · {fork.messageCount} 条历史消息</summary>
    <p>包含所选回复及之前的对话正文、已记录执行摘要和 {fork.attachmentPaths.length} 个附件；之后的消息不会带入。新任务使用独立会话，工作目录按任务选项设置，不回滚到历史代码版本。</p>
    <blockquote>{fork.replyPreview}</blockquote>
    <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>查看带入的完整对话正文</summary>
      {expanded && <MarkdownBody text={fork.context} />}
    </details>
  </details>;
}
