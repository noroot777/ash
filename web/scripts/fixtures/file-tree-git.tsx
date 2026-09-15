import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { FileTreeInspector } from "../../src/files/FileTreeInspector.tsx";
import "../../src/styles/global.css";

function Fixture() {
  const [taskId, setTaskId] = useState("tree-a");
  // 真实接线里「摊全文」和「摊 diff」是中间栏的同一块位置，文件树只认最终那个路径。
  const [opened, setOpened] = useState<{ kind: "file" | "diff"; path: string; source?: string } | null>(null);
  const [theme, setTheme] = useState("light");

  const chooseTheme = (next: "light" | "dark") => {
    document.documentElement.dataset.fixtureTheme = next;
    setTheme(next);
  };

  return (
    <main style={{ display: "grid", minHeight: "100%", placeItems: "center", padding: 28 }}>
      <section style={{ width: 390 }}>
        <header style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <button type="button" data-testid="task-a" onClick={() => { setTaskId("tree-a"); setOpened(null); }}>
            任务 A
          </button>
          <button type="button" data-testid="task-b" onClick={() => { setTaskId("tree-b"); setOpened(null); }}>
            任务 B
          </button>
          <button type="button" data-testid="theme-light" onClick={() => chooseTheme("light")}>浅色</button>
          <button type="button" data-testid="theme-dark" onClick={() => chooseTheme("dark")}>深色</button>
          <output data-testid="fixture-state" style={{ marginLeft: "auto", color: "var(--faint)", fontSize: 10 }}>
            {taskId} · {theme}
          </output>
        </header>
        <div
          data-testid="file-tree-host"
          style={{ height: 570, overflow: "hidden", border: "1px solid var(--line2)", borderRadius: 10, background: "var(--panel)" }}
        >
          <FileTreeInspector
            taskId={taskId}
            activePath={opened?.path ?? null}
            onOpenFile={(path) => setOpened({ kind: "file", path })}
            onOpenDiff={(target) => setOpened({ kind: "diff", path: target.path, source: target.source })}
          />
        </div>
        <output data-testid="active-path" style={{ display: "block", minHeight: 20, marginTop: 8, color: "var(--faint)", fontFamily: "var(--font-mono)", fontSize: 10 }}>
          {opened?.path ?? "未选择文件"}
        </output>
        <output data-testid="opened-as" style={{ display: "block", minHeight: 20, color: "var(--faint)", fontFamily: "var(--font-mono)", fontSize: 10 }}>
          {opened ? `${opened.kind}${opened.source ? `:${opened.source}` : ""}` : "无"}
        </output>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
