// 对话框高度的夹具:跟着行数自动撑高、撑到上限就滚,拖动改高度、双击复位、上下限收住、
// 刷新后还在。结构与 task-detail/ReplyBox.tsx 保持同构 —— 高度只有 useAutoGrowTextarea
// 一个写者,拖动条只负责把 pinned 递进去。
// 跑法:npm -w web run test:reply-resize
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ReplyResizeHandle,
  readStoredReplyHeight,
  storeReplyHeight,
} from "../../src/task-detail/ReplyResizeHandle.tsx";
import { useAutoGrowTextarea } from "../../src/lib/useAutoGrowTextarea.ts";
import "../../src/styles/global.css";

function Demo() {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [height, setHeight] = useState<number | null>(readStoredReplyHeight);
  const [value, setValue] = useState("");
  useAutoGrowTextarea(textareaRef, { value, pinned: height });

  return (
    <div className="task-reply-shell" style={{ width: 720 }}>
      <div className="task-reply-box">
        <ReplyResizeHandle
          targetRef={textareaRef}
          height={height}
          onChange={(next) => {
            setHeight(next);
            storeReplyHeight(next);
          }}
        />
        <textarea
          ref={textareaRef}
          rows={3}
          data-testid="field"
          value={value}
          onChange={(event) => setValue(event.target.value)}
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
