// 对话框顶边拖动条的夹具:拖动改高度、双击复位、上下限收住、刷新后还在。
// 跑法:npm -w web run test:reply-resize
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ReplyResizeHandle,
  readStoredReplyHeight,
  storeReplyHeight,
} from "../../src/task-detail/ReplyResizeHandle.tsx";
import "../../src/styles/global.css";

function Demo() {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [height, setHeight] = useState<number | null>(readStoredReplyHeight);

  return (
    <div className="task-reply-shell" style={{ width: 720 }}>
      <ReplyResizeHandle
        targetRef={textareaRef}
        height={height}
        onChange={(next) => {
          setHeight(next);
          storeReplyHeight(next);
        }}
      />
      <div className="task-reply-box">
        <textarea
          ref={textareaRef}
          rows={3}
          data-testid="field"
          style={height === null ? undefined : { height }}
          defaultValue=""
        />
        <div className="task-reply-actions">
          <span>⌘↵ 发送</span>
        </div>
      </div>
      <p data-testid="state">{height === null ? "auto" : String(height)}</p>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Demo />);
