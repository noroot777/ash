// 对话框执行器水印的夹具:字号由框的宽高一起定,换智能体时字要跟着换。
// 跑法:npm -w web run test:agent-plate
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentPlate } from "../../src/components/AgentPlate.tsx";
import "@fontsource-variable/inter";
// 夹具不走 main.tsx,斜体字形要自己引,否则量到的是浏览器合成的假斜体
import "@fontsource-variable/inter/wght-italic.css";
import "../../src/styles/global.css";

function Demo() {
  const [agent, setAgent] = useState("claude");
  const [height, setHeight] = useState(96);

  return (
    <div className="task-reply-shell" style={{ width: 720, padding: 16 }}>
      <div className="task-reply-box" style={{ height }}>
        <AgentPlate name={agent} />
        <textarea
          data-testid="field"
          style={{ height: height - 38 }}
          defaultValue="把 ReplyBox 的执行器水印做进底部，跟着框高缩放。"
        />
        {/* 真实 ReplyBox 里只有提示文案是直接 span（.task-reply-actions > span 会被推到最右），
            其余控件都是按钮/组件，这里照此用 div 摆位。 */}
        <div className="task-reply-actions">
          <div>📎</div>
          <div>🕐</div>
          <div style={{ border: "1px solid var(--line2)", borderRadius: 999, padding: "2px 8px" }}>
            {agent} · 跟随执行器
          </div>
          <span data-testid="hint">⌘↵ 发送</span>
        </div>
      </div>

      <button data-testid="to-codex" type="button" onClick={() => setAgent("codex")}>
        codex
      </button>
      <button data-testid="to-antigravity" type="button" onClick={() => setAgent("antigravity")}>
        antigravity
      </button>
      <button data-testid="grow" type="button" onClick={() => setHeight(230)}>
        变高
      </button>
      <button data-testid="shrink" type="button" onClick={() => setHeight(96)}>
        变矮
      </button>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Demo />);
