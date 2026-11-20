import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ActionMenuItem } from "../../src/components/ActionMenuItem.tsx";
import { HoverTip, useHoverTip, type HoverTipPlacement } from "../../src/components/HoverTip.tsx";
import "../../src/styles/global.css";

const reason = "子任务「claude 起跑时别再把 Navi MCP 以旧名 ash 再加载一份：" + "long-task-name-".repeat(18)
  + "」有哨兵在运行，停止或结束后再归档";

function Edge({ placement }: { placement: HoverTipPlacement }) {
  const tip = useHoverTip({ placement });
  return <>
    <button {...tip.anchorProps} style={{ position: "fixed", left: 8 + ["below", "above", "left"].indexOf(placement) * 78, bottom: 8 }}>{placement}</button>
    <HoverTip at={tip.at}>{reason}</HoverTip>
  </>;
}

function Board() {
  const [selected, setSelected] = useState(0);
  return <main data-selected={selected}>
    <div className="task-overflow" style={{ position: "fixed", right: 16, top: 16 }}>
      <div className="task-overflow-menu" role="menu" style={{ top: 0 }}>
        <button role="menuitem">刷新</button>
        <button role="menuitem">查看改动与审查</button>
        <button role="menuitem">复制全部对话</button>
        <button role="menuitem">下载 Markdown</button>
        <span role="separator" />
        <ActionMenuItem verdict={{ ok: false, reason }} onSelect={() => setSelected((value) => value + 1)}>归档任务</ActionMenuItem>
        <button role="menuitem" className="is-danger">删除任务</button>
      </div>
    </div>
    {(["below", "above", "left"] as const).map((placement) => <Edge key={placement} placement={placement} />)}
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Board /></StrictMode>);
