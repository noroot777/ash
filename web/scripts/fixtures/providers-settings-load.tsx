// 供应商设置页**整页**的读取编排夹具:两份远端数据(供应商本身 / 执行器挂载情况)
// 各自成败。挂的是真组件,接口由测试用 page.route 注入成功与失败。
//
// 上一版把两者捆成一次 Promise.all,`/agents` 一个 503 就把读到的供应商一起丢掉、
// 页面显示「还没有供应商」—— 而那种故障只有把 ProvidersSettings 本身挂起来才看得见,
// 光测 ProvidersSection 抓不到(审查第 1 轮)。
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ProvidersSettings } from "../../src/settings/ProvidersSettings.tsx";
import "../../src/styles/global.css";

function Fixture() {
  const [notices, setNotices] = useState<string[]>([]);
  const [sections, setSections] = useState<string[]>([]);
  return (
    <main className="settings-main" style={{ width: "min(880px, calc(100% - 32px))", margin: "24px auto" }}>
      <ProvidersSettings
        notify={(message) => setNotices((current) => [...current, message])}
        onOpen={(section) => setSections((current) => [...current, section])}
      />
      <pre data-testid="notices">{JSON.stringify(notices)}</pre>
      <pre data-testid="sections">{JSON.stringify(sections)}</pre>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
