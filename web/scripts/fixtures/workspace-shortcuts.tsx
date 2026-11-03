import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { registerInspectorSectionOwner } from "../../src/inspector/sections.ts";
import { registerInspectorShortcutTarget } from "../../src/inspector/shortcuts.ts";
import { FOLLOW_UPS_SECTION_ID } from "../../src/task-detail/followUpsSection.ts";
import { useWorkspaceShortcuts } from "../../src/workspace/useWorkspaceShortcuts.ts";

// 全局快捷键只有在**真的按下键**时才算数：序列的时序在 test-key-chord 里已经钉住，
// 这里钉的是它挂到 window 捕获阶段之后的那一半 —— 谁先吃到 t、输入框里按键还算不算数、
// 两条序列交叉连打会不会串味。
function Ash() {
  const [log, setLog] = useState<string[]>([]);
  const [scope, setScope] = useState<"project" | "tasks">("project");
  // 聊天 / 助手 / 设置页把列表导航键关掉（enabled=false），但 `G …` 一族在那儿照样按得到。
  const [enabled, setEnabled] = useState(true);

  useEffect(() => registerInspectorShortcutTarget((key) => {
    setLog((current) => [...current, `inspector:${key}`]);
    return true;
  }), []);

  // 有没有一份 Inspector 认得「后续追问」那一节：团队页、新建面板上没有，Q 得原样放过。
  const [hasSection, setHasSection] = useState(true);
  const sectionAbsent = useRef(false);
  sectionAbsent.current = !hasSection;
  useEffect(() => hasSection ? registerInspectorSectionOwner({
    has: (id) => id === FOLLOW_UPS_SECTION_ID,
    open: (id) => setLog((current) => [...current, `section:${id}`]),
  }) : undefined, [hasSection]);
  // 「放过」看得见的那一半：冒泡到 window 时没被 preventDefault。只在没有那一节时记，免得
  // 列表导航关掉那段的「一颗都不能响」被它搅了。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "q" && !event.defaultPrevented && sectionAbsent.current) {
        setLog((current) => [...current, "q-passed-through"]);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useWorkspaceShortcuts({
    enabled,
    paletteOpen: false,
    composerOpen: false,
    spreadOpen: false,
    // 这里只钉「哪颗键算一次」—— J/K 落到哪一行归 sidebarNavigation，由
    // test-sidebar-navigation 拿真列表钉住。
    onNavigate: (step) => setLog((current) => [...current, step > 0 ? "next" : "previous"]),
    onTogglePalette: () => setLog((current) => [...current, "palette"]),
    onCreate: () => setLog((current) => [...current, "create"]),
    onToggleSpread: () => setLog((current) => [...current, "spread"]),
    onCloseSpread: () => {},
    onToggleTaskMode: () => {
      setLog((current) => [...current, "task-mode"]);
      setScope((current) => current === "tasks" ? "project" : "tasks");
    },
    onOpenSettings: () => setLog((current) => [...current, "settings"]),
    onToggleCommands: () => setLog((current) => [...current, "commands"]),
    onToggleTerminal: () => setLog((current) => [...current, "terminal"]),
  });

  return (
    <main>
      <p data-testid="scope">{scope}</p>
      <p data-testid="log">{log.join(" ")}</p>
      <p data-testid="enabled">{enabled ? "on" : "off"}</p>
      <button type="button" data-testid="toggle-enabled" onClick={() => setEnabled((current) => !current)}>切换列表导航</button>
      <button type="button" data-testid="toggle-section" onClick={() => setHasSection((current) => !current)}>切换后续追问那一节</button>
      <input data-testid="text-entry" aria-label="文本输入" />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Ash />
  </StrictMode>,
);
