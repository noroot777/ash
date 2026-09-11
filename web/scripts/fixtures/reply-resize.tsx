// 对话框高度的夹具:跟着行数自动撑高、撑到上限就滚,拖动改高度、双击复位、上下限收住、
// 刷新后还在。结构与 task-detail/ReplyBox.tsx（?variant=team 时与 team/TeamView.tsx 的
// TeamReplyBox）保持同构 —— 高度只有 useAutoGrowTextarea 一个写者,拖动条只负责把
// pinned 递进去。两种变体各记各的高度,所以要分别验一遍。
// 跑法:npm -w web run test:reply-resize
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ReplyResizeHandle,
  SINGLE_REPLY_PIN,
  TEAM_REPLY_PIN,
  useReplyHeight,
} from "../../src/task-detail/ReplyResizeHandle.tsx";
import { useAutoGrowTextarea } from "../../src/lib/useAutoGrowTextarea.ts";
import "../../src/styles/global.css";

const team = new URLSearchParams(window.location.search).get("variant") === "team";

function Demo() {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const replyHeight = useReplyHeight(team ? TEAM_REPLY_PIN : SINGLE_REPLY_PIN);
  const [value, setValue] = useState("");
  useAutoGrowTextarea(textareaRef, { value, pinned: replyHeight.height });

  const field = (
    <textarea
      ref={textareaRef}
      rows={team ? 2 : 3}
      data-testid="field"
      value={value}
      onChange={(event) => setValue(event.target.value)}
    />
  );
  const state = <p data-testid="state">{replyHeight.height === null ? "auto" : String(replyHeight.height)}</p>;
  const handle = <ReplyResizeHandle targetRef={textareaRef} {...replyHeight} />;

  if (team) {
    return (
      <div className="team-reply-shell" style={{ width: 720 }}>
        <div className="team-reply-box">
          {handle}
          {field}
          <footer><span>调度台 · ⌘↵ 发送</span></footer>
        </div>
        {state}
      </div>
    );
  }
  return (
    <div className="task-reply-shell" style={{ width: 720 }}>
      <div className="task-reply-box">
        {handle}
        {field}
        <div className="task-reply-actions">
          <span>⌘↵ 发送</span>
        </div>
      </div>
      {state}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Demo />);
