// 公共下拉关掉之后再开，焦点要再交给浮层 / 筛选框（第 1 轮审查 F3）。
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Select } from "../../src/components/Select.tsx";
import "../../src/styles/global.css";

const scopes = [
  { value: "all", label: "前后端都启动" },
  { value: "web", label: "只启动前端" },
  { value: "server", label: "只启动后端" },
];
const many = Array.from({ length: 12 }, (_, index) => ({ value: `m${index}`, label: `模型 ${index}` }));

function Shell() {
  const [scope, setScope] = useState("web");
  const [model, setModel] = useState("m0");
  return (
    <main style={{ display: "grid", gap: 24, width: 320, padding: 24 }}>
      <div data-case="plain"><Select label="预览启动范围" value={scope} options={scopes} onChange={setScope} /></div>
      <div data-case="filter"><Select label="模型" value={model} options={many} filterable onChange={setModel} /></div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Shell /></StrictMode>);
