import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { TaskListItem } from "@ash/shared";
import { registerInspectorShortcutTarget } from "../../src/inspector/shortcuts.ts";
import { useWorkspaceShortcuts } from "../../src/workspace/useWorkspaceShortcuts.ts";

// 全局快捷键只有在**真的按下键**时才算数：序列的时序在 test-key-chord 里已经钉住，
// 这里钉的是它挂到 window 捕获阶段之后的那一半 —— 谁先吃到 t、输入框里按键还算不算数、
// 两条序列交叉连打会不会串味。
function Ash() {
  const [log, setLog] = useState<string[]>([]);
  const [scope, setScope] = useState<"project" | "tasks">("project");
  const orderedTasks = useMemo<TaskListItem[]>(() => [], []);

  useEffect(() => registerInspectorShortcutTarget((key) => {
    setLog((current) => [...current, `inspector:${key}`]);
    return true;
  }), []);

  useWorkspaceShortcuts({
    enabled: true,
    paletteOpen: false,
    composerOpen: false,
    spreadOpen: false,
    orderedTasks,
    selectedTaskId: null,
    onTogglePalette: () => setLog((current) => [...current, "palette"]),
    onCreate: () => setLog((current) => [...current, "create"]),
    onTask: () => {},
    onToggleSpread: () => setLog((current) => [...current, "spread"]),
    onCloseSpread: () => {},
    onToggleTaskMode: () => {
      setLog((current) => [...current, "task-mode"]);
      setScope((current) => current === "tasks" ? "project" : "tasks");
    },
  });

  return (
    <main>
      <p data-testid="scope">{scope}</p>
      <p data-testid="log">{log.join(" ")}</p>
      <input data-testid="text-entry" aria-label="文本输入" />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Ash />
  </StrictMode>,
);
