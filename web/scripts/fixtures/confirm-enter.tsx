import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConfirmDialog } from "../../src/task-detail/ConfirmDialog.tsx";
import "../../src/styles/global.css";

// 确认框「回车 = 确认」的台子。各种 children 形态各摆一个：空的、带多行输入的、带单行
// 输入的、按钮不可按的，外加一个「框里再开一框」用来看回车归不归最上面那层。

type Kind = "plain" | "textarea" | "input" | "disabled";

function Fixture() {
  const [open, setOpen] = useState<Kind | null>(null);
  const [inner, setInner] = useState(false);
  const [text, setText] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const note = (entry: string) => setLog((prev) => [...prev, entry]);

  const close = () => { setInner(false); setOpen(null); };

  return <main>
    <p data-testid="log">{log.join(",")}</p>
    <button type="button" data-testid="reset" onClick={() => { setLog([]); close(); }}>清空</button>
    {(["plain", "textarea", "input", "disabled"] as Kind[]).map((kind) => (
      <button key={kind} type="button" data-testid={`open-${kind}`} onClick={() => setOpen(kind)}>打开 {kind}</button>
    ))}

    {open === "plain" && <ConfirmDialog
      title="确认验收通过？" message="任务分支将合并回 main。" confirmLabel="验收通过" danger
      onConfirm={() => { note("confirm:plain"); close(); }} onClose={() => { note("close:plain"); close(); }}
    >
      <button type="button" data-testid="open-inner" onClick={() => setInner(true)}>再开一层</button>
      {inner && <ConfirmDialog
        title="里层" message="里层的确认。" confirmLabel="里层确认"
        onConfirm={() => { note("confirm:inner"); setInner(false); }} onClose={() => { note("close:inner"); setInner(false); }}
      />}
    </ConfirmDialog>}

    {open === "textarea" && <ConfirmDialog
      title="打回继续修改？" message="意见会作为真人回复送回去。" confirmLabel="打回修改"
      onConfirm={() => { note(`confirm:textarea(${JSON.stringify(text)})`); close(); }} onClose={() => { note("close:textarea"); close(); }}
    >
      <textarea data-testid="feedback" autoFocus rows={3} value={text} onChange={(event) => setText(event.target.value)} />
    </ConfirmDialog>}

    {open === "input" && <ConfirmDialog
      title="新建分组" message="并行组会同时启动成员。" confirmLabel="创建分组"
      onConfirm={() => { note("confirm:input"); close(); }} onClose={() => { note("close:input"); close(); }}
    >
      <label><span>分组名称</span><input data-testid="name" autoFocus /></label>
    </ConfirmDialog>}

    {open === "disabled" && <ConfirmDialog
      title="确认验收通过？" message="还在检查验收依赖。" confirmLabel="验收通过" confirmDisabled
      onConfirm={() => { note("confirm:disabled"); close(); }} onClose={() => { note("close:disabled"); close(); }}
    />}
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
